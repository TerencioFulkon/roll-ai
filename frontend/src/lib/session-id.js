const STORAGE_KEY = "rollai_session_id";

/**
 * @returns {string | null}
 */
function readStoredSessionId() {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (typeof raw !== "string") return null;
    const v = raw.trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Ensures `rollai_session_id` exists in localStorage (UUID v4).
 * Call once on app load for anonymous upload correlation.
 *
 * @returns {string | null} The session id, or null if storage is unavailable.
 */
export function ensureRollaiSessionId() {
  try {
    if (typeof localStorage === "undefined") return null;
    const existing = readStoredSessionId();
    if (existing) return existing;
    const id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : null;
    if (!id) return null;
    localStorage.setItem(STORAGE_KEY, id);
    return id;
  } catch {
    return null;
  }
}

/**
 * @returns {string | null}
 */
export function getRollaiSessionId() {
  return readStoredSessionId();
}
