/** Max characters surfaced in list / detail headings (ellipsis if longer). */
const DISPLAY_TITLE_CHAR_CAP = 52;

/** Copy bank for legacy jobs before `metadata.roll_display_title` existed */
const LEGACY_DUMMY_TITLES = [
  "Open guard exchanges under pressure",
  "Knee-cut defence to north-south reset",
  "Half guard battle and sweep chains",
  "Back defence and escapes",
  "Mount escapes and framing",
  "Turtle scramble to guard recovery",
  "Side control escape chains",
  "Leg entanglement reactions",
  "Guard retention versus passer",
  "Late submission counters"
];

/**
 * Stable label for anon jobs lacking an AI-derived title yet.
 *
 * @param {string} jobId
 */
export function placeholderRollTitle(jobId) {
  let hash = 0;
  for (let i = 0; i < jobId.length; i += 1) {
    hash = (hash * 31 + jobId.charCodeAt(i)) >>> 0;
  }
  return LEGACY_DUMMY_TITLES[hash % LEGACY_DUMMY_TITLES.length];
}

/**
 * @param {unknown} raw
 */
function coerceOneLine(raw) {
  if (typeof raw !== "string") {
    return "";
  }
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^[({[]+/, "")
    .replace(/[})\]]+$/, "")
    .trim();
}

/** One short teaser from Pass 1 `summary`. */
function excerptFromSummary(summary) {
  const line =
    typeof summary === "string"
      ? summary
          .replace(/\s+/g, " ")
          .trim()
      : "";

  if (!line) return "";

  const punctBreak = line.search(/[.!?]\s+/);
  if (punctBreak >= 28 && punctBreak < 620) return line.slice(0, punctBreak).trim();

  const commaIdx = line.indexOf(",");
  if (commaIdx >= 32 && commaIdx < 160) return line.slice(0, commaIdx).trim();

  const cap = Math.min(line.length, 140);
  return line.slice(0, cap).trim();
}

export function clampTitle(str, max = DISPLAY_TITLE_CHAR_CAP) {
  const t = coerceOneLine(str);
  if (!t) return "";
  if (t.length <= max) return t;

  let cut = t.lastIndexOf(" ", max - 2);
  if (cut < 16) cut = max - 2;
  return `${t.slice(0, cut)}…`;
}

/** Last-resort prettify from uploaded filename stem. */
function humanizeStem(fileName) {
  if (typeof fileName !== "string" || !fileName.trim()) return "";
  let base = fileName.replace(/^.*[/\\]/, "").replace(/\.[a-z0-9]{1,8}$/i, "");
  base = base.replace(/[._+-]+/g, " ").replace(/\s+/g, " ").trim();
  base = coerceOneLine(base);

  const words = base.split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  return clampTitle(words.map((w) => w.slice(0, 1).toUpperCase() + w.slice(1).toLowerCase()).join(" "));
}

/**
 * Build the roll label from GPT pass-1 output (persisted onto the job row).
 *
 * @param {{ roll_title?: string, overall_theme?: string, summary?: string } | null | undefined} analysis
 * @param {string | undefined} fileName
 */
export function finalizeRollDisplayTitle(analysis, fileName) {
  const ai = coerceOneLine(analysis?.roll_title);
  if (ai) return clampTitle(ai);

  const theme = coerceOneLine(analysis?.overall_theme);
  if (theme) return clampTitle(theme);

  const fromSummary = excerptFromSummary(analysis?.summary || "");
  if (fromSummary) return clampTitle(fromSummary);

  const fromFile = humanizeStem(fileName);
  if (fromFile) return fromFile;

  return "Narrated roll";
}
