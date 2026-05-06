/**
 * Deterministic speech-density repair for narrative_plan.section_plan (Pass 3 normalisation follow-up).
 *
 * Rules (product):
 * - section_plan is repaired into a non-overlapping timeline before target_words / coverage math.
 * - target_words = floor(duration * 2.1) with minimums (12 if duration < 8s else 20).
 * - No section span > 40s; split into ≤35s children (min 10s when parent allows).
 * - Coverage uses sum(target_words)/2.1 — never sums overlapping window lengths.
 * - Target ≥80% estimated speech coverage vs video duration; expand from phases if needed.
 * - Hard fail if still <70% after expansion.
 */

/** Planning / validation words-per-second (Pass 3 targets, post-grounding estimates). */
export const SPEECH_WORDS_PER_SECOND_PLANNING = 2.1;

/** @deprecated use SPEECH_WORDS_PER_SECOND_PLANNING */
export const SPEECH_WORDS_PER_SECOND_TARGET = SPEECH_WORDS_PER_SECOND_PLANNING;

const HARD_MAX_SECTION_SEC = 40;
const PREF_MAX_CHUNK_SEC = 35;
const MIN_SECTION_SEC = 10;

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

const SHORT_VIDEO_MAX_SECONDS = 120;
const SUMMARY_TAIL_MIN_SECONDS = 12;

