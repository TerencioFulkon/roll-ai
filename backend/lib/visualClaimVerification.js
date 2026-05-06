/** @typedef {{ start: number, end: number }} PhaseSpan */

export const VISUAL_CLAIM_VERIFICATION_SCHEMA_VERSION = "visual_claim_verification_v1";

const ROLE_VALUES = new Set([
  "standing",
  "top",
  "bottom",
  "seated_guard",
  "passing",
  "defending",
  "dominant_control",
  "mixed",
  "unclear"
]);

const DOMINANT_VALUES = new Set(["green_shirt", "opponent", "neutral", "mixed", "unclear"]);

const CONFIDENCE_VALUES = new Set(["high", "medium", "low"]);

/**
 * @param {unknown} v
 * @param {Set<string>} allowed
 * @param {string} fallback
 */
function pickEnum(v, allowed, fallback) {
  const s = typeof v === "string" ? v.trim() : "";
  return allowed.has(s) ? s : fallback;
}

/**
 * @param {unknown} raw
 * @param {PhaseSpan[]} phases
 * @returns {Record<string, unknown>}
 */
export function normalizeVisualClaimVerification(raw, phases) {
  const phaseCount = phases.length;
  /** @type {Map<number, Record<string, unknown>>} */
  const byIdx = new Map();

  const r = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : {};
  const pv = Array.isArray(r.phase_verification) ? r.phase_verification : [];

  for (let k = 0; k < pv.length; k += 1) {
    const row = pv[k];
    if (!row || typeof row !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (row);
    const pi =
      typeof o.phase_index === "number" && Number.isInteger(o.phase_index) ? o.phase_index : NaN;
    if (!Number.isFinite(pi) || pi < 0 || pi >= phaseCount) continue;

    const phase = phases[pi];
    const tr =
      o.time_range && typeof o.time_range === "object"
        ? /** @type {Record<string, unknown>} */ (o.time_range)
        : {};
    const trStart = typeof tr.start === "number" && Number.isFinite(tr.start) ? tr.start : phase.start;
    const trEnd = typeof tr.end === "number" && Number.isFinite(tr.end) ? tr.end : phase.end;

    const verified_visible_facts = Array.isArray(o.verified_visible_facts)
      ? o.verified_visible_facts
          .filter((x) => typeof x === "string" && String(x).trim())
          .map((x) => String(x).trim())
      : [];

    const claims_to_avoid = Array.isArray(o.claims_to_avoid)
      ? o.claims_to_avoid
          .filter((x) => typeof x === "string" && String(x).trim())
          .map((x) => String(x).trim())
      : [];

    const allowed_claims = Array.isArray(o.allowed_claims)
      ? o.allowed_claims
          .filter((x) => typeof x === "string" && String(x).trim())
          .map((x) => String(x).trim())
      : [];

    const conf = pickEnum(o.confidence, CONFIDENCE_VALUES, "low");

    byIdx.set(pi, {
      phase_index: pi,
      time_range: { start: trStart, end: trEnd },
      green_shirt_role: pickEnum(o.green_shirt_role, ROLE_VALUES, "unclear"),
      opponent_role: pickEnum(o.opponent_role, ROLE_VALUES, "unclear"),
      dominant_player: pickEnum(o.dominant_player, DOMINANT_VALUES, "unclear"),
      verified_visible_facts,
      allowed_claims,
      claims_to_avoid,
      confidence: conf
    });
  }

  const phase_verification = [];
  for (let i = 0; i < phaseCount; i += 1) {
    const phase = phases[i];
    const existing = byIdx.get(i);
    if (existing) {
      phase_verification.push({
        ...existing,
        time_range: { start: phase.start, end: phase.end }
      });
    } else {
      phase_verification.push({
        phase_index: i,
        time_range: { start: phase.start, end: phase.end },
        green_shirt_role: "unclear",
        opponent_role: "unclear",
        dominant_player: "unclear",
        verified_visible_facts: [],
        allowed_claims: [],
        claims_to_avoid: [],
        confidence: "low"
      });
    }
  }

  const global_warnings = Array.isArray(r.global_warnings)
    ? r.global_warnings
        .filter((x) => typeof x === "string" && String(x).trim())
        .map((x) => String(x).trim())
    : [];

  return {
    schema_version: VISUAL_CLAIM_VERIFICATION_SCHEMA_VERSION,
    phase_verification,
    global_warnings
  };
}
