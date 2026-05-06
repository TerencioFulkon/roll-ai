import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager, FileState } from "@google/generative-ai/server";
import { existsSync } from "node:fs";
import mime from "mime-types";
import { pass1PhaseDensityGuidance } from "../lib/pass1Timeline.js";

/** Approximate Gemini 2.0 Flash list pricing (USD) for dashboard comparison — totals may omit video surcharge nuances. */
const GEMINI_FLASH_INPUT_PER_MUSD = 0.1;
const GEMINI_FLASH_OUTPUT_PER_MUSD = 0.4;

const GEMINI_VISUAL_SYSTEM = `You are analysing Brazilian Jiu Jitsu sparring footage.

Your task is not to provide coaching yet. Your task is to create a visually accurate timeline of what actually happens.

Rules:
- Only describe what is visible in the video.
- Do not infer dominance unless body position clearly supports it.
- Do not invent grips, submissions, sweeps, passes, or dominant positions.
- If unsure, use uncertainty fields.
- Track the athlete in the green t-shirt where visible.
- Separate the roll into clear phases based on real changes in position, role, control, or direction of action.
- Prefer visual accuracy over technical ambition.
- For each phase, identify who is top, bottom, standing, seated, passing, defending, attacking, or unclear.
- If a position is unclear, say unclear rather than guessing.
- Avoid generic terms like "dominant" unless there is clear positional evidence.
- Output JSON only.`;

/** @param {unknown} raw */
function parseJsonStrict(raw, label) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`${label}: empty response text`);
  }
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  return JSON.parse(cleaned);
}

/**
 * @param {unknown} err
 * @returns {string}
 */
export function sanitizeGeminiErrorForLogs(err) {
  let m = err instanceof Error ? err.message : String(err);
  m = m.replace(/AIza[0-9A-Za-z_-]{20,}/gi, "[REDACTED]");
  m = m.replace(/key[=:]\s*[\w-]{10,}/gi, "key=[REDACTED]");
  return m.slice(0, 800);
}

/**
 * Build user prompt matching Pass 1 OpenAI timeline JSON shape (strict observational timeline).
 *
 * @param {number} videoDurationSeconds
 * @param {string} densityBlurb
 * @param {string} participantTail
 */
function buildGeminiTimelineUser(videoDurationSeconds, densityBlurb, participantTail) {
  return `${densityBlurb}

VIDEO_DURATION_SECONDS supplied for this clip: exactly ${videoDurationSeconds}. Set JSON field video_duration_seconds to this exact value.

${participantTail}

Return JSON only with this EXACT shape and key names:

{
  "video_duration_seconds": number,
  "roll_title": string,
  "summary": string,
  "user_identity_assumption": string,
  "phases": [
    {
      "start": number,
      "end": number,
      "phase_type": string,
      "top_player": string,
      "bottom_player": string,
      "user_role": "standing_player" | "top_player" | "bottom_player" | "seated_guard_player" | "passing_player" | "defensive_player" | "attacking_player" | "unclear",
      "position": string,
      "specific_position_details": string,
      "visible_grips_or_controls": [string],
      "observable_details": [string],
      "key_events": [string],
      "what_changed_from_previous_phase": string,
      "outcome": string,
      "visual_relevance": string,
      "uncertainties": [string],
      "visual_certainty": "high" | "medium" | "low"
    }
  ],
  "high_confidence_moments": [
    { "timestamp": number, "what_is_visible": string, "why_it_matters": string }
  ],
  "low_confidence_moments": [
    { "timestamp": number, "reason": string }
  ]
}`;
}

/**
 * @param {GoogleAIFileManager} fileManager
 * @param {string} fileApiName — e.g. files/abc123
 */