function normalizeStoryRole(storyRole) {
  return String(storyRole || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function isSummaryTakeawayStoryRole(storyRole) {
  const r = normalizeStoryRole(storyRole);
  return r === "summary_takeaway";
}

/** Final takeaway row: Prefer coaching_intent (Pass 3) over legacy story_role only. */
function isSummaryTakeawaySection(row) {
  if (!row || typeof row !== "object") return false;
  const ci = String(row.coaching_intent || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (ci === "summary_takeaway") return true;
  return isSummaryTakeawayStoryRole(row.story_role);
}

/**
 * @param {DensitySectionRow} prev
 * @param {DensitySectionRow} row
 * @param {number} vd
 */
function mergeCoachingIntoPrevious(prev, row, vd) {
  const pa = String(prev.coaching_focus || "").trim();
  const ra = String(row.coaching_focus || "").trim();
  prev.coaching_focus = [pa, ra].filter(Boolean).join(" · ");
  const pl = String(prev.label || "").trim();
  const rl = String(row.label || "").trim();
  if (rl && pl && !pl.includes(rl)) prev.label = `${pl} · ${rl}`;
  else if (rl && !pl) prev.label = rl;
  const pe = Math.max(Number(prev.approximate_time_range.end), Number(row.approximate_time_range.end));
  prev.approximate_time_range.end = Math.min(vd, pe);
}

/**
 * Sort and repair section_plan into a non-overlapping timeline within [0, vd].
 *
 * @param {DensitySectionRow[]} plan
 * @param {number} videoDurationSeconds
 * @returns {DensitySectionRow[]}
 */
export function repairSectionPlanTimeline(plan, videoDurationSeconds) {
  const vd = Number(videoDurationSeconds) || 0;
  const EPS = 1e-3;
  const rows = plan
    .filter((r) => r && typeof r === "object")
    .map((r) => {
      const atr = /** @type {DensitySectionRow} */ (r).approximate_time_range ?? { start: 0, end: 0 };
      return {
        ...r,
        approximate_time_range: {
          start: Number(atr.start),
          end: Number(atr.end)
        }
      };
    })
    .sort((a, b) => a.approximate_time_range.start - b.approximate_time_range.start);

  /** @type {DensitySectionRow[]} */
  const out = [];

  for (const row of rows) {
    let s = clamp(row.approximate_time_range.start, 0, vd);
    let e = clamp(row.approximate_time_range.end, 0, vd);
    if (e <= s + EPS) continue;

    if (!out.length) {
      out.push({ ...row, approximate_time_range: { start: s, end: e } });
      continue;
    }

    const prev = out[out.length - 1];
    const pe = Number(prev.approximate_time_range.end);

    if (s + EPS >= pe) {
      out.push({ ...row, approximate_time_range: { start: s, end: e } });
      continue;
    }

    const origDur = e - s;

    if (isSummaryTakeawaySection(row)) {
      const tailRoom = vd - pe;
      if (tailRoom + EPS >= origDur && pe + origDur <= vd + EPS) {
        const ns = pe;
        const ne = Math.min(vd, pe + origDur);
        if (ne > ns + EPS) {
          out.push({ ...row, approximate_time_range: { start: ns, end: ne } });
        } else {
          mergeCoachingIntoPrevious(prev, row, vd);
        }
      } else {
        mergeCoachingIntoPrevious(prev, row, vd);
      }
      continue;
    }

    s = pe;
    e = Math.min(e, vd);
    if (e <= s + EPS) continue;
    out.push({ ...row, approximate_time_range: { start: s, end: e } });
  }

  return out.map((r) => ({
    ...r,
    approximate_time_range: {
      start: Math.round(r.approximate_time_range.start * 1000) / 1000,
      end: Math.round(r.approximate_time_range.end * 1000) / 1000
    }
  }));
}

/**
 * For videos under 2 minutes: fold trailing summary_takeaway into the prior section
 * unless at least 12s of video remains after the previous section.
 *
 * @param {DensitySectionRow[]} plan
 * @param {number} videoDurationSeconds
 */
export function foldShortVideoSummarySections(plan, videoDurationSeconds) {
  const vd = Number(videoDurationSeconds) || 0;
  if (vd >= SHORT_VIDEO_MAX_SECONDS || plan.length < 2) return plan.map((r) => ({ ...r }));

  const sorted = [...plan]
    .map((r) => ({ ...r }))
    .sort((a, b) => Number(a.approximate_time_range.start) - Number(b.approximate_time_range.start));
  const last = sorted[sorted.length - 1];
  const secondLast = sorted[sorted.length - 2];
  if (!isSummaryTakeawaySection(last)) return sorted;

  const prevEnd = Number(secondLast.approximate_time_range.end);
  if (vd - prevEnd >= SUMMARY_TAIL_MIN_SECONDS - 1e-3) return sorted;

  mergeCoachingIntoPrevious(secondLast, last, vd);
  secondLast.approximate_time_range.end = Math.min(
    vd,
    Math.max(prevEnd, Number(last.approximate_time_range.end))
  );
  sorted.pop();
  return sorted;
}

/**
 * @param {DensitySectionRow[]} plan
 */
export function assignTargetWordsToPlan(plan) {
  for (const row of plan) {
    const d =
      Number(row.approximate_time_range.end) - Number(row.approximate_time_range.start);
    row.target_words = d > 1e-6 ? targetWordsFromSectionDuration(d) : 0;
  }
}

/**
 * @param {number} durationSec
 */
export function targetWordsFromSectionDuration(durationSec) {
  const d = Math.max(0, Number(durationSec) || 0);
  let w = Math.floor(d * SPEECH_WORDS_PER_SECOND_PLANNING);
  if (d > 1e-6 && d < 8) {
    w = Math.max(w, 12);
  } else if (d >= 8) {
    w = Math.max(w, 20);
  }
  return Math.max(0, w);
}

/**
 * @param {string} baseId e.g. "s3"
 * @param {number} partIndex 0-based
 * @param {number} partCount
 */
export function splitChildSectionId(baseId, partIndex, partCount) {
  const base = String(baseId || "").trim() || "s";
  if (partCount <= 26) {
    const letter = String.fromCharCode("a".charCodeAt(0) + partIndex);
    return `${base}${letter}`;
  }
  return `${base}p${partIndex + 1}`;
}

/** @param {number} slots @param {number} idx */
export function coachingFocusSuffixForSplit(idx, slots) {
  if (slots === 2) {
    return ["setup", "takeaway"][idx] ?? `part ${idx + 1}`;
  }
  if (slots === 3) {
    return ["setup", "why it matters", "takeaway"][idx] ?? `part ${idx + 1}`;
  }
  const cycle = ["setup", "development", "why it matters", "takeaway"];
  if (idx < cycle.length) {
    return cycle[idx];
  }
  return `development ${idx - 2}`;
}

/** Max numeric id from section_id like s12 or s12a → 12 */
export function maxPlanSectionNumericId(section_plan) {
  let mx = 0;
  if (!Array.isArray(section_plan)) return 0;
  for (const row of section_plan) {
    if (!row || typeof row !== "object") continue;
    const id = String(/** @type {Record<string, unknown>} */ (row).section_id || "");
    const m = id.match(/^s(\d+)/i);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isInteger(n)) mx = Math.max(mx, n);
    }
  }
  return mx;
}

/**
 * @typedef {{
 *   section_id: string,
 *   label: string,
 *   story_role: string,
 *   narrative_priority: string,
 *   coaching_focus: string,
 *   linked_phase_indexes: number[],
 *   approximate_time_range: { start: number, end: number },
 *   target_words: number
 * }} DensitySectionRow
 */

/**
 * Split intervals for duration > HARD_MAX_SECTION_SEC using ≤ PREF_MAX_CHUNK_SEC average chunks.
 *
 * @param {number} start
 * @param {number} end
 * @returns {Array<[number, number]>}
 */
export function sliceTimeSegments(start, end) {
  const a = Number(start);
  const b = Number(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b - a <= HARD_MAX_SECTION_SEC) {
    return [[a, b]];
  }
  const dur = b - a;
  const n = Math.max(2, Math.ceil(dur / PREF_MAX_CHUNK_SEC));
  /** @type {Array<[number, number]>} */
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = a + (dur * i) / n;
    const t1 = a + (dur * (i + 1)) / n;
    out.push([t0, i === n - 1 ? b : t1]);
  }
  if (out.length) {
    out[out.length - 1][1] = b;
  }
  for (let j = 1; j < out.length; j += 1) {
    const prevEnd = out[j - 1][1];
    if (out[j][0] < prevEnd - 1e-6) out[j][0] = prevEnd;
    const sd = out[j][1] - out[j][0];
    if (sd < MIN_SECTION_SEC && j < out.length - 1) {
      const bump = MIN_SECTION_SEC - sd;
      out[j][1] = Math.min(b, out[j][1] + bump);
    }
  }
  return out;
}

