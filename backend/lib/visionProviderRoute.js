/**
 * Resolves Pass 1 (visual timeline) provider: OpenAI frames vs Gemini full video.
 *
 * Order: job metadata `vision_provider` → env `VISION_PROVIDER` → default openai.
 * Gemini is only attempted when API key exists and duration is within limit.
 */

/**
 * @typedef {"openai"|"gemini"} VisionProviderId
 */

/**
 * @param {unknown} v
 * @returns {VisionProviderId | null}
 */
function normalizeVisionProvider(v) {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "gemini" || s === "openai") return s;
  return null;
}

/**
 * @param {{
 *   jobVisionProvider?: unknown,
 *   envVisionProvider?: unknown,
 *   geminiApiKey?: unknown,
 *   videoDurationSeconds: number,
 *   geminiMaxVideoDurationSeconds: number,
 * }} opts
 */
export function resolveVisionTimelineRoute(opts) {
  const vd = Number(opts.videoDurationSeconds) || 0;
  const maxGem = Number(opts.geminiMaxVideoDurationSeconds) || 600;
  const key = typeof opts.geminiApiKey === "string" ? opts.geminiApiKey.trim() : "";

  let providerSource = "default";
  /** @type {VisionProviderId} */
  let configured = "openai";

  const jobN = normalizeVisionProvider(opts.jobVisionProvider);
  if (jobN) {
    configured = jobN;
    providerSource = "job_override";
  } else {
    const envN = normalizeVisionProvider(opts.envVisionProvider);
    if (envN) {
      configured = envN;
      providerSource = "env";
    }
  }

  let useGemini = configured === "gemini";
  /** @type {"missing_gemini_api_key" | "duration_exceeds_gemini_limit" | undefined} */
  let blockReason;

  if (useGemini && !key) {
    useGemini = false;
    blockReason = "missing_gemini_api_key";
  }
  if (useGemini && vd > maxGem) {
    useGemini = false;
    blockReason = "duration_exceeds_gemini_limit";
  }

  return {
    providerSource,
    configuredProvider: configured,
    useGemini,
    blockReason
  };
}

/** Safe log-only explanation when Gemini cannot run (never includes secrets). */
export function explainGeminiUnavailableForLogs(route, videoDurationSeconds, geminiMaxVideoDurationSeconds) {
  if (route.useGemini) return null;
  if (route.configuredProvider !== "gemini") return null;
  if (route.blockReason === "missing_gemini_api_key") {
    return "Gemini chosen but GEMINI_API_KEY is not set — using OpenAI for visual timeline";
  }
  if (route.blockReason === "duration_exceeds_gemini_limit") {
    return `Gemini chosen but video duration ${Number(videoDurationSeconds).toFixed(1)}s exceeds GEMINI_MAX_VIDEO_DURATION_SECONDS (${geminiMaxVideoDurationSeconds}s) — using OpenAI for visual timeline`;
  }
  return "Gemini unavailable — using OpenAI for visual timeline";
}
