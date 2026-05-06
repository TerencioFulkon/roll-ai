import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "ffprobe-static";
import { supabase } from "../supabase.js";
import { config } from "../config/index.js";
import {
  explainGeminiUnavailableForLogs,
  resolveVisionTimelineRoute
} from "../lib/visionProviderRoute.js";
import { downloadFile, getSignedUrl, uploadFile } from "../providers/r2.js";
import {
  analyseFrames,
  NARRATION_WORDS_PER_SECOND,
  rerunPassFourAfterGroundingLoss,
  rerunPassFourForTtsDensityRepair,
  scaleNarrativePlanTargetWords,
  scoreAnalysisQuality
} from "../providers/openai.js";
import { toPublicJobErrorMessage } from "../lib/errorMessages.js";
import { finalizeRollDisplayTitle } from "../lib/rollTitle.js";
import { applyVoiceoverGrounding } from "../lib/scriptGrounding.js";
import { computeSpeechMetricsFromRenderedSections } from "../lib/speechDensityPlanning.js";
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

/** Gap injected between narration clips by validatePassThreeTiming (post-TTS, Pass 6). */
const PASS3_GAP_SECONDS = 2;

/**
 * Words-per-second used by Pass 5 to estimate spoken duration.
 * Matches the ~2.1 wps baseline used with Pass 3 target_words density planning (conservative cushion).
 */
const TIMING_WORDS_PER_SECOND = 2.1;

/** Minimum inter-section gap kept in the placement result (seconds). */
const PASS5_SECTION_GAP_SEC = 0.5;

/** Rough USD equivalent for ~£0.31 baseline; warn if total job cost materially exceeds this. */
const PIPELINE_COST_BASELINE_USD = 0.39;

