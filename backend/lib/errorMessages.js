/**
 * Canonical outage copy surfaced to end users whenever an upstream provider
 * (ElevenLabs, OpenAI, R2, Supabase) or unexpected server error occurs.
 *
 * Keep in sync with the frontend constant of the same name — raw provider
 * errors (stringified JSON, HTTP 401 bodies, stack traces) must never leak
 * to the UI. Log the raw error alongside for debugging before writing this
 * message to the database or HTTP response.
 */
export const SERVICE_UNAVAILABLE_MESSAGE =
  "RollAI is currently unavailable, but we're working hard to get it back online. Please try again later.";