async function waitForGeminiFileActive(fileManager, fileApiName) {
  const deadline = Date.now() + 900_000;
  for (;;) {
    const meta = await fileManager.getFile(fileApiName);
    if (meta.state === FileState.ACTIVE) {
      return meta;
    }
    if (meta.state === FileState.FAILED) {
      throw new Error("Gemini file processing failed while indexing video");
    }
    if (Date.now() > deadline) {
      throw new Error("Gemini file processing timed out waiting for ACTIVE state");
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
}

function estimateGeminiFlashCostUsd(promptTokens, outputTokens) {
  const p = Number(promptTokens) || 0;
  const c = Number(outputTokens) || 0;
  return (p / 1_000_000) * GEMINI_FLASH_INPUT_PER_MUSD + (c / 1_000_000) * GEMINI_FLASH_OUTPUT_PER_MUSD;
}

/**
 * @param {{
 *   videoPath: string,
 *   videoDurationSeconds: number,
 *   jobId: string,
 *   pipelineDebug?: unknown,
 *   participantDescription?: string,
 *   apiKey: string,
 *   visionModel?: string,
 * }} args
 */
export async function analyseVideoWithGemini({
  videoPath,
  videoDurationSeconds,
  jobId,
  pipelineDebug: _pipelineDebug = null,
  participantDescription = "",
  apiKey,
  visionModel = "gemini-2.0-flash"
}) {
  if (!apiKey?.trim()) {
    throw new Error("GEMINI_API_KEY is not configured");
  }
  if (!videoPath || !existsSync(videoPath)) {
    throw new Error("Gemini video path missing or not readable");
  }
  if (!(typeof videoDurationSeconds === "number") || videoDurationSeconds <= 0) {
    throw new Error("Gemini analyse requires positive videoDurationSeconds");
  }

  const mimeGuess = mime.lookup(videoPath);
  const mimeType = typeof mimeGuess === "string" && mimeGuess.startsWith("video/") ? mimeGuess : "video/mp4";

  const participantTail = participantDescription
    ? `The practitioner you track is identified by context: ${participantDescription}. Prefer their green shirt framing for user_identity_assumption; never coach in this timeline pass.`
    : "Assume the athlete in the green shirt is the tracked participant when attire is distinguishable.";

  const density = pass1PhaseDensityGuidance(videoDurationSeconds);
  const userText = buildGeminiTimelineUser(videoDurationSeconds, density, participantTail);

  const fileManager = new GoogleAIFileManager(apiKey);
  /** @type {string | undefined} */
  let uploadedFileApiName;

  try {
    const upload = await fileManager.uploadFile(videoPath, {
      mimeType,
      displayName: `job-${String(jobId).slice(0, 8)}-source`
    });
    uploadedFileApiName = upload.file.name;
    const active = await waitForGeminiFileActive(fileManager, upload.file.name);

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: visionModel,
      systemInstruction: GEMINI_VISUAL_SYSTEM
    });

    const result = await model.generateContent([
      { text: userText },
      { fileData: { mimeType, fileUri: active.uri } }
    ]);

    const text = typeof result.response.text === "function" ? result.response.text() : "";
    /** @type {Record<string, unknown>} */
    const parsed = parseJsonStrict(text, "Gemini visual timeline");

    parsed.video_duration_seconds = videoDurationSeconds;

    const meta = result.response.usageMetadata;
    const inTok = Number(meta?.promptTokenCount) || 0;
    const outTok = Number(meta?.candidatesTokenCount) || 0;

    const costUsd = estimateGeminiFlashCostUsd(inTok, outTok);

    console.log(
      `GEMINI VISION COST: $${costUsd.toFixed(4)} (input tokens: ${inTok}, output tokens: ${outTok}, video seconds: ${videoDurationSeconds})`
    );

    return {
      timelineObject: parsed,
      rawModelOutput: text,
      usage: {
        pass1PromptTokens: inTok,
        pass1CompletionTokens: outTok,
        pass1CostUsd: Math.round(costUsd * 1_000_000) / 1_000_000
      },
      geminiVisionModelUsed: visionModel
    };
  } finally {
    if (uploadedFileApiName) {
      await fileManager.deleteFile(uploadedFileApiName).catch(() => {});
    }
  }
}