/**
 * Expand one oversized section row into ≥1 density rows (same linked_phase_indexes, narrative_priority).
 *
 * @param {DensitySectionRow | Record<string, unknown>} row
 * @param {number} videoDurationSeconds
 * @returns {{ rows: DensitySectionRow[], splits: number }}
 */
export function splitSectionRowOverMaxLength(row, videoDurationSeconds) {
  /** @type {DensitySectionRow} */
  const r = /** @type {DensitySectionRow} */ (
    typeof row === "object" && row ? { ...(/** @type {object} */ (row)) } : {}
  );
  const atr = r.approximate_time_range ?? { start: 0, end: videoDurationSeconds };
  let s = Number(atr.start);
  let e = Number(atr.end);
  const vd = Number(videoDurationSeconds) || 0;
  if (!Number.isFinite(s)) s = 0;
  if (!Number.isFinite(e)) e = vd || s;
  s = clamp(s, 0, vd || 99999);
  e = clamp(e, 0, vd || 99999);
  if (e <= s) {
    const rowOut = {
      section_id: r.section_id || "s1",
      label: String(r.label || ""),
      story_role: String(r.story_role || "rolling_analysis"),
      narrative_priority: String(r.narrative_priority || "medium"),
      coaching_focus: String(r.coaching_focus || ""),
      linked_phase_indexes: Array.isArray(r.linked_phase_indexes) ? [...r.linked_phase_indexes] : [],
      approximate_time_range: { start: s, end: Math.min(vd || s + MIN_SECTION_SEC, s + MIN_SECTION_SEC) },
      target_words: 0
    };
    return { rows: [rowOut], splits: 0 };
  }

  const duration = e - s;
  if (duration <= HARD_MAX_SECTION_SEC) {
    const rowOut = {
      section_id: r.section_id,
      label: String(r.label || ""),
      story_role: String(r.story_role || "rolling_analysis"),
      narrative_priority: String(r.narrative_priority || "medium"),
      coaching_focus: String(r.coaching_focus || ""),
      linked_phase_indexes: Array.isArray(r.linked_phase_indexes) ? [...r.linked_phase_indexes] : [],
      approximate_time_range: { start: s, end: e },
      target_words: 0
    };
    return { rows: [rowOut], splits: 0 };
  }

  const segments = sliceTimeSegments(s, e);
  const slots = segments.length;
  /** @type {DensitySectionRow[]} */
  const out = [];
  for (let i = 0; i < segments.length; i += 1) {
    const [ts, te] = segments[i];
    const suf = coachingFocusSuffixForSplit(i, slots);
    out.push({
      section_id: splitChildSectionId(String(r.section_id || "sx"), i, slots),
      label: `${String(r.label || "Section").trim()} — ${suf}`,
      story_role: String(r.story_role || "rolling_analysis"),
      narrative_priority: String(r.narrative_priority || "medium"),
      coaching_focus: `${String(r.coaching_focus || "").trim()} (${suf}.)`,
      linked_phase_indexes: Array.isArray(r.linked_phase_indexes) ? [...r.linked_phase_indexes] : [],
      approximate_time_range: { start: ts, end: te },
      target_words: 0
    });
  }
  return { rows: out, splits: slots - 1 };
}

