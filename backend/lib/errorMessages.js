/**
 * Canonical outage copy surfaced to end users whenever an upstream provider
 * fails or an unexpected server error occurs. Never put raw provider payloads
 * or API keys in strings written to `jobs.error_message`.
 *
 * Keep in sync with the frontend where the same copy is duplicated.
 */
export const SERVICE_UNAVAILABLE_MESSAGE =
  "RollAI is currently unavailable, but we're working hard to get it back online. Please try again later.";

/**
 * Generic pipeline failure copy when the worker hits an upstream LLM/vision
 * error — provider-neutral so the UI doesn't imply a specific vendor failed.
 */
export const ANALYSIS_PROCESSING_FAILED_MESSAGE =
  "Analysis failed while processing the video.";

/** @param {unknown} err */
export function toPublicJobErrorMessage(err) {
  const raw = typeof err?.message === "string" ? err.message.trim() : "";
  if (!raw) {
    return SERVICE_UNAVAILABLE_MESSAGE;
  }
  if (raw === SERVICE_UNAVAILABLE_MESSAGE || raw.startsWith("RollAI is currently unavailable")) {
    return raw;
  }
  const m = raw;
  // LLM / vision HTTP and parse failures — avoid vendor names in UI
  if (/openai request failed/i.test(m)) return ANALYSIS_PROCESSING_FAILED_MESSAGE;
  if (/GPT-4o returned non-JSON/i.test(m)) return ANALYSIS_PROCESSING_FAILED_MESSAGE;
  if (/openai tts failed/i.test(m)) return ANALYSIS_PROCESSING_FAILED_MESSAGE;
  if (/non-JSON response/i.test(m) && /failed/i.test(m)) return ANALYSIS_PROCESSING_FAILED_MESSAGE;

  return raw.length <= 480 ? raw : ANALYSIS_PROCESSING_FAILED_MESSAGE;
}
