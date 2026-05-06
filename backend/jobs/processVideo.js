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
import {
  analyseFrames,
  NARRATION_WORDS_PER_SECOND,
  scoreAnalysisQuality
} from "../providers/openai.js";
import { SERVICE_UNAVAILABLE_MESSAGE } from "../lib/errorMessages.js";
import { finalizeRollDisplayTitle } from "../lib/rollTitle.js";
import {
  getDebugRunsJobDirAbsolute,
  saveDebugRunFile
} from "../lib/debugRunsExport.js";
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

/** Gap between stacked narration clips after real MP3 durations are known (Pass 6 post-TTS). */
const PASS3_GAP_SECONDS = 2;

/** Rough USD equivalent for ~£0.31 baseline; warn if total job cost materially exceeds this. */
const PIPELINE_COST_BASELINE_USD = 0.39;

function countWords(text) {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

function stripLastSentence(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return "";
  const run = trimmed.replace(/\s+/g, " ");
  const lastPeriod = run.lastIndexOf(". ");
  const lastBang = run.lastIndexOf("! ");
  const lastQ = run.lastIndexOf("? ");
  const cut = Math.max(lastPeriod, lastBang, lastQ);
  if (cut < 8) return "";
  return run.slice(0, cut + 1).trim();
}

function truncateToWordBudget(text, maxWords) {
  const words = (typeof text === "string" ? text : "").trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ").trim();
  return words.slice(0, maxWords).join(" ").trim();
}

function maxWordsForDuration(seconds, wordsPerSec) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return 0;
  return Math.max(0, Math.floor(s * wordsPerSec * 0.97));
}

/**
 * Pass 5 (pre-TTS): fit paragraph script to planned windows — shorten, expand gap, hard truncate, merge/drop.
 * estimatedDuration = wordCount / 2.3
 */