/**
 * @param {DensitySectionRow[]} plan
 * @param {number} vd
 */
export function computeSpeechDensityMetrics(plan, vd) {
  const dur = Number(vd) || 0;
  if (!Array.isArray(plan) || plan.length === 0 || dur <= 0) {
    return {
      sectionCount: 0,
      longestSectionSeconds: 0,
      totalPlannedWindowSeconds: 0,
      estimatedSpeechSeconds: 0,
      estimatedCoveragePct: 0,
      maxSilentGapSeconds: 0,
      sectionsSplitForLength: 0,
      flaggedBelowTarget80: true
    };
  }
  const sorted = [...plan].sort(
    (a, b) => Number(a.approximate_time_range.start) - Number(b.approximate_time_range.start)
  );
  let longest = 0;
  let windowSum = 0;
  let totalWords = 0;
  for (const sec of sorted) {
    const a = Number(sec.approximate_time_range.start);
    const b = Number(sec.approximate_time_range.end);
    const dd = Math.max(0, b - a);
    longest = Math.max(longest, dd);
    windowSum += dd;
    totalWords += Number(sec.target_words) || 0;
  }
  const estimatedSpeechSeconds = totalWords / SPEECH_WORDS_PER_SECOND_PLANNING;
  const estimatedCoveragePct = (estimatedSpeechSeconds / dur) * 100;

  if (windowSum > dur + 0.05) {
    windowSum = Math.min(windowSum, dur);
  }

  /** @type {number[]} */
  const gaps = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prevEnd = Number(sorted[i - 1].approximate_time_range.end);
    const curStart = Number(sorted[i].approximate_time_range.start);
    if (Number.isFinite(prevEnd) && Number.isFinite(curStart)) {
      gaps.push(Math.max(0, curStart - prevEnd));
    }
  }
  const headGap = sorted.length ? Math.max(0, Number(sorted[0].approximate_time_range.start)) : 0;
  const tailGap = sorted.length
    ? Math.max(0, dur - Number(sorted[sorted.length - 1].approximate_time_range.end))
    : 0;
  const maxSilentGapSeconds = Math.max(headGap, tailGap, ...gaps);

  return {
    sectionCount: sorted.length,
    longestSectionSeconds: longest,
    totalPlannedWindowSeconds: windowSum,
    estimatedSpeechSeconds,
    estimatedCoveragePct,
    maxSilentGapSeconds,
    sectionsSplitForLength: 0,
    flaggedBelowTarget80: estimatedCoveragePct < 80
  };
}

/**
 * @param {number} ps
 * @param {number} pe
 * @param {DensitySectionRow[]} plan
 */
function overlapsRange(ps, pe, bStart, bEnd) {
  return Math.min(pe, bEnd) > Math.max(ps, bStart);
}

