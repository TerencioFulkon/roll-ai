import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "ffprobe-static";
import { supabase } from "../supabase.js";
import { config } from "../config/index.js";
import { downloadFile, getSignedUrl, uploadFile } from "../providers/r2.js";
import { analyseFrames, scoreAnalysisQuality } from "../providers/openai.js";
import { SERVICE_UNAVAILABLE_MESSAGE } from "../lib/errorMessages.js";
import { finalizeRollDisplayTitle } from "../lib/rollTitle.js";
import {
  createTtsUsageTracker,
  DEFAULT_VOICE_KEY,
  generateSpeech,
  getTtsVoiceDebugInfo,
  normalizeVoiceKey
} from "../services/ttsService.js";

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath.path);

/** Cap `amix` inputs in one graph — many streams + adelay is a common SIGSEGV trigger (ffmpeg-static / macOS). */
const DEFAULT_MAX_AMIX_SEGMENTS = 8;

function getMaxAmixSegments() {
  const raw = process.env.ROLLAI_MAX_AMIX_SEGMENTS;
  if (raw === undefined || raw === "") return DEFAULT_MAX_AMIX_SEGMENTS;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_AMIX_SEGMENTS;
  return Math.min(n, 32);
}

/**
 * Logs the full FFmpeg CLI on start; accumulates stderr for failure logs.
 * @param {string} jobId
 * @param {string} label
 * @param {import("fluent-ffmpeg").FfmpegCommand} command
 * @returns {() => string} Call after error/end to read stderr blob.
 */
function attachFfmpegDiagnostics(jobId, label, command) {
  /** @type {string[]} */
  const stderrLines = [];
  command
    .on("start", (cmdLine) => {
      console.log(`[job ${jobId}] FFmpeg [${label}] command:\n${cmdLine}`);
    })
    .on("stderr", (line) => {
      stderrLines.push(line);
      if (process.env.ROLLAI_FFMPEG_VERBOSE === "1") {
        console.warn(`[job ${jobId}] FFmpeg [${label}] stderr`, line.trimEnd());
      }
    });

  return () => stderrLines.join("").trim();
}

function assertReadableFile(jobId, absPath, role) {
  if (!existsSync(absPath)) {
    throw new Error(`[job ${jobId}] FFmpeg ${role} not found or not readable: ${absPath}`);
  }
}

/** Pass 2 estimate: 35 words × 0.4 s/word = 14 s worst-case clip; + 2 s gap between starts. */
const PASS2_WORDS_MAX = 35;
const PASS2_SECONDS_PER_WORD = 0.4;
const PASS2_SAFE_GAP_SECONDS = 2;
const PASS3_GAP_SECONDS = 2;
const PASS2_END_BUFFER_SECONDS = 15;

