/**
 * Pass 1 (visual timeline) shape helpers — pure, no I/O.
 */

/**
 * @param {unknown} timeline
 * @returns {asserts timeline is Record<string, unknown> & { phases: unknown[] }}
 */
export function assertPass1TimelineCore(timeline) {
  if (!timeline || typeof timeline !== "object") {
    throw new Error("Pass 1 failed: timeline is not an object");
  }
  const t = /** @type {Record<string, unknown>} */ (timeline);
  if (!Array.isArray(t.phases) || t.phases.length === 0) {
    throw new Error("Pass 1 failed: expected non-empty phases array");
  }
}

/**
 * Default missing optional top-level arrays so downstream JSON.stringify is stable.
 *
 * @param {unknown} timeline
 * @returns {Record<string, unknown>}
 */
export function normalizePass1TimelineOutput(timeline) {
  assertPass1TimelineCore(timeline);
  const t = /** @type {Record<string, unknown>} */ (timeline);
  if (!Array.isArray(t.high_confidence_moments)) {
    t.high_confidence_moments = [];
  }
  if (!Array.isArray(t.low_confidence_moments)) {
    t.low_confidence_moments = [];
  }
  return t;
}

/**
 * @param {number} durationSeconds
 */
export function pass1PhaseDensityGuidance(durationSeconds) {
  const d = Math.max(1, Number(durationSeconds) || 0);
  if (d < 240) {
    return "Phase density: for a roll of this length, aim for about 6-10 visually distinct phases (avoid one giant \"grip fighting\" span unless nothing changes).";
  }
  if (d < 420) {
    return "Phase density: aim for about 8-14 phases.";
  }
  if (d < 720) {
    return "Phase density: aim for about 12-20 phases.";
  }
  return "Phase density: aim for about 14-24 phases where motion warrants — do not invent transitions.";
}