/**
 * Rough overlap fraction of phase [ps,pe] vs union of existing section windows (sequential approximation).
 *
 * @param {number} ps
 * @param {number} pe
 * @param {DensitySectionRow[]} plan
 */
function phaseCoverageFraction(ps, pe, plan) {
  let overlap = 0;
  const duration = Math.max(1e-6, pe - ps);
  for (const sec of plan) {
    const a = Number(sec.approximate_time_range.start);
    const b = Number(sec.approximate_time_range.end);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (overlapsRange(ps, pe, a, b)) {
      overlap += Math.max(0, Math.min(pe, b) - Math.max(ps, a));
    }
  }
  return Math.min(1, overlap / duration);
}

/**
 * @param {unknown} coaching
 */
function avoidPhaseIndexes(coaching) {
  const out = new Set();
  if (!coaching || typeof coaching !== "object") return out;
  const arr = /** @type {Record<string, unknown>} */ (coaching).avoid_commenting_on;
  if (!Array.isArray(arr)) return out;
  for (const row of arr) {
    if (!row || typeof row !== "object") continue;
    const pi = Number(/** @type {Record<string, unknown>} */ (row).phase_index);
    if (Number.isInteger(pi) && pi >= 0) out.add(pi);
  }
  return out;
}

/** Gaps on [0, vd] not covered by sorted non-overlapping plan windows. */
function collectTimelineGaps(plan, vd) {
  const d = Number(vd) || 0;
  const sorted = [...plan].sort(
    (a, b) => Number(a.approximate_time_range.start) - Number(b.approximate_time_range.start)
  );
  /** @type {Array<[number, number]>} */
  const gaps = [];
  let cursor = 0;
  for (const sec of sorted) {
    const s = Number(sec.approximate_time_range.start);
    const e = Number(sec.approximate_time_range.end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    if (s > cursor + 1e-3) gaps.push([cursor, Math.min(s, d)]);
    cursor = Math.max(cursor, e);
  }
  if (d > cursor + 1e-3) gaps.push([cursor, d]);
  return gaps.filter(([a, b]) => b - a > 1e-3);
}

/**
 * Clip phase [ps,pe] into gap [gapStart, gapEnd]; respect min span and 40s chunk cap.
 * @returns {{ start: number, end: number } | null}
 */
function clipPhaseIntervalIntoGap(ps, pe, gapStart, gapEnd, vd) {
  const dd = Number(vd) || 0;
  const g0 = clamp(gapStart, 0, dd);
  const g1 = clamp(gapEnd, 0, dd);
  if (g1 <= g0 + 1e-3) return null;

  let s = Math.max(ps, g0);
  let e = Math.min(pe, g1);
  if (e <= s + 1e-3) return null;

  const phaseDur = pe - ps;
  const minNeed = Math.min(MIN_SECTION_SEC, Math.max(1e-3, phaseDur));
  if (e - s + 1e-3 < minNeed) return null;

  if (e - s > HARD_MAX_SECTION_SEC) {
    e = Math.min(e, s + PREF_MAX_CHUNK_SEC);
    if (e <= s + 1e-3) return null;
  }
  return { start: s, end: e };
}

/** @param {unknown} visualClaimVerification @param {number} phaseCount */
function vcvConfidenceByPhase(visualClaimVerification, phaseCount) {
  /** @type {Map<number, string>} */
  const m = new Map();
  const pv = visualClaimVerification?.phase_verification;
  if (!Array.isArray(pv)) return m;
  for (const row of pv) {
    if (!row || typeof row !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (row);
    const pi = Number(o.phase_index);
    if (!Number.isInteger(pi) || pi < 0 || pi >= phaseCount) continue;
    const c = typeof o.confidence === "string" ? o.confidence.trim().toLowerCase() : "low";
    m.set(pi, c);
  }
  return m;
}

/**
 * @param {DensitySectionRow[]} plan
 * @param {unknown} timeline
 * @param {unknown} coaching
 * @param {unknown} visualClaimVerification
 * @param {number} videoDurationSeconds
 * @param {number} phaseCount
 */
export function expandPlanForSpeechCoverage(
  plan,
  timeline,
  coaching,
  visualClaimVerification,
  videoDurationSeconds,
  phaseCount
) {
  const vd = Number(videoDurationSeconds) || 0;
  /** @type {DensitySectionRow[]} */
  let working = plan.map((r) => ({ ...r }));

  let metrics = computeSpeechDensityMetrics(working, vd);

  let guard = 0;
  while (metrics.estimatedCoveragePct < 79.5 && guard < phaseCount + 48) {
    guard += 1;
    const phases = Array.isArray(timeline?.phases) ? timeline.phases : [];
    if (!phases.length) break;

    const avoid = avoidPhaseIndexes(coaching);
    const vcvRank = vcvConfidenceByPhase(visualClaimVerification, phases.length);

    /** @type {Array<{ pi: number, score: number, ps: number, pe: number, obs: string }>} */
    const candidates = [];
    for (let pi = 0; pi < Math.min(phases.length, phaseCount); pi += 1) {
      const p = phases[pi];
      if (!p || typeof p !== "object") continue;
      if (avoid.has(pi)) continue;
      const r = /** @type {Record<string, unknown>} */ (p);
      const ps = Number(r.start);
      const pe = Number(r.end);
      if (!Number.isFinite(ps) || !Number.isFinite(pe) || pe <= ps) continue;
      const cov = phaseCoverageFraction(ps, pe, working);
      const conf = vcvRank.get(pi) ?? "medium";
      const confWt = conf === "high" ? 2.5 : conf === "medium" ? 1.5 : 0.6;
      const obsArr = Array.isArray(r.observable_details) ? r.observable_details : [];
      let obsJoined = "";
      for (const x of obsArr) {
        if (typeof x === "string" && x.trim()) {
          obsJoined += x.trim();
          if (obsJoined.length > 120) break;
        }
      }
      const dd = pe - ps;
      const detailBoost = Math.min(1.5, 1 + obsJoined.length / 400);
      candidates.push({
        pi,
        score: (1 - cov) * confWt * dd * detailBoost,
        ps,
        pe,
        obs: obsJoined.slice(0, 180) || String(r.phase_type || "Rolling segment")
      });
    }

    candidates.sort((a, b) => b.score - a.score);

    const gaps = collectTimelineGaps(working, vd).sort((x, y) => y[1] - y[0] - (x[1] - x[0]));

    /** @type {{ start: number, end: number } | null} */
    let clip = null;
    /** @type {(typeof candidates)[number] | null} */
    let chosenPick = null;
    for (const cand of candidates) {
      if (cand.score <= 1e-3) break;
      for (const [gs, ge] of gaps.length ? gaps : [[0, vd]]) {
        const c = clipPhaseIntervalIntoGap(cand.ps, cand.pe, gs, ge, vd);
        if (c) {
          clip = c;
          chosenPick = cand;
          break;
        }
      }
      if (clip) break;
    }

    if (!clip) {
      const fallback = candidates.find((c) => c.score > 1e-3);
      if (!fallback) break;
      const c = clipPhaseIntervalIntoGap(fallback.ps, fallback.pe, 0, vd, vd);
      if (!c) break;
      clip = c;
      chosenPick = fallback;
    }

    const pick = chosenPick;
    if (!pick || !clip) break;

    const nextNum = maxPlanSectionNumericId(working) + 1;

    /** @type {DensitySectionRow} */
    const add = {
      section_id: `s${nextNum}`,
      label: `Footage beat — phase ${pick.pi}`,
      story_role: "rolling_analysis",
      narrative_priority: "medium",
      coaching_focus: `Stay tight to visuals: ${pick.obs}`,
      linked_phase_indexes: [pick.pi],
      approximate_time_range: { start: clip.start, end: clip.end },
      target_words: 0
    };
    working.push(add);
    working = repairSectionPlanTimeline(working, vd);
    assignTargetWordsToPlan(working);
    metrics = computeSpeechDensityMetrics(working, vd);
  }

  working = repairSectionPlanTimeline(working, vd);
  assignTargetWordsToPlan(working);
  metrics = computeSpeechDensityMetrics(working, vd);

  return { section_plan: working, metrics };
}

/**
 * Full Pass 3 post-process: splits, assigns target_words, expands for coverage floor.
 *
 * @param {Record<string, unknown>} narrativePlan
 * @param {number} videoDurationSeconds
 * @param {unknown} timeline
 * @param {unknown} coaching
 * @param {unknown} visualClaimVerification
 */
export function applySpeechDensityNormalizationToPlan(
  narrativePlan,
  videoDurationSeconds,
  timeline,
  coaching,
  visualClaimVerification
) {
  const vd = Number(videoDurationSeconds) || 0;
  const phases = Array.isArray(timeline?.phases) ? timeline.phases : [];

  const rawPlan = narrativePlan.section_plan;
  if (!Array.isArray(rawPlan) || rawPlan.length === 0) {
    throw new Error("Speech density: narrative plan missing section_plan");
  }

  /** @type {DensitySectionRow[]} */
  let acc = [];
  let sectionsSplitForLength = 0;

  for (const row of rawPlan) {
    if (!row || typeof row !== "object") continue;
    /** @type {DensitySectionRow} */
    const o = /** @type {DensitySectionRow} */ ({ ...(/** @type {object} */ (row)) });
    let s = clamp(Number(o.approximate_time_range?.start ?? 0), 0, vd || 99999);
    let e = clamp(Number(o.approximate_time_range?.end ?? vd), 0, vd || 99999);
    if (e <= s) {
      e = Math.min(vd || s + MIN_SECTION_SEC, s + MIN_SECTION_SEC);
    }
    o.approximate_time_range = { start: s, end: e };

    const { rows, splits } = splitSectionRowOverMaxLength(o, vd);
    sectionsSplitForLength += splits > 0 ? splits : 0;
    acc = acc.concat(rows);
  }

  acc = repairSectionPlanTimeline(acc, vd);
  acc = foldShortVideoSummarySections(acc, vd);
  acc = repairSectionPlanTimeline(acc, vd);
  assignTargetWordsToPlan(acc);

  const phaseCount = Math.max(phases.length, 1);

  const expanded = expandPlanForSpeechCoverage(
    acc,
    timeline,
    coaching,
    visualClaimVerification,
    vd,
    phaseCount
  );
  narrativePlan.section_plan = expanded.section_plan;
  narrativePlan.speech_density_metrics = {
    ...expanded.metrics,
    sectionsSplitForLength,
    flaggedBelowTarget80: expanded.metrics.estimatedCoveragePct < 80
  };

  if (expanded.metrics.estimatedCoveragePct < 70) {
    throw new Error(
      `Speech density validation failed: estimated coverage below 70% (target 80%) — got ${expanded.metrics.estimatedCoveragePct.toFixed(1)}%`
    );
  }

  return narrativePlan;
}

/**
 * @param {{ text?: string }[]} sections
 * @param {(t: string) => number} countWordsFn
 * @param {number} videoDurationSeconds
 */
export function computeSpeechMetricsFromRenderedSections(sections, countWordsFn, videoDurationSeconds) {
  const vd = Number(videoDurationSeconds) || 0;
  const list = Array.isArray(sections) ? sections : [];
  let wc = 0;
  /** @type {Record<string, number>} */
  const perSectionWords = {};
  for (let i = 0; i < list.length; i += 1) {
    const s = list[i];
    const txt = typeof s?.text === "string" ? s.text : "";
    const n = countWordsFn(txt);
    wc += n;
    const sid = typeof s.section_id === "string" ? s.section_id : `s${i}`;
    perSectionWords[sid] = n;
  }
  const estimatedFinalSpeechSeconds = wc / SPEECH_WORDS_PER_SECOND_PLANNING;
  const estimatedFinalCoveragePct = vd > 0 ? (estimatedFinalSpeechSeconds / vd) * 100 : 0;
  return {
    totalWordCount: wc,
    estimatedFinalSpeechSeconds,
    estimatedFinalCoveragePct,
    perSectionWords
  };
}