function applyPassFiveNarrationValidation(jobId, videoDurationSeconds, voiceoverSections, wordsPerSec) {
  /** @type {string[]} */
  const adjustments = [];
  const EPS = 0.05;

  const sorted = [...voiceoverSections]
    .map((s) => ({
      start: Number(s.start),
      end: Number(s.end),
      text: String(s.text || "")
    }))
    .sort((a, b) => a.start - b.start)
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end));

  /** @type {{ start: number, end: number, text: string }[]} */
  const out = [];

  const estDur = (t) => countWords(t) / wordsPerSec;

  for (let i = 0; i < sorted.length; i += 1) {
    let { start, end, text } = sorted[i];
    const nextStart =
      i + 1 < sorted.length ? sorted[i + 1].start : videoDurationSeconds;

    let avail = end - start;
    if (avail <= EPS) {
      adjustments.push(
        `[job ${jobId}] Pass5: skipped section with invalid window length (start=${start}, end=${end})`
      );
      if (text.trim() && out.length > 0) {
        out[out.length - 1].text = `${out[out.length - 1].text} ${text.trim()}`.trim();
        out[out.length - 1].end = Math.max(out[out.length - 1].end, end);
        adjustments.push(`[job ${jobId}] Pass5: merged orphan text into previous section`);
      }
      continue;
    }

    text = text.trim();

    let guard = 0;
    while (estDur(text) > avail + EPS && text.length > 0 && guard < 150) {
      guard += 1;
      const shorter = stripLastSentence(text);
      if (shorter.length > 0 && shorter.length < text.length) {
        text = shorter;
        adjustments.push(`[job ${jobId}] Pass5: section ${i} shortened by sentence trim`);
        continue;
      }
      const mw = maxWordsForDuration(avail, wordsPerSec);
      text = truncateToWordBudget(text, mw);
      adjustments.push(
        `[job ${jobId}] Pass5: section ${i} truncated to ${mw} words (word budget)`
      );
      break;
    }

    if (estDur(text) > avail + EPS) {
      const neededEnd = start + estDur(text);
      const maxEnd = Math.min(nextStart - EPS, videoDurationSeconds);
      const newEnd = Math.min(maxEnd, Math.max(end, Math.min(neededEnd + 0.25, maxEnd)));
      if (newEnd > end + EPS) {
        adjustments.push(
          `[job ${jobId}] Pass5: section ${i} expanded window end ${end.toFixed(2)}s → ${newEnd.toFixed(2)}s`
        );
        end = newEnd;
        avail = end - start;
      }

      if (estDur(text) > avail + EPS) {
        const mw = maxWordsForDuration(avail, wordsPerSec);
        const before = text;
        text = truncateToWordBudget(text, mw);
        if (text !== before) {
          adjustments.push(
            `[job ${jobId}] Pass5: section ${i} post-expand truncate to ${mw} words`
          );
        }
      }
    }

    if (countWords(text) < 4) {
      if (out.length > 0) {
        out[out.length - 1].text = `${out[out.length - 1].text} ${text}`.trim();
        out[out.length - 1].end = Math.max(out[out.length - 1].end, end);
        adjustments.push(`[job ${jobId}] Pass5: merged very short section ${i} into previous`);
      } else {
        adjustments.push(`[job ${jobId}] Pass5: dropped sparse section ${i} (no anchor)`);
      }
      continue;
    }

    if (estDur(text) > avail + EPS) {
      if (out.length > 0) {
        out[out.length - 1].text = `${out[out.length - 1].text} ${text}`.trim();
        out[out.length - 1].end = Math.max(out[out.length - 1].end, end);
        adjustments.push(`[job ${jobId}] Pass5: merged still-overlong section ${i} into previous`);
      } else {
        const mw = maxWordsForDuration(avail, wordsPerSec);
        text = truncateToWordBudget(text, mw);
        adjustments.push(`[job ${jobId}] Pass5: first section hard-capped to ${mw} words`);
        out.push({ start, end, text });
      }
      continue;
    }

    out.push({ start, end, text });
  }

  for (let j = 0; j < Math.min(40, adjustments.length); j += 1) {
    console.warn(adjustments[j]);
  }
  if (adjustments.length > 40) {
    console.warn(
      `[job ${jobId}] Pass5: ${adjustments.length} total adjustments (showing first 40 above)`
    );
  }

  return { sections: out, adjustments };
}

/**
 * Debug JSON in the job temp workspace (same envelope shape as LLM passes in `openai.js`).
 */
async function writeJobPipelineDebugFile(tempDir, jobId, videoDurationSeconds, fileName, passName, body) {
  const envelope = {
    jobId,
    videoDurationSeconds,
    passName,
    createdAt: new Date().toISOString(),
    rawModelOutput: body.rawModelOutput ?? null,
    parsedOutput: body.parsedOutput ?? null,
    normalisedForNextStep: body.normalisedForNextStep ?? null
  };
  await saveDebugRunFile(jobId, fileName, envelope);
  const filePath = path.join(tempDir, fileName);
  const json = JSON.stringify(envelope, null, 2);
  await fs.writeFile(filePath, json, "utf8");
  console.log(`[job ${jobId}] pipeline debug artifact: ${filePath}`);
}

/** Names of JSON files written for pipeline debugging; used to decide whether temp dir may be preserved. */
const PIPELINE_DEBUG_ARTIFACT_FILENAMES = [
  "pass1-timeline.json",
  "pass2-coaching-interpretation.json",
  "pass3-narration-plan.json",
  "pass4-script.json",
  "pass5-validated-script.json",
  "final-audio-segments.json"
];

async function pipelineDebugArtifactsPresent(workspaceDir) {
  try {
    const names = await fs.readdir(workspaceDir);
    const set = new Set(names);
    return PIPELINE_DEBUG_ARTIFACT_FILENAMES.some((f) => set.has(f));
  } catch {
    return false;
  }
}

