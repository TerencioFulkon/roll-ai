import { DATE_FORMAT_LOCALE, formatLocalDate } from "@/lib/dateTime";

/** `m:ss` or `h:mm:ss` for roll duration labels (null → omit). */
export function formatVideoDurationClock(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  const total = Math.floor(seconds + 1e-3);
  const mWhole = Math.floor(total / 60);
  const s = total % 60;
  const h = Math.floor(mWhole / 60);
  const m = mWhole % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Local calendar midnight for `date`. */
function startOfLocalDayMs(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Heading key + label for rolls list grouping (Today / Yesterday / Month YYYY…).
 *
 * @param {string} isoString
 */
export function getRollDateSectionHeading(isoString) {
  if (!isoString) {
    return { key: "undated", label: "Earlier" };
  }

  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) {
    return { key: "invalid", label: "Earlier" };
  }

  const todayStart = startOfLocalDayMs(new Date());
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const yesterdayStart = startOfLocalDayMs(y);

  const dayStart = startOfLocalDayMs(d);

  if (dayStart === todayStart) {
    return { key: "today", label: "Today" };
  }
  if (dayStart === yesterdayStart) {
    return { key: "yesterday", label: "Yesterday" };
  }

  const monthBucket = `${d.getFullYear()}-${d.getMonth()}`;
  try {
    const label = new Intl.DateTimeFormat(DATE_FORMAT_LOCALE, {
      month: "long",
      year: "numeric"
    }).format(d);
    return { key: `month:${monthBucket}`, label };
  } catch {
    return { key: `month:${monthBucket}`, label: `${d.getFullYear()}` };
  }
}

/** Date-only label for roll lists (UTC from API → user’s local calendar date via `formatLocalDate`). */
export function formatRollListDate(iso) {
  if (!iso || typeof iso !== "string") {
    return "";
  }
  const trimmed = iso.trim();
  const formatted = formatLocalDate(trimmed);
  return formatted || trimmed;
}
