/**
 * Repair / infer `verified_against_phase_indexes` for Pass 4 voiceover sections
 * when the model or narrative plan omits linkage.
 */

/**
 * @param {number[]} nums
 */
function uniqSorted(nums) {
  return [...new Set(nums)].filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
}

/**
 * Phase spans that overlap [start, end] (inclusive-style interval, same rule as Pass 3 rolling).
 *
 * @param {unknown[]} phases
 * @param {number} rangeStart
 * @param {number} rangeEnd
 * @param {number} phaseCount
 * @returns {number[]}
 */
export function phaseIndexesOverlappingTimeRange(phases, rangeStart, rangeEnd, phaseCount) {
  if (!Array.isArray(phases) || phases.length === 0 || phaseCount < 1) {
    return [];
  }
  const maxI = Math.min(phases.length, phaseCount) - 1;
  const start = Number(rangeStart);
  const end = Number(rangeEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return [];
  }
  /** @type {number[]} */
  const idxs = [];
  for (let i = 0; i <= maxI; i += 1) {
    const p = phases[i];
    if (!p || typeof p !== "object") continue;
    const r = /** @type {Record<string, unknown>} */ (p);
    const ps = Number(r.start);
    const pe = Number(r.end);
    if (!Number.isFinite(ps) || !Number.isFinite(pe)) continue;
    if (pe >= start && ps <= end) {
      idxs.push(i);
    }
  }
  return uniqSorted(idxs);
}

/**
 * @param {unknown} raw
 * @param {number} phaseCount
 * @returns {number[] | null} null if missing/invalid
 */
export function coerceVerifiedPhaseIndexesStrict(raw, phaseCount) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  /** @type {number[]} */
  const nums = [];
  for (const x of raw) {
    const n = typeof x === "number" && Number.isFinite(x) ? Math.trunc(x) : parseInt(String(x), 10);
    if (!Number.isInteger(n)) return null;
    if (n < 0 || n >= phaseCount) return null;
    nums.push(n);
  }
  return uniqSorted(nums);
}

/**
 * Parse labels like "phase_7", "Phase 3", "7" → [7] when in range.
 *
 * @param {unknown} ref
 * @param {number} phaseCount
 * @returns {number[]}
 */
export function inferPhaseIndexesFromReferencesPhase(ref, phaseCount) {
  const s = typeof ref === "string" ? ref.trim() : "";
  if (!s || phaseCount < 1) return [];
  const m = s.match(/phase[_\s-]*(\d+)/i) ?? s.match(/^(\d+)$/);
  if (!m) return [];
  const n = parseInt(m[1], 10);
  if (!Number.isInteger(n) || n < 0 || n >= phaseCount) return [];
  return [n];
}

/**
 * @typedef {{
 *   section_id: string,
 *   repair_method: "copied_from_plan" | "inferred_from_references_phase" | "inferred_from_time_overlap" | "unverified_empty_fallback",
 *   verified_against_phase_indexes: number[]
 * }} VerificationIndexRepairRow
 */

/**
 * @param {{
 *   section_id: string,
 *   rawVerified: unknown,
 *   linkedFallback: number[],
 *   references_phase: string,
 *   planTimeRange: { start: number, end: number } | null,
 *   timelinePhases: unknown[],
 *   phaseCount: number,
 *   sectionLabel: string
 * }} args
 * @returns {{
 *   verified_against_phase_indexes: number[],
 *   unverified_script_section: boolean,
 *   repair: VerificationIndexRepairRow | null,
 *   warning: string | null
 * }}
 */
export function repairPass4SectionVerifiedIndexes(args) {
  const {
    section_id,
    rawVerified,
    linkedFallback,
    references_phase,
    planTimeRange,
    timelinePhases,
    phaseCount
  } = args;

  const fromModel = coerceVerifiedPhaseIndexesStrict(rawVerified, phaseCount);
  if (fromModel && fromModel.length > 0) {
    return {
      verified_against_phase_indexes: fromModel,
      unverified_script_section: false,
      repair: null,
      warning: null
    };
  }

  const fb = Array.isArray(linkedFallback)
    ? uniqSorted(
        linkedFallback.filter((n) => Number.isInteger(n) && n >= 0 && n < phaseCount)
      )
    : [];
  if (fb.length > 0) {
    return {
      verified_against_phase_indexes: fb,
      unverified_script_section: false,
      repair: {
        section_id,
        repair_method: "copied_from_plan",
        verified_against_phase_indexes: fb
      },
      warning: `[Pass 4] ${section_id}: verified_against_phase_indexes repaired from narrative plan linked_phase_indexes`
    };
  }

  const fromRef = inferPhaseIndexesFromReferencesPhase(references_phase, phaseCount);
  if (fromRef.length > 0) {
    return {
      verified_against_phase_indexes: fromRef,
      unverified_script_section: false,
      repair: {
        section_id,
        repair_method: "inferred_from_references_phase",
        verified_against_phase_indexes: fromRef
      },
      warning: `[Pass 4] ${section_id}: verified_against_phase_indexes inferred from references_phase`
    };
  }

  if (
    planTimeRange &&
    Number.isFinite(planTimeRange.start) &&
    Number.isFinite(planTimeRange.end) &&
    planTimeRange.end > planTimeRange.start &&
    Array.isArray(timelinePhases) &&
    timelinePhases.length > 0
  ) {
    const overlap = phaseIndexesOverlappingTimeRange(
      timelinePhases,
      planTimeRange.start,
      planTimeRange.end,
      phaseCount
    );
    if (overlap.length > 0) {
      return {
        verified_against_phase_indexes: overlap,
        unverified_script_section: false,
        repair: {
          section_id,
          repair_method: "inferred_from_time_overlap",
          verified_against_phase_indexes: overlap
        },
        warning: `[Pass 4] ${section_id}: verified_against_phase_indexes inferred from approximate_time_range vs timeline`
      };
    }
  }

  return {
    verified_against_phase_indexes: [],
    unverified_script_section: true,
    repair: {
      section_id,
      repair_method: "unverified_empty_fallback",
      verified_against_phase_indexes: []
    },
    warning: `[Pass 4] ${section_id}: verified_against_phase_indexes unavailable — section marked unverified; grounding will strip unsupported BJJ claims`
  };
}