function augmentCoverageForNarrative(base, narrationPlan, passFiveSections, videoDurationSeconds) {
  const words = passFiveSections.reduce((sum, x) => sum + countWords(x.text), 0);
  const n = passFiveSections.length || 1;
  const avg_words_per_segment = Math.round((words / n) * 10) / 10;

  const nw = narrationPlan?.narration_windows || [];
  const sorted = [...nw].sort((a, b) => Number(a.start) - Number(b.start));
  let maxPlannedBetween = 0;
  for (let j = 1; j < sorted.length; j += 1) {
    maxPlannedBetween = Math.max(
      maxPlannedBetween,
      Number(sorted[j].start) - Number(sorted[j - 1].end)
    );
  }
  const opening = sorted.length ? Math.max(0, sorted[0].start) : 0;
  const closing = sorted.length
    ? Math.max(0, videoDurationSeconds - sorted[sorted.length - 1].end)
    : videoDurationSeconds;
  const plannedMaxGap = Math.max(maxPlannedBetween, opening, closing, 0);

  const unplanned_silence_penalty = Math.max(
    0,
    Math.round(Math.min(100, Math.max(0, base.max_silent_gap - plannedMaxGap - 12) * 1.8))
  );

  return {
    ...base,
    avg_words_per_segment,
    planned_max_inter_window_gap_seconds: Math.round(plannedMaxGap),
    unplanned_silence_penalty
  };
}

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
    const analysisResult = await analyseFrames(frames, {
      participantDescription,
      videoDurationSeconds,
      pipelineDebug: {
        jobId,
        workspaceDir: tempDir,
        videoDurationSeconds
      }
    });

    console.log(
      `[job ${jobId}] analyseFrames returned:`,
      JSON.stringify({
        hasUsage: Boolean(analysisResult?.usage),
        segmentCount: analysisResult?.segments?.length ?? 0,
        narrationWindows:
          analysisResult?.narrationPlan?.narration_windows?.length ?? 0
      })
    );

    let voiceoverSectionsRaw = Array.isArray(analysisResult?.voiceoverSectionsRaw)
      ? analysisResult.voiceoverSectionsRaw
      : [];
    if (voiceoverSectionsRaw.length === 0 && Array.isArray(analysisResult?.segments)) {
      voiceoverSectionsRaw = analysisResult.segments.map((s) => ({
        start: Number(s.timestamp),
        end: Math.min(
          videoDurationSeconds,
          Number(s.timestamp) + Math.max(8, videoDurationSeconds / Math.max(analysisResult.segments.length, 1))
        ),
        text: String(s.text || "")
      }));
    }

    const passFive = applyPassFiveNarrationValidation(
      jobId,
      videoDurationSeconds,
      voiceoverSectionsRaw,
      NARRATION_WORDS_PER_SECOND
    );
    const narrationSegments = passFive.sections.map((s) => ({
      timestamp: Math.max(0, s.start),
      text: s.text
    }));

    await writeJobPipelineDebugFile(
      tempDir,
      jobId,
      videoDurationSeconds,
      "pass5-validated-script.json",
      "Pass 5 — pre-TTS validated script",
      {
        rawModelOutput: null,
        parsedOutput: {
          voiceoverSectionsFromPass4: voiceoverSectionsRaw
        },
        normalisedForNextStep: {
          validatedSections: passFive.sections,
          narrationSegmentsForTts: narrationSegments,
          adjustmentsLog: passFive.adjustments,
          wordsPerSecond: NARRATION_WORDS_PER_SECOND
        }
      }
    );

    const passOneAnalysis = analysisResult?.passOneAnalysis ?? null;
    const coachingInterpretation = analysisResult?.coachingInterpretation ?? null;
    const narrationPlan = analysisResult?.narrationPlan ?? null;

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
      pass2CostUsd: 0,
      pass3PromptTokens: 0,
      pass3CompletionTokens: 0,
      pass3CostUsd: 0,
      pass4PromptTokens: 0,
      pass4CompletionTokens: 0,
      pass4CostUsd: 0
    };

    console.log(
      `[job ${jobId}] narration segment starts (post Pass5):`,
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

    await writeJobPipelineDebugFile(
      tempDir,
      jobId,
      videoDurationSeconds,
      "final-audio-segments.json",
      "Final audio segments (after Pass 6 timing placement, for stitch)",
      {
        rawModelOutput: null,
        parsedOutput: {
          afterTtsBeforePlacement: audioSegments.map((s) => ({
            path: s.path,
            timestamp: s.timestamp
          }))
        },
        normalisedForNextStep: {
          segmentsForStitch: validatedSegments.map((s) => ({
            path: s.path,
            timestamp: s.timestamp
          })),
          placementMeta: {
            segmentsDropped: passThreeMeta.segmentsDropped,
            segmentsPushed: passThreeMeta.segmentsPushed,
            segmentDetails: passThreeMeta.segmentDetails,
            gapSeconds: PASS3_GAP_SECONDS
          }
        }
      }
    );

    let qaUsage = {
      pass5PromptTokens: 0,
      pass5CompletionTokens: 0,
      pass5CostUsd: 0
    };

    console.log(
      `[job ${jobId}] Pass 6 post-TTS placement — videoDurationSeconds=${videoDurationSeconds}, validatedClipCount=${validatedSegments.length}`
    );

    try {
      const passThreeSegmentDetails = passThreeMeta.segmentDetails.map((s) => ({
        timestamp: s.finalTimestamp,
        duration: s.ttsDurationSeconds
      }));
      let coverageMetrics = buildCoverageMetrics(videoDurationSeconds, passThreeSegmentDetails);
      coverageMetrics = augmentCoverageForNarrative(
        coverageMetrics,
        narrationPlan,
        passFive.sections,
        videoDurationSeconds
      );

      const finalVoiceoverForQa = passFive.sections.map((s) => ({
        start: s.start,
        end: s.end,
        text: s.text
      }));

      const qaResult = await scoreAnalysisQuality({
        videoDurationSeconds,
        passOneAnalysis,
        coachingInterpretation,
        narrationPlan,
        passTwoSegments: finalVoiceoverForQa,
        passThreeValidatedDetails: passThreeMeta.segmentDetails,
        passThreeSegmentsDropped: passThreeMeta.segmentsDropped,
        passThreeSegmentsPushed: passThreeMeta.segmentsPushed,
        passFiveAdjustments: passFive.adjustments,
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
        narrative_coherence: qaResult.narrative_coherence,
        main_issues: qaResult.main_issues,
        recommended_fix: qaResult.recommended_fix,
        coverage_metrics: coverageMetrics
      });
      if (qaInsertError) {
        console.error(`[job ${jobId}] quality_scores insert failed:`, qaInsertError.message);
      } else {
        console.log(`[job ${jobId}] quality_scores insert ok`);
      }
      qaUsage = qaResult.usage ?? qaUsage;
    } catch (qaError) {
      console.warn(`[job ${jobId}] Pass 7 QA scoring failed:`, qaError.message);
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
    const totalCostUsd =
      llmUsage.pass1CostUsd +
      llmUsage.pass2CostUsd +
      (llmUsage.pass3CostUsd ?? 0) +
      (llmUsage.pass4CostUsd ?? 0) +
      (qaUsage.pass5CostUsd ?? 0) +
      ttsCostUsd;
    const voiceKeyForLog = normalizeVoiceKey(voiceKey);

    if (totalCostUsd > PIPELINE_COST_BASELINE_USD * 1.4) {
      console.warn(
        `[job ${jobId}] COST ALERT: total pipeline ≈ $${totalCostUsd.toFixed(4)} USD vs historical baseline ~£0.31 (≈ $${PIPELINE_COST_BASELINE_USD} USD — rough FX; five LLM passes + TTS).`
      );
    }

    // usage_logs: after FFmpeg output is uploaded and signed URL exists; before job marked complete.
    const { error: usageLogError } = await supabase.from("usage_logs").insert({
      job_id: jobId,
      pass1_prompt_tokens: llmUsage.pass1PromptTokens,
      pass1_completion_tokens: llmUsage.pass1CompletionTokens,
      pass1_cost_usd: llmUsage.pass1CostUsd,
      pass2_prompt_tokens: llmUsage.pass2PromptTokens,
      pass2_completion_tokens: llmUsage.pass2CompletionTokens,
      pass2_cost_usd: llmUsage.pass2CostUsd,
      pass3_prompt_tokens: llmUsage.pass3PromptTokens ?? 0,
      pass3_completion_tokens: llmUsage.pass3CompletionTokens ?? 0,
      pass3_cost_usd: llmUsage.pass3CostUsd ?? 0,
      pass4_prompt_tokens: llmUsage.pass4PromptTokens ?? 0,
      pass4_completion_tokens: llmUsage.pass4CompletionTokens ?? 0,
      pass4_cost_usd: llmUsage.pass4CostUsd ?? 0,
      pass5_prompt_tokens: qaUsage.pass5PromptTokens ?? 0,
      pass5_completion_tokens: qaUsage.pass5CompletionTokens ?? 0,
      pass5_cost_usd: qaUsage.pass5CostUsd ?? 0,
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
    console.log(`DEBUG FOLDER: ${getDebugRunsJobDirAbsolute(jobId)}`);
    if (
      process.env.PRESERVE_DEBUG_ARTIFACTS === "true" &&
      (await pipelineDebugArtifactsPresent(tempDir))
    ) {
      console.log(`[job ${jobId}] debug workspace preserved: ${tempDir}`);
    } else {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
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
    `[job ${jobId}] FFmpeg audio inputs (Pass 6 post-TTS placement, count=${segments.length}):`,
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
 * Post-TTS (Pass 6 in pipeline): measure real MP3 durations, resolve overlaps by pushing starts forward.
 * Only the **last accepted** clip defines the next min start — dropped clips never chain forward.
 * If adjusted start would fall at/after video end, or the clip extends past the end, drop (no placement beyond duration).
 */
/**
 * Objective speech/silence metrics from post-TTS–validated segments ({ timestamp, duration } in seconds).
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
      `[job ${jobId}] Pass6 placement: invalid videoDurationSeconds=${videoDurationSeconds} — refusing to schedule audio (would chain without a valid cap)`
    );
    return { segments: [], passThreeMeta: emptyMeta };
  }

  console.log(
    `[job ${jobId}] Pass6 placement: validatePassThreeTiming videoDurationSeconds=${videoDurationSeconds}s gap=${gapSeconds}s segmentsIn=${audioSegments.length}`
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
          `[job ${jobId}] Pass6 placement: pushed segment forward — originalStart=${row.originalTimestamp}s adjustedStart=${minStart}s (prev ends ${prev.timestamp + prev.durationSec}s + ${gapSeconds}s gap)`
        );
        startTime = minStart;
        segmentsPushed += 1;
      }
    }

    if (startTime >= videoDurationSeconds) {
      console.warn(
        `[job ${jobId}] Pass6 placement: dropped segment (adjusted start at/after video end) — originalStart=${row.originalTimestamp}s adjustedStart=${startTime}s videoDuration=${videoDurationSeconds}s`
      );
      segmentsDropped += 1;
      continue;
    }

    if (startTime + row.durationSec > videoDurationSeconds + 1e-3) {
      console.warn(
        `[job ${jobId}] Pass6 placement: dropped segment (clip extends past video end) — originalStart=${row.originalTimestamp}s adjustedStart=${startTime}s duration=${row.durationSec}s videoDuration=${videoDurationSeconds}s`
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
