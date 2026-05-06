/**
 * Supabase sends `timestamptz` as ISO strings in UTC. Parse with `Date` and format for display
 * using the device/browser timezone via `Intl`.
 *
 * PROFILE_TIMEZONE_NOTE: For now we rely on `Intl.DateTimeFormat().resolvedOptions().timeZone`
 * (the user’s OS/browser region). If we add user profiles or settings later, prefer storing an
 * IANA zone id (e.g. `Europe/London`, `America/New_York`, `Australia/Sydney`) and passing it
 * into `Intl` as `timeZone: …`. Do not persist fixed numeric offsets like `+01:00` as the user’s
 * zone — they are wrong across daylight-saving changes.
 */

/** Calendar + clock labels (human-facing). */
export const DATE_FORMAT_LOCALE = "en-GB";

/**
 * @returns {string} IANA timezone id when available (e.g. `Europe/London`), otherwise `UTC`.
 */
export function getUserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** @param {string | number | Date | null | undefined} timestamp */
function toDate(timestamp) {
  if (timestamp == null) return null;
  if (timestamp instanceof Date) {
    return Number.isNaN(timestamp.getTime()) ? null : timestamp;
  }
  if (typeof timestamp === "number") {
    const d = new Date(timestamp);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(timestamp).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param {string | number | Date | null | undefined} timestamp
 * @returns {string}
 */
export function formatLocalDateTime(timestamp) {
  const d = toDate(timestamp);
  if (!d) return "";
  try {
    return new Intl.DateTimeFormat(DATE_FORMAT_LOCALE, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

/**
 * @param {string | number | Date | null | undefined} timestamp
 * @returns {string}
 */
export function formatLocalDate(timestamp) {
  const d = toDate(timestamp);
  if (!d) return "";
  try {
    return new Intl.DateTimeFormat(DATE_FORMAT_LOCALE, { dateStyle: "medium" }).format(d);
  } catch {
    return d.toLocaleDateString(DATE_FORMAT_LOCALE);
  }
}

/**
 * @param {string | number | Date | null | undefined} timestamp
 * @returns {string}
 */
export function formatLocalTime(timestamp) {
  const d = toDate(timestamp);
  if (!d) return "";
  try {
    return new Intl.DateTimeFormat(DATE_FORMAT_LOCALE, { timeStyle: "short" }).format(d);
  } catch {
    return d.toLocaleTimeString(DATE_FORMAT_LOCALE);
  }
}

/**
 * Canonical UTC instant for debugging / admin copy (matches storage).
 * Example: `2026-05-06T08:15:00Z`
 *
 * @param {string | number | Date | null | undefined} timestamp
 * @returns {string}
 */
export function formatUtcIso(timestamp) {
  const d = toDate(timestamp);
  if (!d) return "";
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