function countWords(text) {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

/** @typedef {{ narrationBudgetSeconds: number, totalActualSpeechSeconds: number, totalInterSectionSilenceSeconds: number, finalSpeechEndSeconds: number, trailingSilenceSeconds: number, actualSpeechCoveragePct: number }} TtsCovMetrics */

/** Continuous concat: narration timeline uses videoDurationSeconds / playbackSpeed budget. */
function buildContinuousTtsCoverageMetrics(report, videoDurationSeconds, playbackSpeed) {
  const vd = Number(videoDurationSeconds) || 0;
  const spd = Math.max(0.01, Number(playbackSpeed) || 1);
  const narrationBudgetSeconds = vd / spd;
  const totalActualSpeechSeconds = Number(report?.totalSpeechSeconds) || 0;
  const totalInterSectionSilenceSeconds = Number(report?.totalSilenceBetweenSections) || 0;
  const finalSpeechEndSeconds =
    Math.round((totalActualSpeechSeconds + totalInterSectionSilenceSeconds) * 1000) / 1000;
  const trailingSilenceSeconds = Math.max(0, narrationBudgetSeconds - finalSpeechEndSeconds);
  const actualSpeechCoveragePct = vd > 0 ? (totalActualSpeechSeconds / vd) * 100 : 0;
  return {
    narrationBudgetSeconds,
    totalActualSpeechSeconds,
    totalInterSectionSilenceSeconds,
    finalSpeechEndSeconds,
    trailingSilenceSeconds,
    actualSpeechCoveragePct
  };
}

function evaluateContinuousTtsCoverage(metrics) {
  /** @type {string[]} */
  const fails = [];
  if (metrics.actualSpeechCoveragePct < 70 && metrics.totalActualSpeechSeconds > 1e-3) {
    fails.push(`Actual narration coverage below 70% after TTS generation (${metrics.actualSpeechCoveragePct.toFixed(1)}%)`);
  }
  if (metrics.trailingSilenceSeconds > 12) {
    fails.push(`Narration ends too early, trailing silence exceeds 12 seconds (${metrics.trailingSilenceSeconds.toFixed(1)}s)`);
  }
  return fails;
}

/** Legacy stamped placement: gaps between clips are PASS3_GAP_SECONDS. */
function buildLegacyTtsCoverageMetrics(passThreeMeta, videoDurationSeconds) {
  const vd = Number(videoDurationSeconds) || 0;
  const det = Array.isArray(passThreeMeta?.segmentDetails) ? passThreeMeta.segmentDetails : [];
  let totalSpeech = 0;
  let gapSum = 0;
  for (let i = 0; i < det.length; i += 1) {
    const d = Number(det[i]?.ttsDurationSeconds) || 0;
    totalSpeech += d;
    if (i < det.length - 1) {
      gapSum += PASS3_GAP_SECONDS;
    }
  }
  const last = det.length ? det[det.length - 1] : null;
  const lastEnd =
    last && Number.isFinite(last.finalTimestamp) && Number.isFinite(last.ttsDurationSeconds)
      ? last.finalTimestamp + last.ttsDurationSeconds
      : 0;
  const trailingSilenceSeconds = Math.max(0, vd - lastEnd);
  const finalSpeechEndSeconds = Math.round((totalSpeech + gapSum) * 1000) / 1000;
  const actualSpeechCoveragePct = vd > 0 ? (totalSpeech / vd) * 100 : 0;
  return {
    narrationBudgetSeconds: vd,
    totalActualSpeechSeconds: Math.round(totalSpeech * 1000) / 1000,
    totalInterSectionSilenceSeconds: Math.round(gapSum * 1000) / 1000,
    finalSpeechEndSeconds,
    trailingSilenceSeconds,
    actualSpeechCoveragePct
  };
}

function evaluateLegacyTtsCoverage(metrics) {
  /** @type {string[]} */
  const fails = [];
  if (metrics.actualSpeechCoveragePct < 70 && metrics.totalActualSpeechSeconds > 1e-3) {
    fails.push(`Actual narration coverage below 70% after TTS generation (${metrics.actualSpeechCoveragePct.toFixed(1)}%)`);
  }
  if (metrics.trailingSilenceSeconds > 12) {
    fails.push(`Narration ends too early, trailing silence exceeds 12 seconds (${metrics.trailingSilenceSeconds.toFixed(1)}s)`);
  }
  return fails;
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
 * Split text into sentences at punctuation boundaries.
 * Returns an array of sentence strings (each includes its trailing punctuation).
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitSentences(text) {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return [];
  // Split after . ! ? when followed by whitespace + uppercase (or a smart-quote opening)
  const parts = t.split(/(?<=[.!?])\s+(?=[A-Z"'‘“])/);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/**
 * Timing Adaptation Agent (Pass 5).
 *
 * Uses `start`/`end` from each Pass 4 section as the planned window. For each section:
 *  1. Estimates spoken duration from word count at `wordsPerSec`.
 *  2. If over the window by >1s: trims the last sentence(s) until it fits.
 *     Never trims below 3 sentences — logs and accepts the over-run instead.
 *  3. Resolves overlaps by pushing sections forward if needed.
 *  4. Logs every adjustment so the QA agent can review them.
 *  5. Warns if final coverage is below 80%.
 *
 * Sections without a planned window (start=0, end=0) fall through to sequential placement.
 *
 * @param {string} jobId
 * @param {Array<{text: string, section_id?: string, start?: number, end?: number, story_role?: string, verified_against_phase_indexes?: number[]}>} scriptSections
 * @param {number} videoDurationSeconds
 * @param {number} wordsPerSec
 * @returns {Array<{timestamp: number, end: number, text: string, section_id: string, story_role: string, narrativeOrderIndex: number, verified_against_phase_indexes: number[]}>}
 */
function adaptScriptToTimeline(jobId, scriptSections, videoDurationSeconds, wordsPerSec) {
  if (!scriptSections.length) {
    console.warn(`[job ${jobId}] Pass5: no script sections to place`);
    return [];
  }

  /** @type {string[]} */
  const adjustments = [];

  // ── Step 1: build working sections with planned windows and estimates ──────
  const working = scriptSections.map((s, i) => {
    const text = String(s.text || "").trim();
    const rawStart = typeof s.start === "number" && Number.isFinite(s.start) && s.start >= 0 ? s.start : null;
    const rawEnd = typeof s.end === "number" && Number.isFinite(s.end) && s.end > 0 ? s.end : null;
    const windowDuration =
      rawStart !== null && rawEnd !== null && rawEnd > rawStart ? rawEnd - rawStart : null;
    const verified_against_phase_indexes =
      Array.isArray(s.verified_against_phase_indexes)
        ? s.verified_against_phase_indexes
            .map((x) => Number(x))
            .filter((n) => Number.isInteger(n))
        : [];

    return {
      section_id: typeof s.section_id === "string" ? s.section_id : `s${i + 1}`,
      story_role: typeof s.story_role === "string" ? s.story_role.trim() : "",
      text,
      plannedStart: rawStart,
      windowDuration,
      estimatedDuration: Math.max(1, countWords(text) / wordsPerSec),
      verified_against_phase_indexes
    };
  });

  // ── Step 2: trim sections that exceed their planned window ────────────────
  const trimmed = working.map((s) => {
    if (s.windowDuration === null || s.windowDuration <= 0) {
      return s; // no planned window — leave as-is, sequential placement will handle it
    }

    const overage = s.estimatedDuration - s.windowDuration;
    if (overage <= 1.0) {
      // Fits within 1s tolerance — check for large under-coverage and log
      const underage = s.windowDuration - s.estimatedDuration;
      if (underage > 5.0) {
        adjustments.push(
          `${s.section_id}: under window by ${underage.toFixed(1)}s — extension would improve coverage (deferred: requires LLM)`
        );
      }
      return s;
    }

    // Try trimming last sentence(s) until it fits or we hit the 3-sentence floor
    let sentences = splitSentences(s.text);
    let text = s.text;
    let estimatedDuration = s.estimatedDuration;
    let trimCount = 0;

    while (estimatedDuration > s.windowDuration + 0.5 && sentences.length > 3) {
      sentences = sentences.slice(0, -1);
      text = sentences.join(" ").trim();
      estimatedDuration = Math.max(1, countWords(text) / wordsPerSec);
      trimCount++;
    }

    if (trimCount > 0) {
      adjustments.push(
        `${s.section_id}: trimmed ${trimCount} sentence(s) — ${s.estimatedDuration.toFixed(1)}s → ${estimatedDuration.toFixed(1)}s (window ${s.windowDuration.toFixed(1)}s)`
      );
    } else {
      // Still over, but hit the 3-sentence floor
      adjustments.push(
        `${s.section_id}: over window by ${overage.toFixed(1)}s but at 3-sentence minimum — accepting over-run`
      );
    }

    const underage = s.windowDuration - estimatedDuration;
    if (underage > 5.0) {
      adjustments.push(
        `${s.section_id}: under window by ${underage.toFixed(1)}s after trim — extension deferred`
      );
    }

    return { ...s, text, estimatedDuration };
  });

  // ── Step 3: place sections, resolving overlaps by pushing forward ──────────
  /** @type {Array<{timestamp: number, end: number, text: string, section_id: string, story_role: string, narrativeOrderIndex: number, verified_against_phase_indexes: number[]}>} */
  const result = [];
  let cursor = 0;

  for (const s of trimmed) {
    const wantedStart = s.plannedStart !== null ? s.plannedStart : cursor;
    const timestamp = Math.max(wantedStart, cursor);

    if (timestamp > wantedStart + 0.1) {
      adjustments.push(
        `${s.section_id}: pushed ${wantedStart.toFixed(2)}s → ${timestamp.toFixed(2)}s (overlap)`
      );
    }

    // Drop if adjusted start is at/near video end
    if (timestamp >= videoDurationSeconds - 0.5) {
      adjustments.push(
        `${s.section_id}: dropped — adjusted start ${timestamp.toFixed(2)}s at/near video end (${videoDurationSeconds.toFixed(2)}s)`
      );
      continue;
    }

    const end = Math.min(timestamp + s.estimatedDuration, videoDurationSeconds);
    cursor = end + PASS5_SECTION_GAP_SEC;

    result.push({
      timestamp,
      end,
      text: s.text,
      section_id: s.section_id,
      story_role: s.story_role || "",
      verified_against_phase_indexes: s.verified_against_phase_indexes ?? [],
      narrativeOrderIndex: result.length
    });
  }

  // ── Step 4: coverage report and adjustment log ────────────────────────────
  const totalNarration = result.reduce((sum, s) => sum + (s.end - s.timestamp), 0);
  const coverage = videoDurationSeconds > 0 ? (totalNarration / videoDurationSeconds) * 100 : 0;

  if (adjustments.length > 0) {
    console.log(`[job ${jobId}] Pass5 adjustments (${adjustments.length}):`);
    adjustments.forEach((a) => console.warn(`[job ${jobId}]   ${a}`));
  }

  console.log(
    `[job ${jobId}] Pass5: ${result.length} sections placed, coverage=${coverage.toFixed(1)}%, wordsPerSec=${wordsPerSec}`
  );

  if (coverage < 80) {
    console.warn(`[job ${jobId}] Pass5: coverage ${coverage.toFixed(1)}% below 80% target`);
  }

  return result;
}

/**
 * @deprecated Pass 5 legacy validation — replaced by adaptScriptToTimeline.
 * Kept temporarily in case of rollback; not called in normal pipeline flow.
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

async function mergeVoiceoverScriptDebugAfterGrounding(
  tempDir,
  jobId,
  videoDurationSeconds,
  scriptSections,
  grounding,
  extras = {}
) {
  const fileName = "voiceover-script.json";
  const filePath = path.join(tempDir, fileName);
  /** @type {Record<string, unknown>} */
  let envelope;
  try {
    envelope = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    envelope = {
      jobId,
      videoDurationSeconds,
      passName: "Voiceover script",
      createdAt: new Date().toISOString(),
      rawModelOutput: null,
      parsedOutput: {},
      normalisedForNextStep: null
    };
  }
  const prevPo =
    envelope.parsedOutput && typeof envelope.parsedOutput === "object"
      ? /** @type {Record<string, unknown>} */ ({ .../** @type {Record<string, unknown>} */ (envelope.parsedOutput) })
      : {};
  envelope.jobId = jobId;
  envelope.videoDurationSeconds = videoDurationSeconds;
  if (typeof envelope.passName !== "string" || !envelope.passName.trim()) {
    envelope.passName = "Voiceover script";
  }
  envelope.parsedOutput = {
    ...prevPo,
    sections: scriptSections,
    schema_version: prevPo.schema_version,
    verification_index_repairs: Array.isArray(prevPo.verification_index_repairs)
      ? prevPo.verification_index_repairs
      : [],
    pass4_verification_warnings: Array.isArray(prevPo.pass4_verification_warnings)
      ? prevPo.pass4_verification_warnings
      : [],
    grounding_warnings: grounding.grounding_warnings,
    unsupported_claims_removed: grounding.unsupported_claims_removed,
    verification_phase_indexes_used: grounding.verification_phase_indexes_used,
    post_grounding_speech_density: extras.post_grounding_speech_density ?? prevPo.post_grounding_speech_density ?? null
  };
  await saveDebugRunFile(jobId, fileName, envelope);
  await fs.writeFile(filePath, JSON.stringify(envelope, null, 2), "utf8");
  console.log(`[job ${jobId}] pipeline debug artifact (post ground check): ${filePath}`);
}

/** Names of JSON files written for pipeline debugging; used to decide whether temp dir may be preserved. */
const PIPELINE_DEBUG_ARTIFACT_FILENAMES = [
  "visual-timeline.json",
  "coaching-interpretation.json",
  "visual-claim-verification.json",
  "narrative-plan.json",
  "voiceover-script.json",
  "final-narration-track.json",
  "final-audio-segments.json",
  "pass5-validated-script.json",
  "pass5-timing-adaptation.json",
  "pass1-timeline.json",
  "pass2-coaching-interpretation.json",
  "pass3-narrative-plan.json",
  "pass4-script.json",
  "pass4-continuous-script.json"
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
    const visionRoute = resolveVisionTimelineRoute({
      jobVisionProvider: job.metadata?.vision_provider,
      envVisionProvider: config.VISION_PROVIDER,
      geminiApiKey: config.GEMINI_API_KEY,
      videoDurationSeconds,
      geminiMaxVideoDurationSeconds: config.GEMINI_MAX_VIDEO_DURATION_SECONDS
    });

    console.log(`[job ${jobId}] VISION ROUTING SUMMARY`);
    console.log(
      `[job ${jobId}]   job.metadata.vision_provider: ${job.metadata?.vision_provider ?? "(unset)"}`
    );
    console.log(
      `[job ${jobId}]   env VISION_PROVIDER raw: "${String(process.env.VISION_PROVIDER ?? "").trim() || "(unset → default openai)"}"`
    );
    console.log(
      `[job ${jobId}]   configured provider (job/env/default): ${visionRoute.configuredProvider} (source: ${visionRoute.providerSource})`
    );
    console.log(
      `[job ${jobId}]   GEMINI_API_KEY: ${config.GEMINI_API_KEY?.trim() ? "present" : "absent"}`
    );
    console.log(
      `[job ${jobId}]   Gemini duration cap: ${config.GEMINI_MAX_VIDEO_DURATION_SECONDS}s; this clip: ${Number(videoDurationSeconds).toFixed(2)}s`
    );
    const geminiUnavailable = explainGeminiUnavailableForLogs(
      visionRoute,
      videoDurationSeconds,
      config.GEMINI_MAX_VIDEO_DURATION_SECONDS
    );
    if (geminiUnavailable) {
      console.log(`[job ${jobId}]   GEMINI FALLBACK REASON (log only): ${geminiUnavailable}`);
    }
    console.log(
      `[job ${jobId}]   Pass 1 will attempt Gemini: ${visionRoute.useGemini ? "yes" : "no"}`
    );

    console.log(`[job ${jobId}] VISION PROVIDER (attempt): ${visionRoute.useGemini ? "gemini" : "openai"}`);
    console.log(`[job ${jobId}] VISION PROVIDER SOURCE: ${visionRoute.providerSource}`);

    const analysisResult = await analyseFrames(frames, {
      participantDescription,
      videoDurationSeconds,
      pipelineDebug: {
        jobId,
        workspaceDir: tempDir,
        videoDurationSeconds
      },
      videoPath: safeInputPath,
      visionRoute
    });

    console.log(
      `[job ${jobId}] VISION TIMELINE PROVIDER USED: ${analysisResult.visionTimelineProviderUsed ?? "openai"}`
    );

    console.log(
      `[job ${jobId}] analyseFrames returned:`,
      JSON.stringify({
        hasUsage: Boolean(analysisResult?.usage),
        scriptSectionCount: analysisResult?.scriptSections?.length ?? 0,
        narrativeStyle: analysisResult?.narrativePlan?.narrative_style ?? "unknown"
      })
    );

    const participantInstructionRedo = participantDescription
      ? ` The practitioner you are analysing is identified by: ${participantDescription}. Focus all analysis on this person only. Do not coach their opponent.`
      : "";

    const phaseCnt = Math.max(
      1,
      Array.isArray(analysisResult.passOneAnalysis?.phases)
        ? analysisResult.passOneAnalysis.phases.length
        : 1
    );

    // Pass 5 — Timing Adaptation Agent
    // Writing came first; timing now adapts to the script's natural length.
    let scriptSections = Array.isArray(analysisResult?.scriptSections)
      ? analysisResult.scriptSections.map((s) => ({ ...s }))
      : [];

    const visualClaimVerification = analysisResult?.visualClaimVerification ?? null;

    let lastPreGroundWords = computeSpeechMetricsFromRenderedSections(
      scriptSections,
      countWords,
      videoDurationSeconds
    ).totalWordCount;

    let voiceoverGrounding = applyVoiceoverGrounding(jobId, scriptSections, visualClaimVerification);
    scriptSections = voiceoverGrounding.sections;

    let postGd = computeSpeechMetricsFromRenderedSections(scriptSections, countWords, videoDurationSeconds);

    console.log("VOICEOVER SCRIPT GROUNDING CHECK COMPLETE");
    console.log(`GROUNDING WARNINGS: ${voiceoverGrounding.grounding_warnings.length}`);
    console.log(`UNSUPPORTED CLAIMS REMOVED: ${voiceoverGrounding.unsupported_claims_removed.length}`);
    voiceoverGrounding.grounding_warnings.slice(0, 24).forEach((w) => console.warn(w));

    console.log("POST-GROUNDING SPEECH DENSITY COMPLETE");
    console.log(`PRE-GROUNDING WORD COUNT: ${lastPreGroundWords}`);
    console.log(`POST-GROUNDING WORD COUNT: ${postGd.totalWordCount}`);
    console.log(`WORDS REMOVED BY GROUNDING: ${lastPreGroundWords - postGd.totalWordCount}`);
    console.log(`ESTIMATED POST-GROUNDING SPEECH SECONDS: ${postGd.estimatedFinalSpeechSeconds.toFixed(2)}`);
    console.log(`ESTIMATED POST-GROUNDING COVERAGE PCT: ${postGd.estimatedFinalCoveragePct.toFixed(1)}%`);
    console.log(`FINAL COVERAGE (word estimate): ${postGd.estimatedFinalCoveragePct.toFixed(1)}%`);
    console.log(`FINAL WORD COUNT: ${postGd.totalWordCount}`);
    console.log(`UNSUPPORTED CLAIMS REMOVED: ${voiceoverGrounding.unsupported_claims_removed.length}`);

    const mergeGroundingExtras = () => ({
      post_grounding_speech_density: {
        pre_grounding_word_count: lastPreGroundWords,
        post_grounding_word_count: postGd.totalWordCount,
        words_removed_by_grounding: lastPreGroundWords - postGd.totalWordCount,
        estimated_post_grounding_speech_seconds: postGd.estimatedFinalSpeechSeconds,
        estimated_post_grounding_coverage_pct: postGd.estimatedFinalCoveragePct,
        per_section_words: postGd.perSectionWords
      }
    });

    const MAX_GROUNDING_SALVAGE = 3;
    /** @type {number[]} boosts applied in order per salvage attempt (multiply current plan targets). */
    const GROUNDING_TARGET_SCALE_STEPS = [1.28, 1.24, 1.2];
    let groundingSalvageIdx = 0;

    while (
      Number.isFinite(postGd.estimatedFinalCoveragePct) &&
      videoDurationSeconds > 20 &&
      postGd.estimatedFinalCoveragePct < 70 &&
      groundingSalvageIdx < MAX_GROUNDING_SALVAGE
    ) {
      groundingSalvageIdx += 1;
      const scaleStep = GROUNDING_TARGET_SCALE_STEPS[groundingSalvageIdx - 1] ?? 1.18;
      scaleNarrativePlanTargetWords(analysisResult.narrativePlan, scaleStep);

      console.warn(
        `[job ${jobId}] Grounded narration coverage ${postGd.estimatedFinalCoveragePct.toFixed(
          1
        )}% < 70% — salvage pass ${groundingSalvageIdx}/${MAX_GROUNDING_SALVAGE} after scaling narrative target_words × ${scaleStep} then strict Pass 4 reground.`
      );

      let llmUsage = analysisResult.usage;
      const reg = await rerunPassFourAfterGroundingLoss({
        videoDurationSeconds,
        timeline: analysisResult.passOneAnalysis,
        coaching: analysisResult.coachingInterpretation,
        visualClaimVerification,
        narrativePlan: analysisResult.narrativePlan,
        participantInstruction: participantInstructionRedo,
        phaseCount: phaseCnt
      });
      llmUsage.pass4PromptTokens += reg.passFour.promptTokensTotal;
      llmUsage.pass4CompletionTokens += reg.passFour.completionTokensTotal;
      llmUsage.pass4CostUsd += reg.passFour.costTotal;

      analysisResult.usage = llmUsage;
      scriptSections = Array.isArray(reg.scriptPayload?.sections)
        ? reg.scriptPayload.sections.map((s) => ({ ...s }))
        : scriptSections;

      lastPreGroundWords = computeSpeechMetricsFromRenderedSections(
        scriptSections,
        countWords,
        videoDurationSeconds
      ).totalWordCount;

      voiceoverGrounding = applyVoiceoverGrounding(jobId, scriptSections, visualClaimVerification);
      scriptSections = voiceoverGrounding.sections;

      console.log(
        `GROUNDING WARNINGS (after salvage ${groundingSalvageIdx}): ${voiceoverGrounding.grounding_warnings.length}`
      );
      console.log(
        `UNSUPPORTED CLAIMS REMOVED (after salvage ${groundingSalvageIdx}): ${voiceoverGrounding.unsupported_claims_removed.length}`
      );

      postGd = computeSpeechMetricsFromRenderedSections(scriptSections, countWords, videoDurationSeconds);

      console.log(`POST-GROUNDING SPEECH DENSITY COMPLETE (salvage pass ${groundingSalvageIdx})`);
      console.log(`PRE-GROUNDING WORD COUNT: ${lastPreGroundWords}`);
      console.log(`POST-GROUNDING WORD COUNT: ${postGd.totalWordCount}`);
      console.log(`WORDS REMOVED BY GROUNDING: ${lastPreGroundWords - postGd.totalWordCount}`);
      console.log(`ESTIMATED POST-GROUNDING COVERAGE PCT: ${postGd.estimatedFinalCoveragePct.toFixed(1)}%`);
    }

    if (
      Number.isFinite(postGd.estimatedFinalCoveragePct) &&
      videoDurationSeconds > 20 &&
      postGd.estimatedFinalCoveragePct < 70
    ) {
      throw new Error(
        `Grounded script coverage below 70% after unsupported claims removed (target 80%) — final ${postGd.estimatedFinalCoveragePct.toFixed(1)}%`
      );
    }

    await mergeVoiceoverScriptDebugAfterGrounding(
      tempDir,
      jobId,
      videoDurationSeconds,
      scriptSections,
      voiceoverGrounding,
      mergeGroundingExtras()
    );

    const passOneAnalysis = analysisResult?.passOneAnalysis ?? null;
    const coachingInterpretation = analysisResult?.coachingInterpretation ?? null;
    const narrationPlan = analysisResult?.narrativePlan ?? analysisResult?.narrationPlan ?? null;

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

    const useLegacyTimestampedAssembly =
      job.metadata?.narration_assembly === "legacy_timestamped";

    console.log(
      `[job ${jobId}] narration assembly mode: ${useLegacyTimestampedAssembly ? "legacy_timestamped" : "continuous_concat"}`
    );

    const voiceKey = job.metadata?.tts_voice_key || DEFAULT_VOICE_KEY;
    const voiceDbg = getTtsVoiceDebugInfo(voiceKey);
    console.log(
      `[job ${jobId}] TTS voice read: metadata.tts_voice_key=${job.metadata?.tts_voice_key ?? "unset"} → effective voiceKey=${voiceKey} (DEFAULT_VOICE_KEY=${DEFAULT_VOICE_KEY})`,
      voiceDbg
    );

    const ttsUsage = createTtsUsageTracker();

    /** @type {{ segmentsDropped: number, segmentsPushed: number, segmentDetails: Array<{ finalTimestamp: number, originalTimestamp: number, ttsDurationSeconds: number }> }} */
    let passThreeMeta;
    /** Narration AAC from assembleNarrationTrack — delete after stitch in continuous mode. */
    let continuousNarrationPath = /** @type {string | null} */ (null);
    /** For legacy mode only — timestamp-placed snippets for stitchAudioOntoVideo. */
    let segmentsForLegacyStitch = /** @type {Array<{ path: string, timestamp: number }>} */ ([]);
    let adaptedSegments;
    let ttsDensityRepairPasses = 0;

    const clearAudioDirMp3 = async () => {
      try {
        const ents = await fs.readdir(audioDir);
        await Promise.all(
          ents.filter((name) => name.endsWith(".mp3")).map((name) => fs.rm(path.join(audioDir, name), { force: true }))
        );
      } catch {
        /* empty */
      }
    };

    for (;;) {
      adaptedSegments = adaptScriptToTimeline(
        jobId,
        scriptSections,
        videoDurationSeconds,
        TIMING_WORDS_PER_SECOND
      );

      const narrationSegments = adaptedSegments.map((s, idx) => ({
        timestamp: s.timestamp,
        text: s.text,
        section_id: s.section_id,
        story_role: s.story_role ?? "",
        narrativeOrderIndex: idx
      }));

      await writeJobPipelineDebugFile(
        tempDir,
        jobId,
        videoDurationSeconds,
        "pass5-timing-adaptation.json",
        "Pass 5 — Timing Adaptation Agent",
        {
          rawModelOutput: null,
          parsedOutput: {
            scriptSections: scriptSections.map((s) => ({
              section_id: s.section_id,
              story_role: s.story_role,
              word_count: s.word_count,
              text_preview: String(s.text || "").slice(0, 80)
            }))
          },
          normalisedForNextStep: {
            adaptedSegments: adaptedSegments.map((s) => ({
              timestamp: s.timestamp,
              end: s.end,
              text_preview: s.text.slice(0, 80)
            })),
            wordsPerSecond: NARRATION_WORDS_PER_SECOND
          }
        }
      );

      console.log(
        `[job ${jobId}] narration segment starts (post Pass5):`,
        narrationSegments.map((s) => ({ timestamp: s.timestamp, text: s.text?.slice(0, 40) }))
      );

      await clearAudioDirMp3();

      /** @type {Array<{ timestamp: number, path: string, section_id?: string, story_role?: string, narrativeOrderIndex: number }>} */
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
          path: audioPath,
          section_id: segment.section_id,
          story_role: segment.story_role,
          narrativeOrderIndex: segment.narrativeOrderIndex
        });
      }

      console.log(
        `[job ${jobId}] audioSegments after TTS (${audioSegments.length} clips):`,
        audioSegments.map((s) => ({ path: s.path, timestamp: s.timestamp }))
      );

      /** @type {{ validationPassed: boolean, validationFailureReason: string | null, actualSpeechCoveragePct?: number, trailingSilenceSeconds?: number, finalSpeechEndSeconds?: number, totalActualSpeechSeconds?: number, totalInterSectionSilenceSeconds?: number }} */
      let ttsCovSummary;

      if (useLegacyTimestampedAssembly) {
        const { segments: validatedSegments, passThreeMeta: meta } = await validatePassThreeTiming(
          jobId,
          audioSegments,
          videoDurationSeconds,
          PASS3_GAP_SECONDS
        );
        passThreeMeta = meta;
        segmentsForLegacyStitch = validatedSegments;

        const legMet = buildLegacyTtsCoverageMetrics(passThreeMeta, videoDurationSeconds);
        const legFails = evaluateLegacyTtsCoverage(legMet);
        const validationPassed = legFails.length === 0;
        const validationFailureReason = legFails.length ? legFails.join(" ") : null;

        ttsCovSummary = {
          validationPassed,
          validationFailureReason,
          actualSpeechCoveragePct: legMet.actualSpeechCoveragePct,
          trailingSilenceSeconds: legMet.trailingSilenceSeconds,
          finalSpeechEndSeconds: legMet.finalSpeechEndSeconds,
          totalActualSpeechSeconds: legMet.totalActualSpeechSeconds,
          totalInterSectionSilenceSeconds: legMet.totalInterSectionSilenceSeconds
        };

        await writeJobPipelineDebugFile(
          tempDir,
          jobId,
          videoDurationSeconds,
          "final-audio-segments.json",
          "Final audio segments (after Pass 6 timing placement, for stitch)",
          {
            rawModelOutput: null,
            parsedOutput: {
              assemblyMode: "legacy_timestamped",
              afterTtsBeforePlacement: audioSegments.map((s) => ({
                path: s.path,
                timestamp: s.timestamp,
                narrativeOrderIndex: s.narrativeOrderIndex,
                section_id: s.section_id
              })),
              tts_coverage_validation: ttsCovSummary
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

        console.log(
          `[job ${jobId}] Pass 6 post-TTS placement — videoDurationSeconds=${videoDurationSeconds}, validatedClipCount=${validatedSegments.length}`
        );
      } else {
        const continuousOut = path.join(tempDir, "narration_continuous.m4a");
        const { outputPath: assembledPath, report } = await assembleNarrationTrack(
          jobId,
          audioSegments.map((s) => ({
            path: s.path,
            originalStart: s.timestamp,
            narrativeOrderIndex: s.narrativeOrderIndex ?? 0,
            section_id: s.section_id,
            story_role: s.story_role
          })),
          videoDurationSeconds,
          config.VIDEO_PLAYBACK_SPEED,
          continuousOut,
          tempDir
        );
        continuousNarrationPath = assembledPath;

        passThreeMeta = {
          segmentsDropped: Number(report.sectionsDropped) || 0,
          segmentsPushed: 0,
          segmentDetails: report.sections.map((sec) => ({
            finalTimestamp: sec.trackStartSeconds,
            originalTimestamp: sec.originalStart,
            ttsDurationSeconds: sec.audioDurationSeconds
          }))
        };

        const contMet = buildContinuousTtsCoverageMetrics(
          /** @type {Record<string, unknown>} */ (report),
          videoDurationSeconds,
          config.VIDEO_PLAYBACK_SPEED
        );
        const contFails = evaluateContinuousTtsCoverage(contMet);
        const validationPassed = contFails.length === 0;
        const validationFailureReason = contFails.length ? contFails.join(" ") : null;

        ttsCovSummary = {
          validationPassed,
          validationFailureReason,
          actualSpeechCoveragePct: contMet.actualSpeechCoveragePct,
          trailingSilenceSeconds: contMet.trailingSilenceSeconds,
          finalSpeechEndSeconds: contMet.finalSpeechEndSeconds,
          totalActualSpeechSeconds: contMet.totalActualSpeechSeconds,
          totalInterSectionSilenceSeconds: contMet.totalInterSectionSilenceSeconds
        };

        /** @type {Record<string, unknown>} */
        const parsedTrackOutput = {
          .../** @type {Record<string, unknown>} */ (report),
          totalActualSpeechSeconds: contMet.totalActualSpeechSeconds,
          totalInterSectionSilenceSeconds: contMet.totalInterSectionSilenceSeconds,
          finalSpeechEndSeconds: contMet.finalSpeechEndSeconds,
          actualSpeechCoveragePct: contMet.actualSpeechCoveragePct,
          trailingSilenceSeconds: contMet.trailingSilenceSeconds,
          validationPassed,
          validationFailureReason
        };

        await writeJobPipelineDebugFile(tempDir, jobId, videoDurationSeconds, "final-narration-track.json", "Final continuous narration track", {
          rawModelOutput: null,
          parsedOutput: parsedTrackOutput,
          normalisedForNextStep: null
        });

        await writeJobPipelineDebugFile(
          tempDir,
          jobId,
          videoDurationSeconds,
          "final-audio-segments.json",
          "Final audio segments (continuous concat assembly)",
          {
            rawModelOutput: null,
            parsedOutput: {
              assemblyMode: "continuous_concat",
              afterTtsBeforePlacement: audioSegments.map((s) => ({
                path: s.path,
                timestampHintOrderingOnly: s.timestamp,
                narrativeOrderIndex: s.narrativeOrderIndex,
                section_id: s.section_id
              })),
              tts_coverage_validation: ttsCovSummary
            },
            normalisedForNextStep: {
              narrationTrackSummary: report
            }
          }
        );

        console.log(
          `[job ${jobId}] Continuous narration track ready — speechSegments=${audioSegments.length}, dropsDuringFit=${passThreeMeta.segmentsDropped}`
        );
      }

      console.log("FINAL TTS COVERAGE CHECK");
      console.log(`ACTUAL SPEECH COVERAGE: ${(ttsCovSummary.actualSpeechCoveragePct ?? 0).toFixed(1)}%`);
      console.log(`TRAILING SILENCE: ${(ttsCovSummary.trailingSilenceSeconds ?? 0).toFixed(2)}s`);
      console.log(`FINAL SPEECH END: ${(ttsCovSummary.finalSpeechEndSeconds ?? 0).toFixed(2)}s`);
      console.log(`VALIDATION PASSED: ${ttsCovSummary.validationPassed ? "yes" : "no"}`);

      if (ttsCovSummary.validationPassed) {
        break;
      }

      if (ttsDensityRepairPasses >= 2 || audioSegments.length === 0) {
        throw new Error(ttsCovSummary.validationFailureReason || "TTS coverage validation failed");
      }

      ttsDensityRepairPasses += 1;
      continuousNarrationPath = null;
      const scaleFactor = ttsDensityRepairPasses === 1 ? 1.2 : 1.32;
      console.warn(
        `[job ${jobId}] TTS density repair pass ${ttsDensityRepairPasses}/2 — rerunning Voiceover Script (scale target_words × ${scaleFactor}).`
      );

      let rusage = analysisResult.usage;
      const repair = await rerunPassFourForTtsDensityRepair(
        {
          videoDurationSeconds,
          timeline: analysisResult.passOneAnalysis,
          coaching: analysisResult.coachingInterpretation,
          visualClaimVerification,
          narrativePlan: analysisResult.narrativePlan,
          participantInstruction: participantInstructionRedo,
          phaseCount: phaseCnt
        },
        { scaleFactor }
      );
      rusage.pass4PromptTokens += repair.passFour.promptTokensTotal;
      rusage.pass4CompletionTokens += repair.passFour.completionTokensTotal;
      rusage.pass4CostUsd += repair.passFour.costTotal;
      analysisResult.usage = rusage;

      scriptSections = Array.isArray(repair.scriptPayload?.sections)
        ? repair.scriptPayload.sections.map((s) => ({ ...s }))
        : scriptSections;

      lastPreGroundWords = computeSpeechMetricsFromRenderedSections(
        scriptSections,
        countWords,
        videoDurationSeconds
      ).totalWordCount;
      voiceoverGrounding = applyVoiceoverGrounding(jobId, scriptSections, visualClaimVerification);
      scriptSections = voiceoverGrounding.sections;
      postGd = computeSpeechMetricsFromRenderedSections(scriptSections, countWords, videoDurationSeconds);

      await mergeVoiceoverScriptDebugAfterGrounding(
        tempDir,
        jobId,
        videoDurationSeconds,
        scriptSections,
        voiceoverGrounding,
        mergeGroundingExtras()
      );

      console.log("[TTS density repair] POST-GROUNDING SPEECH DENSITY COMPLETE");
      console.log(`PRE-GROUNDING WORD COUNT: ${lastPreGroundWords}`);
      console.log(`POST-GROUNDING WORD COUNT: ${postGd.totalWordCount}`);
      console.log(`WORDS REMOVED BY GROUNDING: ${lastPreGroundWords - postGd.totalWordCount}`);
    }

    let qaUsage = {
      pass5PromptTokens: 0,
      pass5CompletionTokens: 0,
      pass5CostUsd: 0
    };

    try {
      const passThreeSegmentDetails = passThreeMeta.segmentDetails.map((s) => ({
        timestamp: s.finalTimestamp,
        duration: s.ttsDurationSeconds
      }));
      let coverageMetrics = buildCoverageMetrics(videoDurationSeconds, passThreeSegmentDetails);
      coverageMetrics = augmentCoverageForNarrative(
        coverageMetrics,
        narrationPlan,
        adaptedSegments,
        videoDurationSeconds
      );

      const finalVoiceoverForQa = adaptedSegments.map((s) => ({
        start: s.timestamp,
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
        passFiveAdjustments: [],
        coverageMetrics
      });
      coverageMetrics = {
        ...coverageMetrics,
        qa_coaching_subscores: {
          actionable_feedback: qaResult.actionable_feedback,
          improvement_identified: qaResult.improvement_identified
        }
      };
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
      if (useLegacyTimestampedAssembly) {
        await stitchAudioOntoVideo(
          jobId,
          safeInputPath,
          segmentsForLegacyStitch,
          outputPath,
          config.VIDEO_PLAYBACK_SPEED
        );
      } else if (continuousNarrationPath) {
        await stitchVideoWithPremadeNarrationTrack(
          jobId,
          safeInputPath,
          continuousNarrationPath,
          outputPath,
          config.VIDEO_PLAYBACK_SPEED
        );
      } else {
        await stitchAudioOntoVideo(jobId, safeInputPath, [], outputPath, config.VIDEO_PLAYBACK_SPEED);
      }
    } catch (stitchErr) {
      console.error(
        `[job ${jobId}] stitch failed: ${stitchErr?.message ?? stitchErr}. Exporting video without narration mix.`
      );
      await updateJob(jobId, {
        progress: "Commentary mix failed — exporting video without narration"
      });
      await stitchAudioOntoVideo(jobId, safeInputPath, [], outputPath, config.VIDEO_PLAYBACK_SPEED);
    } finally {
      if (!useLegacyTimestampedAssembly && continuousNarrationPath) {
        await fs.rm(continuousNarrationPath, { force: true }).catch(() => {});
      }
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
        `[job ${jobId}] COST ALERT: total pipeline ≈ $${totalCostUsd.toFixed(4)} USD vs historical baseline ~£0.31 (≈ $${PIPELINE_COST_BASELINE_USD} USD — rough FX; LLM timeline + coaching + verification + narrative + script + QA + TTS).`
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
        : null,
      provider: analysisResult.visionTimelineProviderUsed ?? "openai"
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
    console.error(`[job ${jobId}] processing failed (detail in logs above):`, error);
    await updateJob(jobId, {
      status: "failed",
      progress: "Failed",
      error_message: toPublicJobErrorMessage(error)
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

/** Continuous narration: short pauses between sections (Pass 5 starts are ordering hints only). */
const CONTINUOUS_SILENCE_MIN_SEC = 1.5;
const CONTINUOUS_SILENCE_MAX_SEC = 3;
const CONTINUOUS_SILENCE_DEFAULT_SEC = 2.25;

function concatDemuxerFileLine(absPath) {
  const p = path.resolve(absPath).replace(/\\/g, "/");
  return `file '${p.replace(/'/g, "'\\''")}'`;
}

function sumArr(nums) {
  return nums.reduce((a, b) => a + b, 0);
}

/** @param {string} jobId @param {number} durationSec @param {string} outPath */
async function writeSilenceMp3WithFfmpeg(jobId, durationSec, outPath) {
  const d = Math.max(0.02, Number(durationSec) || 0.02);
  await new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(`anullsrc=r=44100:cl=mono`)
      .inputFormat("lavfi")
      .inputOptions(["-t", d.toFixed(4)])
      .audioCodec("libmp3lame")
      .audioBitrate(128)
      .outputOptions(["-y"])
      .output(outPath);
    const getStderr = attachFfmpegDiagnostics(jobId, "continuous-silence-mp3", cmd);
    cmd
      .on("end", resolve)
      .on("error", (err) => {
        const stderr = getStderr();
        if (stderr) {
          console.error(`[job ${jobId}] continuous-silence-mp3 stderr:\n${stderr.slice(-4000)}`);
        }
        reject(err);
      })
      .run();
  });
}

/**
 * @param {string} jobId
 * @param {string[]} orderedAbsPaths
 * @param {string} outputAacPath
 */
async function concatAudioFilesToAacWithDemuxer(jobId, orderedAbsPaths, outputAacPath) {
  const listPath = path.join(path.dirname(outputAacPath), `concat_list_${jobId.slice(0, 8)}.txt`);
  await fs.writeFile(listPath, orderedAbsPaths.map(concatDemuxerFileLine).join("\n"), "utf8");
  await new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(listPath)
      .inputOptions(["-f", "concat", "-safe", "0"])
      .outputOptions(["-y", "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "1"])
      .output(outputAacPath);
    const getStderr = attachFfmpegDiagnostics(jobId, "continuous-concat-demuxer", cmd);
    cmd
      .on("end", resolve)
      .on("error", (err) => {
        const stderr = getStderr();
        if (stderr) {
          console.error(`[job ${jobId}] continuous-concat-demuxer stderr:\n${stderr.slice(-8000)}`);
        }
        reject(err);
      })
      .run();
  });
  await fs.rm(listPath, { force: true }).catch(() => {});
}

/**
 * Fallback: filter concat (linear) — no adelay/amix; used if concat demuxer fails.
 * @param {string} jobId
 * @param {string[]} orderedAbsPaths
 * @param {string} outputAacPath
 */
async function concatAudioFilesToAacWithFilter(jobId, orderedAbsPaths, outputAacPath) {
  const command = ffmpeg();
  for (const p of orderedAbsPaths) {
    command.input(p);
  }
  const n = orderedAbsPaths.length;
  const norm = [];
  for (let i = 0; i < n; i += 1) {
    norm.push(
      `[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono[a${i}]`
    );
  }
  const ins = Array.from({ length: n }, (_, i) => `[a${i}]`).join("");
  const graph = [...norm, `${ins}concat=n=${n}:v=0:a=1[outa]`];
  await new Promise((resolve, reject) => {
    const getStderr = attachFfmpegDiagnostics(jobId, "continuous-concat-filter", command);
    command
      .complexFilter(graph)
      .outputOptions(["-y", "-map", "[outa]", "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "1"])
      .output(outputAacPath)
      .on("end", resolve)
      .on("error", (err) => {
        const stderr = getStderr();
        if (stderr) {
          console.error(`[job ${jobId}] continuous-concat-filter stderr:\n${stderr.slice(-8000)}`);
        }
        reject(err);
      })
      .run();
  });
}

/**
 * One continuous narration AAC: section clips + planned short silences + optional trailing silence.
 * Pass 5 `originalStart` is ordering hint only; first audio starts at 0 on the track.
 *
 * @param {string} jobId
 * @param {Array<{ path: string, originalStart: number, narrativeOrderIndex: number, section_id?: string, story_role?: string }>} audioSections
 * @param {number} videoDurationSeconds
 * @param {number} playbackSpeed
 * @param {string} outputPath - absolute .m4a/.aac path
 * @param {string} tempDir
 * @returns {Promise<{ outputPath: string, report: Record<string, unknown> }>}
 */
async function assembleNarrationTrack(
  jobId,
  audioSections,
  videoDurationSeconds,
  playbackSpeed,
  outputPath,
  tempDir
) {
  const vdOut = videoDurationSeconds / Math.max(0.01, Number(playbackSpeed) || 1);
  const silenceCache = new Map();

  const getSilenceFile = async (seconds) => {
    const s = Math.max(CONTINUOUS_SILENCE_MIN_SEC, Math.min(CONTINUOUS_SILENCE_MAX_SEC, seconds));
    const key = `${Math.round(s * 1000)}`;
    if (silenceCache.has(key)) {
      return /** @type {string} */ (silenceCache.get(key));
    }
    const p = path.join(tempDir, `gap_silence_${key}ms.mp3`);
    await writeSilenceMp3WithFfmpeg(jobId, s, p);
    silenceCache.set(key, p);
    return p;
  };

  if (!audioSections.length) {
    const sp = path.join(tempDir, `full_silence_${jobId.slice(0, 8)}.mp3`);
    await writeSilenceMp3WithFfmpeg(jobId, vdOut, sp);
    try {
      await concatAudioFilesToAacWithDemuxer(jobId, [sp], outputPath);
    } catch {
      await concatAudioFilesToAacWithFilter(jobId, [sp], outputPath);
    }
    const actual = await getAudioDurationSeconds(outputPath);
    const report = {
      mode: "continuous_concat",
      videoDurationSeconds,
      sections: [],
      totalSpeechSeconds: 0,
      totalSilenceBetweenSections: 0,
      expectedNarrationDurationSeconds: vdOut,
      actualNarrationDurationSeconds: Math.round(actual * 1000) / 1000,
      coveragePct: 0,
      maxSilenceBetweenSections: 0,
      sectionsDropped: 0
    };
    return { outputPath, report };
  }

  const sorted = [...audioSections].sort((a, b) => {
    const diff = a.originalStart - b.originalStart;
    if (Math.abs(diff) > 1e-3) return diff;
    return (a.narrativeOrderIndex ?? 0) - (b.narrativeOrderIndex ?? 0);
  });

  /** @type {{ path: string, originalStart: number, narrativeOrderIndex: number, section_id: string, story_role: string, audioDurationSeconds: number }[]} */
  const measured = await Promise.all(
    sorted.map(async (s) => ({
      path: s.path,
      originalStart: s.originalStart,
      narrativeOrderIndex: s.narrativeOrderIndex,
      section_id: typeof s.section_id === "string" ? s.section_id : "",
      story_role: typeof s.story_role === "string" ? s.story_role : "",
      audioDurationSeconds: await getAudioDurationSeconds(s.path)
    }))
  );

  let sectionsDropped = 0;
  let durations = measured.map((m) => m.audioDurationSeconds);
  let paths = measured.map((m) => m.path);
  let metas = measured.map((m) => ({
    originalStart: m.originalStart,
    narrativeOrderIndex: m.narrativeOrderIndex,
    section_id: m.section_id,
    story_role: m.story_role
  }));

  const resetSilences = (n) =>
    Array.from({ length: Math.max(0, n - 1) }, () => CONTINUOUS_SILENCE_DEFAULT_SEC);
  let silences = resetSilences(durations.length);

  const contentLen = () => sumArr(durations) + sumArr(silences);

  const shrinkSilences = () => {
    let guard = 0;
    while (contentLen() > vdOut + 1e-3 && guard < 10000) {
      guard += 1;
      let progressed = false;
      for (let i = 0; i < silences.length; i += 1) {
        if (silences[i] > CONTINUOUS_SILENCE_MIN_SEC + 1e-6 && contentLen() > vdOut + 1e-3) {
          const over = contentLen() - vdOut;
          const take = Math.min(silences[i] - CONTINUOUS_SILENCE_MIN_SEC, over);
          if (take > 1e-6) {
            silences[i] -= take;
            progressed = true;
          }
        }
      }
      if (!progressed) {
        break;
      }
    }
  };

  while (contentLen() > vdOut + 0.15 && durations.length >= 3) {
    shrinkSilences();
    if (contentLen() <= vdOut + 0.15) break;
    let bestI = -1;
    let bestDur = Infinity;
    for (let i = 1; i < durations.length - 1; i += 1) {
      if (durations[i] < bestDur) {
        bestDur = durations[i];
        bestI = i;
      }
    }
    if (bestI < 0) break;
    console.warn(
      `[job ${jobId}] continuous narration: dropping middle section index ${bestI} (${metas[bestI]?.section_id ?? "?"}) to fit video duration`
    );
    durations.splice(bestI, 1);
    paths.splice(bestI, 1);
    metas.splice(bestI, 1);
    sectionsDropped += 1;
    silences = resetSilences(durations.length);
  }

  shrinkSilences();

  if (contentLen() > vdOut + 0.5) {
    throw new Error(
      `[job ${jobId}] continuous narration: speech+pauses (${contentLen().toFixed(2)}s) still exceed video budget ${vdOut.toFixed(2)}s after silence trim and middle drops`
    );
  }

  let trailingSilenceSec = Math.max(0, vdOut - contentLen());

  const totalSpeechSeconds = Math.round(sumArr(durations) * 1000) / 1000;
  const totalSilenceBetweenSections = Math.round(sumArr(silences) * 1000) / 1000;
  const maxSilenceBetweenSections =
    silences.length > 0 ? Math.round(Math.max(...silences) * 1000) / 1000 : 0;

  /** @type {Record<string, unknown>[]} */
  const sectionReport = [];
  const orderedFiles = [];
  let cursor = 0;
  for (let i = 0; i < durations.length; i += 1) {
    const trackStartSeconds = Math.round(cursor * 1000) / 1000;
    const dur = durations[i];
    const trackEndSeconds = Math.round((cursor + dur) * 1000) / 1000;
    const plannedAfter =
      i < silences.length ? Math.round(silences[i] * 1000) / 1000 : 0;
    sectionReport.push({
      index: i,
      originalStart: Math.round(metas[i].originalStart * 1000) / 1000,
      audioPath: paths[i],
      audioDurationSeconds: Math.round(dur * 1000) / 1000,
      plannedSilenceAfterSeconds: plannedAfter,
      trackStartSeconds,
      trackEndSeconds
    });
    orderedFiles.push(paths[i]);
    cursor = trackEndSeconds;
    if (i < silences.length) {
      const gapFile = await getSilenceFile(silences[i]);
      orderedFiles.push(gapFile);
      cursor += silences[i];
    }
  }

  if (trailingSilenceSec > 0.05) {
    const tailPath = path.join(tempDir, `trailing_silence_${jobId.slice(0, 8)}.mp3`);
    await writeSilenceMp3WithFfmpeg(jobId, trailingSilenceSec, tailPath);
    orderedFiles.push(tailPath);
  }

  const expectedNarrationDurationSeconds =
    Math.round((totalSpeechSeconds + totalSilenceBetweenSections + trailingSilenceSec) * 1000) / 1000;

  try {
    await concatAudioFilesToAacWithDemuxer(jobId, orderedFiles, outputPath);
  } catch (demuxErr) {
    console.warn(
      `[job ${jobId}] concat demuxer failed (${demuxErr.message}); retrying with filter concat`
    );
    await concatAudioFilesToAacWithFilter(jobId, orderedFiles, outputPath);
  }

  const actualNarrationDurationSeconds = Math.round((await getAudioDurationSeconds(outputPath)) * 1000) / 1000;
  const baselineNoTrailing = totalSpeechSeconds + totalSilenceBetweenSections;
  if (
    baselineNoTrailing > 1e-3 &&
    actualNarrationDurationSeconds + 0.05 < baselineNoTrailing - 15
  ) {
    throw new Error(
      `[job ${jobId}] continuous narration integrity check failed: actual track ${actualNarrationDurationSeconds}s is >15s shorter than speech+inter pauses (${baselineNoTrailing.toFixed(2)}s) — possible concat drop`
    );
  }

  const coveragePct =
    videoDurationSeconds > 1e-6
      ? Math.round((totalSpeechSeconds / videoDurationSeconds) * 1000) / 10
      : 0;

  const report = {
    mode: "continuous_concat",
    videoDurationSeconds,
    sections: sectionReport,
    totalSpeechSeconds,
    totalSilenceBetweenSections,
    expectedNarrationDurationSeconds,
    actualNarrationDurationSeconds,
    coveragePct,
    maxSilenceBetweenSections,
    sectionsDropped
  };

  console.log("CONTINUOUS NARRATION TRACK BUILT");
  console.log(`TOTAL SPEECH SECONDS: ${totalSpeechSeconds}`);
  console.log(`EXPECTED NARRATION DURATION: ${expectedNarrationDurationSeconds}`);
  console.log(`ACTUAL NARRATION DURATION: ${actualNarrationDurationSeconds}`);
  console.log(`COVERAGE PCT: ${coveragePct}`);
  console.log(`MAX SILENCE BETWEEN SECTIONS: ${maxSilenceBetweenSections}`);
  console.log(`SECTIONS DROPPED: ${sectionsDropped}`);

  return { outputPath, report };
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

/**
 * **Legacy:** build narration track timelined by Pass‑6 placements (silence pads from timestamps).
 * Uses filter concat (NOT adelay/amix graph). Prefer `assembleNarrationTrack` + `stitchVideoWithPremadeNarrationTrack`.
 *
 * @param {string} jobId
 * @param {Array<{path: string, timestamp: number}>} audioSegments
 * @param {number} videoDurationSeconds
 * @param {number} playbackSpeed
 * @param {string} tempDir - directory for the output file
 * @returns {Promise<string>} absolute path to the assembled narration_track.aac
 */
async function buildTimestampedNarrationTrackLegacy(jobId, audioSegments, videoDurationSeconds, playbackSpeed, tempDir) {
  const sorted = [...audioSegments].sort((a, b) => a.timestamp - b.timestamp);

  // Probe actual duration of each TTS clip
  const withDur = await Promise.all(
    sorted.map(async (seg) => ({
      path: seg.path,
      adjustedTimestamp: seg.timestamp / playbackSpeed,
      durationSec: await getAudioDurationSeconds(seg.path)
    }))
  );

  // Build ordered pieces: silence gaps + audio segments
  // Each piece is either { type: 'silence', durationSec } or { type: 'audio', path }
  const pieces = [];
  let cursor = 0;

  for (const seg of withDur) {
    const gap = seg.adjustedTimestamp - cursor;
    if (gap > 0.05) {
      pieces.push({ type: "silence", durationSec: gap });
    } else if (gap < -0.05) {
      console.warn(
        `[job ${jobId}] narration track: segment at ${seg.adjustedTimestamp.toFixed(2)}s overlaps cursor at ${cursor.toFixed(2)}s — clamping`
      );
    }
    pieces.push({ type: "audio", path: seg.path });
    cursor = Math.max(cursor, seg.adjustedTimestamp) + seg.durationSec;
  }

  // Trailing silence to reach video duration (single concat output)
  const videoDurAdjusted = videoDurationSeconds / playbackSpeed;
  const trailing = videoDurAdjusted - cursor;
  if (trailing > 0.1) {
    pieces.push({ type: "silence", durationSec: trailing });
  }

  const narrationPath = path.join(tempDir, "narration_track.aac");
  const command = ffmpeg();
  let inputIdx = 0;
  const inputLabels = [];

  for (const piece of pieces) {
    if (piece.type === "silence") {
      // aevalsrc generates silence; d= sets duration, s= sample rate, c= channel layout
      const dur = piece.durationSec.toFixed(3);
      command
        .input(`aevalsrc=0:s=22050:c=mono:d=${dur}`)
        .inputFormat("lavfi");
    } else {
      command.input(piece.path);
    }
    inputLabels.push(`[${inputIdx}:a]`);
    inputIdx++;
  }

  // Normalise all inputs to 44100 Hz mono fltp before concat (handles ElevenLabs + lavfi format mismatch)
  const normalizeFilters = inputLabels.map(
    (lbl, i) => `${lbl}aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono[na${i}]`
  );
  const concatInputs = inputLabels.map((_, i) => `[na${i}]`).join("");
  const concatFilter = `${concatInputs}concat=n=${inputLabels.length}:v=0:a=1[narration]`;
  const filterGraph = [...normalizeFilters, concatFilter];

  const clipCount = pieces.filter((p) => p.type === "audio").length;
  const gapCount = pieces.filter((p) => p.type === "silence").length;
  console.log(
    `[job ${jobId}] building narration track: ${clipCount} clips + ${gapCount} silence gaps, target duration=${videoDurAdjusted.toFixed(1)}s`
  );

  await new Promise((resolve, reject) => {
    const getStderr = attachFfmpegDiagnostics(jobId, "build-narration-track", command);
    command
      .complexFilter(filterGraph)
      .outputOptions(["-y", "-map [narration]", "-c:a aac", "-ar 44100", "-ac 1"])
      .output(narrationPath)
      .on("end", () => {
        console.log(`[job ${jobId}] narration track assembled: ${narrationPath}`);
        resolve();
      })
      .on("error", (err) => {
        const stderr = getStderr();
        if (stderr) {
          console.error(`[job ${jobId}] build-narration-track stderr (tail):\n${stderr.slice(-8000)}`);
        }
        reject(err);
      })
      .run();
  });

  return narrationPath;
}

/** Legacy: uses `buildTimestampedNarrationTrackLegacy` (Pass-6 timestamps → leading silence per segment + concat). Prefer continuous assembly for new jobs. */
async function stitchAudioOntoVideo(jobId, inputVideoPath, audioSegments, outputPath, playbackSpeed = 1) {
  const ptsMultiplier = 1 / playbackSpeed;
  const watermarkText = (process.env.WATERMARK_TEXT ?? "RollAI").trim() || "RollAI";
  const fontPath = resolveWatermarkFontPath();
  const wantWatermark = Boolean(fontPath && watermarkText);
  if (!fontPath) {
    console.warn(`[job ${jobId}] Watermark skipped: no font file found for drawtext (install DejaVu/Arial or set a readable path)`);
  }

  assertReadableFile(jobId, inputVideoPath, "stitch input video");
  for (const seg of audioSegments) {
    assertReadableFile(jobId, seg.path, "audio segment");
  }

  // Build a single continuous narration track. Map filtered video [v] + narration audio only —
  // do not mix with source-file audio (gym bleed).
  let narrationTrackPath = null;
  const tempDir = path.dirname(outputPath);

  if (audioSegments.length > 0) {
    const videoDurationSeconds = await getVideoDurationSeconds(inputVideoPath);
    narrationTrackPath = await buildTimestampedNarrationTrackLegacy(
      jobId,
      audioSegments,
      videoDurationSeconds,
      playbackSpeed,
      tempDir
    );
  }

  console.log(`[job ${jobId}] FFmpeg stitch: ${inputVideoPath} + ${narrationTrackPath ?? "no narration"} → ${outputPath}`);

  const runStitch = (includeWatermark) =>
    new Promise((resolve, reject) => {
      const videoFilter = buildVideoFilterGraph(ptsMultiplier, includeWatermark, fontPath, watermarkText);

      if (!narrationTrackPath) {
        // No narration — video-only output
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
      command.input(narrationTrackPath);

      // Video from filter graph only; narration is sole audio (no mixing with gym/camera bleed from source).
      const filterGraph = [videoFilter];

      console.log(`[job ${jobId}] FFmpeg filter_complex (${filterGraph.length} statements):`);
      filterGraph.forEach((statement, idx) => {
        console.log(`[job ${jobId}]   [${idx}] ${statement}`);
      });

      const getStderr = attachFfmpegDiagnostics(jobId, "stitch-audio-video", command);
      command
        .complexFilter(filterGraph)
        .outputOptions(["-y", "-map [v]", "-map 1:a", "-c:v libx264", "-pix_fmt yuv420p", "-c:a aac"])
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
  } finally {
    // Clean up intermediate narration track
    if (narrationTrackPath) {
      await fs.rm(narrationTrackPath, { force: true }).catch(() => {});
    }
  }
}

/**
 * Stitch a finished narration AAC (already full timeline: speech + short gaps + trailing silence)
 * onto the graded video — video filter graph + map narration stream only (no source audio).
 *
 * Caller deletes `narrationTrackPath` when it is a temp file (see `finally` in processVideo).
 */
async function stitchVideoWithPremadeNarrationTrack(
  jobId,
  inputVideoPath,
  narrationTrackPath,
  outputPath,
  playbackSpeed = 1
) {
  const ptsMultiplier = 1 / playbackSpeed;
  const watermarkText = (process.env.WATERMARK_TEXT ?? "RollAI").trim() || "RollAI";
  const fontPath = resolveWatermarkFontPath();
  const wantWatermark = Boolean(fontPath && watermarkText);
  if (!fontPath) {
    console.warn(
      `[job ${jobId}] Watermark skipped: no font file found for drawtext (install DejaVu/Arial or set a readable path)`
    );
  }

  assertReadableFile(jobId, inputVideoPath, "stitch input video");
  assertReadableFile(jobId, narrationTrackPath, "premade narration track");

  console.log(`[job ${jobId}] FFmpeg stitch (premade narration): ${inputVideoPath} + ${narrationTrackPath} → ${outputPath}`);

  const runStitch = (includeWatermark) =>
    new Promise((resolve, reject) => {
      const videoFilter = buildVideoFilterGraph(ptsMultiplier, includeWatermark, fontPath, watermarkText);
      const command = ffmpeg();
      command.input(inputVideoPath);
      command.input(narrationTrackPath);
      const filterGraph = [videoFilter];
      const getStderr = attachFfmpegDiagnostics(jobId, "stitch-premade-narration", command);
      command
        .complexFilter(filterGraph)
        .outputOptions(["-y", "-map [v]", "-map 1:a", "-c:v libx264", "-pix_fmt yuv420p", "-c:a aac"])
        .output(outputPath)
        .on("end", resolve)
        .on("error", (err) => {
          const stderr = getStderr();
          if (stderr) {
            console.error(
              `[job ${jobId}] stitch-premade-narration stderr (tail):\n${stderr.slice(-12000)}`
            );
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

/**
 * Post-TTS (Pass 6 in pipeline): measure real MP3 durations, resolve overlaps by pushing starts forward.
 * Only the **last accepted** clip defines the next min start — dropped clips never chain forward.
 * If adjusted start would fall at/after video end, or the clip extends past the end, drop (no placement beyond duration).
 */
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