export async function processVideo(job) {
  const jobId = job.sqlid;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `video-job-${jobId}-`));
  const inputVideoPath = path.join(tempDir, "input.mp4");
  const framesDir = path.join(tempDir, "frames");
  const audioDir = path.join(tempDir, "audio");
  const outputPath = path.join(tempDir, "output.mp4");

  console.log(`[job ${jobId}] temp workspace (fresh dir, no reused mp3): ${tempDir}`);

  try {
    await updateJob(jobId, {
      status: "processing",
      started_at: new Date().toISOString(),
      progress: "Downloading source video"
    });

    await fs.mkdir(framesDir, { recursive: true });
    await fs.mkdir(audioDir, { recursive: true });
    await downloadInputVideo(jobId, job.input_url, inputVideoPath);

    // Re-encode to a guaranteed-safe H.264/AAC MP4 before any processing.
    // Prevents SIGSEGV from ffmpeg-static when handling iPhone HEVC/MOV files.
    await updateJob(jobId, { progress: "Preparing video" });
    const safeInputPath = path.join(tempDir, "input_safe.mp4");
    await transcodeToSafeH264(jobId, inputVideoPath, safeInputPath);
    await fs.rm(inputVideoPath, { force: true });

    await updateJob(jobId, {
      progress: "Extracting frames"
    });

    const frames = await extractFrames(jobId, safeInputPath, framesDir);

    await updateJob(jobId, {
      status: "generating_audio",
      progress: "Analyzing frames"
    });

    let profilePhotoBase64 = null;
    let profilePhotoMimeType = null;
    if (job.metadata?.profile_photo_url) {
      try {
        const photoBuf = await downloadFile(job.metadata.profile_photo_url);
        profilePhotoBase64 = photoBuf.toString("base64");
        profilePhotoMimeType = job.metadata.profile_photo_mime_type || "image/jpeg";
      } catch (photoErr) {
        console.error("Could not download profile photo from R2, continuing without it:", photoErr.message);
      }
    }

    const participantDescription =
      job.metadata?.participant_description || job.metadata?.participant_descriptor || "";

    const videoDurationSeconds = await getVideoDurationSeconds(safeInputPath);
    const estimatedClipDuration = PASS2_WORDS_MAX * PASS2_SECONDS_PER_WORD;
    const safeGap = PASS2_SAFE_GAP_SECONDS;
    const minStartSpacingSeconds = estimatedClipDuration + safeGap;
    const maxSegments = Math.floor(videoDurationSeconds / (estimatedClipDuration + safeGap));

    console.log(
      `[job ${jobId}] Pass 2 timing inputs: videoDurationSeconds=${videoDurationSeconds}, estimatedClipDuration=${estimatedClipDuration}, safeGap=${safeGap}, minStartSpacingSeconds=${minStartSpacingSeconds}, maxSegments=${maxSegments}`
    );

    const analysisResult = await analyseFrames(frames, {
      participantDescription,
      videoDurationSeconds,
      maxSegments,
      estimatedClipDuration,
      safeGap,
      minStartSpacingSeconds,
      endBufferSeconds: PASS2_END_BUFFER_SECONDS
    });

    console.log(
      `[job ${jobId}] analyseFrames returned:`,
      JSON.stringify({
        hasUsage: Boolean(analysisResult?.usage),
        segmentCount: analysisResult?.segments?.length ?? 0
      })
    );

    const narrationSegments = analysisResult?.segments ?? [];
    const passOneAnalysis = analysisResult?.passOneAnalysis ?? null;

    const passMeta =
      typeof job.metadata === "object" && job.metadata !== null ? { ...job.metadata } : {};
    const rollDisplayTitle = finalizeRollDisplayTitle(passOneAnalysis, passMeta.file_name);
    passMeta.roll_display_title = rollDisplayTitle;
    await updateJob(jobId, { metadata: passMeta });
    job.metadata = passMeta;

    const llmUsage = analysisResult?.usage ?? {
      pass1PromptTokens: 0,
      pass1CompletionTokens: 0,
      pass1CostUsd: 0,
      pass2PromptTokens: 0,
      pass2CompletionTokens: 0,
      pass2CostUsd: 0
    };

    console.log(
      `[job ${jobId}] Pass 2 raw timestamps:`,
      narrationSegments.map((s) => ({ timestamp: s.timestamp, text: s.text?.slice(0, 40) }))
    );

    const voiceKey = job.metadata?.tts_voice_key || DEFAULT_VOICE_KEY;
    const voiceDbg = getTtsVoiceDebugInfo(voiceKey);
    console.log(
      `[job ${jobId}] TTS voice read: metadata.tts_voice_key=${job.metadata?.tts_voice_key ?? "unset"} → effective voiceKey=${voiceKey} (DEFAULT_VOICE_KEY=${DEFAULT_VOICE_KEY})`,
      voiceDbg
    );

    const ttsUsage = createTtsUsageTracker();
    const audioSegments = [];
    for (let index = 0; index < narrationSegments.length; index += 1) {
      const segment = narrationSegments[index];
      const text = (segment.text || "").trim();
      if (!text) {
        continue;
      }

      const audioPath = path.join(audioDir, `${index}.mp3`);
      await generateSpeech(text, voiceKey, audioPath, ttsUsage);
      const stat = await fs.stat(audioPath);
      console.log(
        `[job ${jobId}] generateSpeech wrote segment index=${index} bytes=${stat.size} path=${audioPath}`
      );
      audioSegments.push({
        timestamp: Math.max(0, Number(segment.timestamp) || 0),
        path: audioPath
      });
    }

    console.log(
      `[job ${jobId}] audioSegments after TTS (${audioSegments.length} clips):`,
      audioSegments.map((s) => ({ path: s.path, timestamp: s.timestamp }))
    );

    const { segments: validatedSegments, passThreeMeta } = await validatePassThreeTiming(
      jobId,
      audioSegments,
      videoDurationSeconds,
      PASS3_GAP_SECONDS
    );

    console.log(
      `[job ${jobId}] Pass 3 complete — videoDurationSeconds=${videoDurationSeconds}, maxSegments=${maxSegments}, validatedSegmentCount=${validatedSegments.length}`
    );

    try {
      const passThreeSegmentDetails = passThreeMeta.segmentDetails.map((s) => ({
        timestamp: s.finalTimestamp,
        duration: s.ttsDurationSeconds
      }));
      const coverageMetrics = buildCoverageMetrics(videoDurationSeconds, passThreeSegmentDetails);

      const qaResult = await scoreAnalysisQuality({
        videoDurationSeconds,
        passOneAnalysis,
        passTwoSegments: narrationSegments,
        passThreeValidatedDetails: passThreeMeta.segmentDetails,
        passThreeSegmentsDropped: passThreeMeta.segmentsDropped,
        passThreeSegmentsPushed: passThreeMeta.segmentsPushed,
        coverageMetrics
      });
      console.log(
        `[job ${jobId}] inserting quality score: ${qaResult.analysis_quality_score}`
      );
      const { error: qaInsertError } = await supabase.from("quality_scores").insert({
        job_id: jobId,
        analysis_quality_score: qaResult.analysis_quality_score,
        visual_accuracy: qaResult.visual_accuracy,
        coaching_usefulness: qaResult.coaching_usefulness,
        timing_accuracy: qaResult.timing_accuracy,
        speech_coverage: qaResult.speech_coverage,
        output_compliance: qaResult.output_compliance,
        main_issues: qaResult.main_issues,
        recommended_fix: qaResult.recommended_fix,
        coverage_metrics: coverageMetrics
      });
      if (qaInsertError) {
        console.error(`[job ${jobId}] quality_scores insert failed:`, qaInsertError.message);
      } else {
        console.log(`[job ${jobId}] quality_scores insert ok`);
      }
    } catch (qaError) {
      console.warn(`[job ${jobId}] Pass 4 QA scoring failed:`, qaError.message);
    }

    await updateJob(jobId, {
      status: "stitching_video",
      progress: "Stitching audio into video"
    });

    try {
      await stitchAudioOntoVideo(jobId, safeInputPath, validatedSegments, outputPath, config.VIDEO_PLAYBACK_SPEED);
    } catch (stitchErr) {
      console.error(
        `[job ${jobId}] stitchAudioOntoVideo failed: ${stitchErr?.message ?? stitchErr}. Exporting video without narration mix.`
      );
      await updateJob(jobId, {
        progress: "Commentary mix failed — exporting video without narration"
      });
      await stitchAudioOntoVideo(jobId, safeInputPath, [], outputPath, config.VIDEO_PLAYBACK_SPEED);
    }

    const outputBuffer = await fs.readFile(outputPath);
    console.log(`[job ${jobId}] uploading FFmpeg output (${outputBuffer.length} bytes) from ${outputPath} → storage ${jobId}/output.mp4`);
    const outputStoragePath = `${jobId}/output.mp4`;
    await uploadFile(outputStoragePath, outputBuffer, "video/mp4");

    const outputSignedUrl = await getSignedUrl(outputStoragePath, 60 * 60 * 24);

    // Extract a JPEG frame as the roll's thumbnail. Non-fatal: failure here
    // doesn't block completion — frontend hides the image onError, and the
    // worker logs a warning so we can diagnose later.
    try {
      const thumbnailPath = path.join(tempDir, "thumbnail.jpg");
      // Videos shorter than 5s fall back to their midpoint so the thumbnail
      // is never past the end-of-stream (ffmpeg would produce zero output).
      const thumbnailOffsetSeconds =
        Number.isFinite(videoDurationSeconds) && videoDurationSeconds >= 5
          ? 5
          : Math.max(0, (videoDurationSeconds || 0) * 0.5);
      await extractFrame(outputPath, thumbnailPath, thumbnailOffsetSeconds, jobId);
      const thumbBuffer = await fs.readFile(thumbnailPath);
      await uploadFile(`${jobId}/thumbnail.jpg`, thumbBuffer, "image/jpeg");
      console.log(
        `[job ${jobId}] thumbnail uploaded (frame @ ${thumbnailOffsetSeconds}s, ${thumbBuffer.length} bytes)`
      );
    } catch (thumbErr) {
      console.warn(`[job ${jobId}] thumbnail extraction failed:`, thumbErr.message);
    }

    const { characterCount: ttsCharacters, costUsd: ttsCostUsd } = ttsUsage.getTotals();
    const totalCostUsd = llmUsage.pass1CostUsd + llmUsage.pass2CostUsd + ttsCostUsd;
    const voiceKeyForLog = normalizeVoiceKey(voiceKey);

    // usage_logs: after FFmpeg output is uploaded and signed URL exists; before job marked complete (lines below).
    const { error: usageLogError } = await supabase.from("usage_logs").insert({
      job_id: jobId,
      pass1_prompt_tokens: llmUsage.pass1PromptTokens,
      pass1_completion_tokens: llmUsage.pass1CompletionTokens,
      pass1_cost_usd: llmUsage.pass1CostUsd,
      pass2_prompt_tokens: llmUsage.pass2PromptTokens,
      pass2_completion_tokens: llmUsage.pass2CompletionTokens,
      pass2_cost_usd: llmUsage.pass2CostUsd,
      tts_characters: ttsCharacters,
      tts_cost_usd: ttsCostUsd,
      total_cost_usd: totalCostUsd,
      voice_key: voiceKeyForLog,
      video_duration_seconds: Number.isFinite(videoDurationSeconds)
        ? Number(Number(videoDurationSeconds).toFixed(2))
        : null
    });

    if (usageLogError) {
      console.error(`[job ${jobId}] usage_logs insert failed:`, usageLogError.message);
    } else {
      console.log(`[job ${jobId}] usage_logs insert ok`);
    }

    await updateJob(jobId, {
      status: "complete",
      progress: "Done",
      output_url: outputSignedUrl,
      completed_at: new Date().toISOString(),
      error_message: null
    });

    const completedVoiceDbg = getTtsVoiceDebugInfo(voiceKey);
    console.log(`TTS voice key used: ${voiceKey}`);
    console.log(
      `ElevenLabs voice ID suffix: ${completedVoiceDbg.voiceIdSuffix ?? "n/a"}`
    );
  } catch (error) {
    // Keep the raw provider/stack detail in the worker logs for debugging,
    // but only expose the generic outage copy to end users.
    console.error(`[job ${jobId}] processing failed:`, error);
    await updateJob(jobId, {
      status: "failed",
      progress: "Failed",
      error_message: error?.message || SERVICE_UNAVAILABLE_MESSAGE
    });
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function downloadInputVideo(jobId, storagePath, outputPath) {
  // Legacy: local absolute path (older jobs).
  if (path.isAbsolute(storagePath)) {
    console.log(
      `[job ${jobId}] input video source: local filesystem path (legacy), not R2 — ${storagePath}`
    );
    await fs.copyFile(storagePath, outputPath);
    await fs.rm(storagePath, { force: true });
    await fs.rm(path.dirname(storagePath), { recursive: true, force: true }).catch(() => {});
    return;
  }

  const rawKey = storagePath == null ? "" : String(storagePath);
  const r2Key = rawKey.trim();
  if (rawKey !== r2Key) {
    console.warn(
      `[job ${jobId}] input_url had leading/trailing whitespace; using trimmed key for R2 download`
    );
  }
  console.log(
    `[job ${jobId}] downloading input video from R2 — exact object key: ${JSON.stringify(r2Key)} (chars=${r2Key.length})`
  );

  let buf;
  try {
    buf = await downloadFile(r2Key);
  } catch (dlErr) {
    console.error(
      `[job ${jobId}] R2 download failed — key=${JSON.stringify(r2Key)} bucket=${process.env.R2_BUCKET_NAME ?? "(unset)"} error=${dlErr.message}`
    );
    throw dlErr;
  }
  await fs.writeFile(outputPath, buf);
}

function transcodeToSafeH264(jobId, inputPath, outputPath) {
  console.log(`[job ${jobId}] Pre-transcode: ${inputPath} → ${outputPath}`);
  assertReadableFile(jobId, inputPath, "pre-transcode input");
  return new Promise((resolve, reject) => {
    const command = ffmpeg(inputPath).outputOptions([
      "-y",
      "-c:v libx264",
      "-preset fast",
      "-crf 23",
      "-c:a aac",
      "-movflags +faststart"
    ]);
    const getStderr = attachFfmpegDiagnostics(jobId, "pre-transcode", command);

    command
      .output(outputPath)
      .on("end", () => {
        console.log(`[job ${jobId}] Pre-transcode complete`);
        resolve();
      })
      .on("error", (err) => {
        const stderr = getStderr();
        if (stderr) {
          console.error(`[job ${jobId}] Pre-transcode stderr (tail):\n${stderr.slice(-8000)}`);
        }
        console.error(`[job ${jobId}] Pre-transcode failed:`, err.message);
        reject(err);
      })
      .run();
  });
}

function extractFrames(jobId, inputVideoPath, framesDir) {
  const outputPattern = path.join(framesDir, "frame-%06d.jpg");
  const fps = config.FRAMES_PER_SECOND;

  assertReadableFile(jobId, inputVideoPath, "frame extract input");

  return new Promise((resolve, reject) => {
    const command = ffmpeg(inputVideoPath).outputOptions(["-y", "-vf", `fps=${fps},scale=480:-1`]);
    const getStderr = attachFfmpegDiagnostics(jobId, "extract-frames", command);

    command
      .output(outputPattern)
      .on("end", async () => {
        try {
          const frameFiles = (await fs.readdir(framesDir))
            .filter((name) => name.endsWith(".jpg"))
            .sort();

          const frames = frameFiles.map((name, index) => ({
            timestamp: index / fps,
            path: path.join(framesDir, name)
          }));

          resolve(frames);
        } catch (error) {
          reject(error);
        }
      })
      .on("error", (err) => {
        const stderr = getStderr();
        if (stderr) {
          console.error(`[job ${jobId}] extract-frames stderr (tail):\n${stderr.slice(-8000)}`);
        }
        reject(err);
      })
      .run();
  });
}

/** @param {string | null} [jobIdForLog] */
function extractFrame(videoPath, outputImagePath, seconds, jobIdForLog = null) {
  assertReadableFile(jobIdForLog != null ? String(jobIdForLog) : "extractFrame", videoPath, "thumbnail source video");

  return new Promise((resolve, reject) => {
    const command = ffmpeg(videoPath)
      .seekInput(Math.max(0, seconds))
      // -frames:v 1 → single frame; -q:v 3 → high-quality JPEG; scale to
      // 640px wide (even height preserved via -2) keeps the thumbnail
      // lightweight while remaining crisp on retina devices.
      .outputOptions(["-y", "-frames:v", "1", "-q:v", "3", "-vf", "scale=640:-2"]);

    const getStderr =
      jobIdForLog != null
        ? attachFfmpegDiagnostics(jobIdForLog, "thumbnail", command)
        : () => "";

    command
      .output(outputImagePath)
      .on("end", () => resolve())
      .on("error", (err) => {
        if (jobIdForLog != null) {
          const stderr = getStderr();
          if (stderr) {
            console.error(`[job ${jobIdForLog}] thumbnail stderr (tail):\n${stderr.slice(-4000)}`);
          }
        }
        reject(err);
      })
      .run();
  });
}

function resolveWatermarkFontPath() {
  const candidates =
    process.platform === "darwin"
      ? [
          "/System/Library/Fonts/Supplemental/Arial.ttf",
          "/Library/Fonts/Arial.ttf",
          "/System/Library/Fonts/Helvetica.ttc"
        ]
      : process.platform === "win32"
        ? [path.join(process.env.SystemRoot || "C:\\Windows", "Fonts", "arial.ttf")]
        : [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
            "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf"
          ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Escape path for FFmpeg filtergraph (colon in Windows drive etc.). */
function escapePathForDrawtextFilter(absPath) {
  const normalized = path.normalize(absPath).replace(/\\/g, "/");
  return normalized.replace(/:/g, "\\:");
}

/** Quote label text for drawtext `text=` — safe for typical alphanumeric + spaces. */
function quoteDrawtextForFilter(text) {
  return `'${String(text).replace(/\\/g, "\\\\").replace(/'/g, "'\\''")}'`;
}

/**
 * Video chain ending in [v]: setpts then optional top-right watermark (before audio mix).
 */
function buildVideoFilterGraph(ptsMultiplier, includeWatermark, fontPath, watermarkText) {
  const pts = `[0:v]setpts=${ptsMultiplier}*PTS`;
  if (!includeWatermark || !fontPath || !watermarkText) {
    return `${pts}[v]`;
  }
  const fp = escapePathForDrawtextFilter(fontPath);
  const txt = quoteDrawtextForFilter(watermarkText);
  return `${pts},drawtext=fontfile=${fp}:text=${txt}:fontcolor=white@0.5:fontsize=40:x=w-tw-20:y=20[v]`;
}

async function stitchAudioOntoVideo(jobId, inputVideoPath, audioSegments, outputPath, playbackSpeed = 1) {
  const ptsMultiplier = 1 / playbackSpeed;
  const watermarkText = (process.env.WATERMARK_TEXT ?? "RollAI").trim() || "RollAI";
  const fontPath = resolveWatermarkFontPath();
  const wantWatermark = Boolean(fontPath && watermarkText);
  if (!fontPath) {
    console.warn(`[job ${jobId}] Watermark skipped: no font file found for drawtext (install DejaVu/Arial or set a readable path)`);
  }

  assertReadableFile(jobId, inputVideoPath, "stitch input video");

  const maxSeg = getMaxAmixSegments();
  let segments = audioSegments.slice();
  if (segments.length > maxSeg) {
    console.warn(
      `[job ${jobId}] Capping stitched narration segments (${segments.length} → ${maxSeg}) for amix stability. Set ROLLAI_MAX_AMIX_SEGMENTS to raise (max 32).`
    );
    segments = segments.slice(0, maxSeg);
  }

  console.log(`[job ${jobId}] FFmpeg stitch input video: ${inputVideoPath}`);
  console.log(
    `[job ${jobId}] FFmpeg audio inputs (Pass 3 validated, count=${segments.length}):`,
    segments.map((s, i) => ({
      ffmpegInputIndex: i + 1,
      path: s.path,
      timestampSec: s.timestamp
    }))
  );

  for (const seg of segments) {
    assertReadableFile(jobId, seg.path, "audio segment");
  }

  const runStitch = (includeWatermark) =>
    new Promise((resolve, reject) => {
      const videoFilter = buildVideoFilterGraph(ptsMultiplier, includeWatermark, fontPath, watermarkText);

      if (segments.length === 0) {
        console.log(`[job ${jobId}] FFmpeg no audio segments — video-only output: ${outputPath}`);
        const command = ffmpeg(inputVideoPath)
          .complexFilter([[videoFilter]])
          .outputOptions(["-y", "-map [v]", "-c:v libx264", "-pix_fmt yuv420p", "-an"]);
        const getStderr = attachFfmpegDiagnostics(jobId, "stitch-video-only", command);
        command
          .output(outputPath)
          .on("end", resolve)
          .on("error", (err) => {
            const stderr = getStderr();
            if (stderr) {
              console.error(`[job ${jobId}] stitch-video-only stderr (tail):\n${stderr.slice(-8000)}`);
            }
            reject(err);
          })
          .run();
        return;
      }

      const command = ffmpeg();
      command.input(inputVideoPath);
      segments.forEach((segment) => command.input(segment.path));

      const delayFilters = segments.map((segment, index) => {
        const delayMs = Math.floor((segment.timestamp / playbackSpeed) * 1000);
        return `[${index + 1}:a]adelay=${delayMs}|${delayMs}[a${index}]`;
      });

      const mixedInputs = segments.map((_, index) => `[a${index}]`).join("");
      const filterGraph = [
        videoFilter,
        ...delayFilters,
        `${mixedInputs}amix=inputs=${segments.length}:dropout_transition=0[mix]`
      ];

      console.log(`[job ${jobId}] FFmpeg filter_complex (${filterGraph.length} statements):`);
      filterGraph.forEach((statement, idx) => {
        console.log(`[job ${jobId}]   [${idx}] ${statement}`);
      });
      console.log(`[job ${jobId}] FFmpeg writing stitched video to: ${outputPath}`);

      const getStderr = attachFfmpegDiagnostics(jobId, "stitch-audio-video", command);

      command
        .complexFilter(filterGraph)
        .outputOptions(["-y", "-map [v]", "-map [mix]", "-c:v libx264", "-pix_fmt yuv420p", "-c:a aac"])
        .output(outputPath)
        .on("end", resolve)
        .on("error", (err) => {
          const stderr = getStderr();
          if (stderr) {
            console.error(`[job ${jobId}] stitch-audio-video stderr (tail):\n${stderr.slice(-12000)}`);
          }
          reject(err);
        })
        .run();
    });

  try {
    await runStitch(wantWatermark);
  } catch (firstError) {
    if (wantWatermark) {
      console.warn(
        `[job ${jobId}] Watermark FFmpeg failed (${firstError.message}); retrying stitch without drawtext`
      );
      await runStitch(false);
    } else {
      throw firstError;
    }
  }
}

/**
 * Pass 3: measure real MP3 durations, resolve overlaps by pushing starts forward.
 * Only the **last accepted** clip defines the next min start — dropped clips never chain forward.
 * If adjusted start would fall at/after video end, or the clip extends past the end, drop (no placement beyond duration).
 */
/**
 * Objective speech/silence metrics from Pass 3–validated segments ({ timestamp, duration } in seconds).
 */
function buildCoverageMetrics(videoDurationSeconds, passThreeSegmentDetails) {
  const vd = Number(videoDurationSeconds);
  const durationSafe = Number.isFinite(vd) && vd > 0 ? vd : 0;

  const totalSpeechDuration = passThreeSegmentDetails.reduce(
    (sum, s) => sum + (Number(s.duration) || 0),
    0
  );
  const speechCoveragePct =
    durationSafe > 0 ? (totalSpeechDuration / durationSafe) * 100 : 0;

  const sorted = [...passThreeSegmentDetails].sort(
    (a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0)
  );
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1].timestamp + sorted[i - 1].duration;
    gaps.push(sorted[i].timestamp - prevEnd);
  }
  const maxSilentGap = gaps.length ? Math.max(...gaps) : durationSafe;
  const avgSilentGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : durationSafe;
  const overlapCount = gaps.filter((g) => g < 0).length;

  return {
    video_duration: durationSafe,
    segment_count: sorted.length,
    total_speech_duration: totalSpeechDuration,
    speech_coverage_pct: Math.round(speechCoveragePct),
    max_silent_gap: Math.round(maxSilentGap),
    average_silent_gap: Math.round(avgSilentGap),
    overlap_count: overlapCount
  };
}

async function validatePassThreeTiming(jobId, audioSegments, videoDurationSeconds, gapSeconds) {
  const emptyMeta = {
    segmentsDropped: 0,
    segmentsPushed: 0,
    segmentDetails: []
  };

  if (!audioSegments.length) {
    return { segments: [], passThreeMeta: emptyMeta };
  }

  if (!Number.isFinite(videoDurationSeconds) || videoDurationSeconds <= 0) {
    console.warn(
      `[job ${jobId}] Pass 3: invalid videoDurationSeconds=${videoDurationSeconds} — refusing to schedule audio (would chain without a valid cap)`
    );
    return { segments: [], passThreeMeta: emptyMeta };
  }

  console.log(
    `[job ${jobId}] Pass 3: validatePassThreeTiming videoDurationSeconds=${videoDurationSeconds}s gap=${gapSeconds}s segmentsIn=${audioSegments.length}`
  );

  const sorted = [...audioSegments].sort((a, b) => a.timestamp - b.timestamp);
  const withDur = await Promise.all(
    sorted.map(async (seg) => ({
      path: seg.path,
      originalTimestamp: seg.timestamp,
      durationSec: await getAudioDurationSeconds(seg.path)
    }))
  );

  /** @type {{ path: string, timestamp: number, durationSec: number, originalTimestamp: number }[]} */
  const accepted = [];
  let segmentsDropped = 0;
  let segmentsPushed = 0;

  for (const row of withDur) {
    let startTime = Math.max(0, row.originalTimestamp);
    if (accepted.length > 0) {
      const prev = accepted[accepted.length - 1];
      const minStart = prev.timestamp + prev.durationSec + gapSeconds;
      if (minStart > startTime) {
        console.warn(
          `[job ${jobId}] Pass 3: pushed segment forward — originalStart=${row.originalTimestamp}s adjustedStart=${minStart}s (prev ends ${prev.timestamp + prev.durationSec}s + ${gapSeconds}s gap)`
        );
        startTime = minStart;
        segmentsPushed += 1;
      }
    }

    if (startTime >= videoDurationSeconds) {
      console.warn(
        `[job ${jobId}] Pass 3: dropped segment (adjusted start at/after video end) — originalStart=${row.originalTimestamp}s adjustedStart=${startTime}s videoDuration=${videoDurationSeconds}s`
      );
      segmentsDropped += 1;
      continue;
    }

    if (startTime + row.durationSec > videoDurationSeconds + 1e-3) {
      console.warn(
        `[job ${jobId}] Pass 3: dropped segment (clip extends past video end) — originalStart=${row.originalTimestamp}s adjustedStart=${startTime}s duration=${row.durationSec}s videoDuration=${videoDurationSeconds}s`
      );
      segmentsDropped += 1;
      continue;
    }

    accepted.push({
      path: row.path,
      timestamp: startTime,
      durationSec: row.durationSec,
      originalTimestamp: row.originalTimestamp
    });
  }

  const segmentDetails = accepted.map((s) => ({
    finalTimestamp: s.timestamp,
    originalTimestamp: s.originalTimestamp,
    ttsDurationSeconds: s.durationSec
  }));

  return {
    segments: accepted.map(({ path, timestamp }) => ({ path, timestamp })),
    passThreeMeta: {
      segmentsDropped,
      segmentsPushed,
      segmentDetails
    }
  };
}

function getAudioDurationSeconds(audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (error, metadata) => {
      if (error) {
        reject(error);
        return;
      }
      const duration = metadata?.format?.duration;
      if (typeof duration !== "number" || Number.isNaN(duration)) {
        reject(new Error(`Could not read audio duration for ${audioPath}`));
        return;
      }
      resolve(duration);
    });
  });
}

function getVideoDurationSeconds(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (error, metadata) => {
      if (error) {
        reject(error);
        return;
      }
      const duration = metadata?.format?.duration;
      if (typeof duration !== "number" || Number.isNaN(duration)) {
        reject(new Error(`Could not read video duration for ${videoPath}`));
        return;
      }
      resolve(duration);
    });
  });
}

async function updateJob(jobId, changes) {
  const payload = {
    ...changes,
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase.from("jobs").update(payload).eq("sqlid", jobId);
  if (error) {
    throw new Error(error.message);
  }
}
