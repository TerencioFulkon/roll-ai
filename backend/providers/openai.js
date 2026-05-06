import fs from "node:fs/promises";
import path from "node:path";
import fetch from "node-fetch";
import { config } from "../config/index.js";
import { saveDebugRunFile, getDebugRunsJobDirAbsolute } from "../lib/debugRunsExport.js";
import { normalizePass1TimelineOutput, pass1PhaseDensityGuidance } from "../lib/pass1Timeline.js";
import { analyseVideoWithGemini, sanitizeGeminiErrorForLogs } from "./gemini.js";
import {
  normalizeVisualClaimVerification,
  VISUAL_CLAIM_VERIFICATION_SCHEMA_VERSION
} from "../lib/visualClaimVerification.js";
import {
  phaseIndexesOverlappingTimeRange,
  repairPass4SectionVerifiedIndexes
} from "../lib/voiceoverVerificationIndexRepair.js";
import { applySpeechDensityNormalizationToPlan } from "../lib/speechDensityPlanning.js";

/**
 * Per-job workspace JSON dumps for pipeline inspection (worker temp dir).
 * @param {{ jobId: string, workspaceDir: string, videoDurationSeconds: number } | null | undefined} pipelineDebug
 * @param {string} fileName
 * @param {string} passName
 * @param {{ rawModelOutput?: string | null, parsedOutput?: unknown, normalisedForNextStep?: unknown, provider?: string, providerSource?: string, costUsd?: number, fallbackWarning?: string }} body
 */
async function writePipelineDebugArtifact(pipelineDebug, fileName, passName, body) {
  if (!pipelineDebug?.jobId) {
    return;
  }
  const { jobId, workspaceDir, videoDurationSeconds } = pipelineDebug;
  const envelope = {
    jobId,
    videoDurationSeconds,
    passName,
    createdAt: new Date().toISOString(),
    ...(typeof body.provider === "string" ? { provider: body.provider } : {}),
    ...(typeof body.providerSource === "string" ? { providerSource: body.providerSource } : {}),
    ...(typeof body.costUsd === "number" && Number.isFinite(body.costUsd) ? { costUsd: body.costUsd } : {}),
    ...(typeof body.fallbackWarning === "string" && body.fallbackWarning
      ? { fallbackWarning: body.fallbackWarning }
      : {}),
    rawModelOutput: body.rawModelOutput ?? null,
    parsedOutput: body.parsedOutput ?? null,
    normalisedForNextStep: body.normalisedForNextStep ?? null
  };
  await saveDebugRunFile(jobId, fileName, envelope);
  if (!workspaceDir) {
    return;
  }
  const p = path.join(workspaceDir, fileName);
  const json = JSON.stringify(envelope, null, 2);
  await fs.writeFile(p, json, "utf8");
  console.log(`[job ${jobId}] pipeline debug artifact: ${p}`);
}

const PASS_ONE_SYSTEM_PROMPT =
  "You are a BJJ VISUAL ANALYSIS system. Be epistemically cautious: prefer plain limb/body/contact language unless a specific grip or control type is unmistakable in-frame. Never invent hooks, belts, crosses, collars, submissions, or back control without clear evidence. Respond with JSON only. Never refuse or apologise.";

/** ~2.3 words per second for narration budgeting, TTS timing validation, and QA. */
export const NARRATION_WORDS_PER_SECOND = 2.3;

/** Pass 3 rolling voiceover: minimum lane length (seconds). */
const PASS3_WINDOW_MIN_DURATION_SEC = 14;
/** Hard maximum window length — split beyond this even if contiguous. */
const PASS3_WINDOW_MAX_DURATION_SEC = 45;
const PASS3_DIRECTOR_WORDS_PER_SECOND = 2;
const PASS3_DIRECTOR_WORD_BUFFER_SEC = 3;

/** Silence policy for near-continuous review (excluding Pass-2-approved low-value stretches). */
const PASS3_SILENCE_GAP_MIN_SEC = 2;
const PASS3_SILENCE_GAP_TARGET_SEC = 3;
const PASS3_SILENCE_GAP_MAX_HARD_SEC = 8;
/** Repair when coverage dips below this (after expansion). */
const PASS3_COVERAGE_REPAIR_BELOW_PCT = 60;
/** Under ~3 minutes, model should aim ~65–80% coverage; normalization only enforces the repair floor. */
const PASS3_SHORT_VIDEO_MAX_SEC = 180;

const PASS_TWO_SCHEMA_VERSION = "phase2_v4_coaching_led_lessons";

const PASS_THREE_SCHEMA_VERSION = "narrative_v3_coaching_intent";

const PASS_FOUR_SCHEMA_VERSION = "narrative_v3_coaching_led_script_v1";

const PASS_TWO_SYSTEM_PROMPT =
  "You are an experienced BJJ coach reading ONLY the structured Pass 1 timeline JSON — not raw video. Your job is COACHING-LED and STORY-LED for THIS SINGLE ROLL: the tracked athlete must walk away with CLEAR improvement paths, tactical lessons, and concrete training angles — NOT a play-by-play description. Forbidden: generic syllabus labels as theme titles. Theme strings read like vignettes tied to timestamps and Pass 1 evidence. Never invent grips, submissions, or named controls not supported by observable_details/key_events/visible_grips_or_controls from Pass 1; when positional detail is unsure, anchor lessons in visible positional principles — posture, pressure, timing, space, frames, hip height, distance, control-before-transition, recovery timing. Honour Pass 1 visual_certainty when setting confidence. PRAISING: praise only when warranted by visible moments — specific to WHAT worked and WHY (cite phase evidence via evidence_basis/visual_evidence). No generic encouragement (reject phrasing like 'good job', 'maintaining position well' unless you explain the biomechanic/frame reason from visible facts). If nothing genuinely praiseworthy is visible across the themed phases, write an honest constructive note in coaching_lesson instead of fabricating praise. OPPONENT: only highlight opponent success when it directly teaches the TRACKED ATHLETE — every opponent note must tie to the user's corrective lesson ('the lesson for you is…'). Roll-level coverage — across ALL themes AND moments collectively surface: ≥1 credible user strength (or frank gap if none); ≥1 user improvement lever; ≥1 opponent-driven problem linked to user's learning; ≥1 actionable drill/principle (suggested_drill). If dominated: refinement (consolidating control, denying recovery, transition order). If mostly defensive: survival (frames sooner, hips, guard recovery, posture, denying head/chest milestones). Respond with JSON only.";

/** Narrative planning — designs story structure, no timing windows. */
const PASS_THREE_SYSTEM_PROMPT =
  "You are the NARRATIVE PLANNING AGENT for a retrospective BJJ COACHING review (not descriptive commentary). Plan sections so the final voiceover teaches: each segment must justify why the watcher trains differently — minimise sections whose only job is explaining what visibly happened without a lesson lever. Coaching interpretation fields (coaching_lesson, improvement_area, drills, opponent-linked lessons) are primary fuel for coaching_focus — do not orphan them behind generic scene-setting. Story structure stays coherent; visual claim verification still overrides factual dominance/positions. Respond with JSON only.";

/** Natural scriptwriting — continuous voiceover; obeys Visual Claim Verification when supplied. */
const PASS_FOUR_SYSTEM_PROMPT =
  "You write continuous COACHING-LED voiceover for a retrospective BJJ roll review — club coach giving lessons, NOT sports broadcast or detached description. VISUAL CLAIM VERIFICATION is law: use allowed_claims as the whitelist — never upgrade claims beyond merged allowed_claims/verified_visible_facts for verified_against_phase_indexes. When factual detail is thin, pivot to POSITIONAL PRINCIPLES (timing, posture, frames, pressure, hips, distance, space, control-before-progression, responding to opponent movement) anchored to what verification allows — still deliver useful coaching rather than thinning into neutral description alone. Praise only when warranted and ALWAYS tie praise to WHY it worked visually (verification-safe). Prefer hedged framing when uncertain. Ban pure play-by-play and generic narration (see Pass 4 user instruction negatives). Respond with JSON only.";

const INPUT_COST_PER_MILLION = 2.5;
const OUTPUT_COST_PER_MILLION = 10;

const PASS1_USER_TIMELINE_STATIC = `Watch these frames from a Brazilian Jiu-Jitsu training roll sampled at 4 frames per second.

Produce a VISUAL TIMELINE only — what the camera shows: bodies, contact, orientation, motion. Later passes do coaching; THIS pass is cautious observation only.

NAMING GRIPS / CONTROLS — only when clearly visible:
• If a specific BJJ control is not unmistakable, do NOT name it. Use plain visual language instead.
• visible_grips_or_controls: list ONLY controls you can point to with confidence from pixels (e.g. clear two-on-one on a sleeve you can see). If naming would be a guess, leave that entry out and describe it in observable_details instead.
• GOOD phrasing (use in observable_details or prose fields when unsure): "green t-shirt appears to control the opponent's upper body"; "one arm is wrapped near the head/shoulder area"; "legs are entangled, exact configuration unclear".
• BAD unless unmistakable in-frame: naming "seatbelt grip", "hooks", "crossface", "underhook", "overhook", "collar tie", "shin grip", "cross-collar", "body lock", "kimura grip", "submission attempt", "back control with hooks", etc.
• Submissions and back control: only assert if the threat or control is visually obvious; otherwise describe geometry neutrally and add doubt to uncertainties.

PER-PHASE FIELDS:
• visual_certainty: exactly one of "high" | "medium" | "low" — your confidence that the phase description matches what is on screen.
• observable_details: array of short strings — ONLY neutral visual facts (who is where, limbs, pressure direction, entanglement at a glance). No coaching, no "should", no drilling advice.
• visual_relevance: why this phase matters for LATER analysis of the roll — causal / structural only, NOT advice. Example OK: "This phase matters because it shows the transition from standing into seated guard." BAD: "Understanding grip exchanges is foundational."
• user_role: the TRACKED ATHLETE'S role in THIS phase — exactly one of: standing_player | top_player | bottom_player | seated_guard_player | passing_player | defensive_player | attacking_player | unclear. The tracked athlete is whoever practitioner context identifies, or whoever you can consistently recognise by visible attire across the clip. Never use the words "practitioner" or "opponent" as the role value; use position/action enums only.
• what_changed_from_previous_phase: for phase index 0, use a short string like "Opening position at start of clip" or "First observed position". For later phases, state the concrete visual change vs the prior phase (not generic "continued rolling").

Also keep:
• Partition 0..video_duration_seconds with no large unexplained gaps.
• top_player / bottom_player: SHORT observable labels (shirt colour, gi colour, near/far camera). Never invent marks not seen.
• phase_type: concrete micro-segment label; avoid vague mush.
• uncertainties: list anything doubtful; prefer listing uncertainty over guessing a named technique.
• key_events: short visual beats in the phase.
• outcome: neutral visual result of the segment if any.

Also include (required) roll_title: catalogue-style label — max ~54 characters — concrete chain. No filenames, quotes, markdown, bullets, ellipsis theatre, trailing full stop, or generic "training roll".

Include summary: one concise paragraph (past tense) for catalogue UI.

Include user_identity_assumption: one short sentence on how you tell the TRACKED ATHLETE apart from their partner (use visible apparel/position; cite practitioner description from context when given); admit uncertainty when needed.

Return JSON only, exact shape:
{
  "video_duration_seconds": number,
  "roll_title": string,
  "summary": string,
  "user_identity_assumption": string,
  "phases": [
    {
      "start": number,
      "end": number,
      "phase_type": string,
      "top_player": string,
      "bottom_player": string,
      "user_role": "standing_player" | "top_player" | "bottom_player" | "seated_guard_player" | "passing_player" | "defensive_player" | "attacking_player" | "unclear",
      "position": string,
      "specific_position_details": string,
      "visible_grips_or_controls": [string],
      "observable_details": [string],
      "key_events": [string],
      "what_changed_from_previous_phase": string,
      "outcome": string,
      "visual_relevance": string,
      "uncertainties": [string],
      "visual_certainty": "high" | "medium" | "low"
    }
  ],
  "high_confidence_moments": [
    { "timestamp": number, "what_is_visible": string, "why_it_matters": string }
  ],
  "low_confidence_moments": [
    { "timestamp": number, "reason": string }
  ]
}`;

const PASS3_NARRATIVE_PLAN_INSTRUCTION = `Design the narrative structure for this BJJ roll coaching review.

VIDEO DURATION: {videoDurationSeconds} seconds.

NARRATIVE STYLES — choose the most fitting one:
• "technical_breakdown": structured, position-by-position analysis
• "momentum_analysis": focus on control and initiative shifts
• "defensive_survival": athlete was primarily reactive or defensive
• "guard_retention_study": focus on guard work and passing attempts
• "failed_attack_breakdown": recurring attack patterns that did not finish
• "beginner_explanation": simpler language, fundamentals-first framing

STORY ROLES — each section must use exactly one:
• "intro_context": sets the scene, opening position, first exchange
• "rolling_analysis": describes what is happening and why it matters
• "main_coaching_point": the most important teachable moment
• "transition_explanation": explains a key position or role change
• "defensive_breakdown": analyses reactive or survival moments
• "summary_takeaway": closes the review with the key thread

SECTION COUNT: 4–8 sections for most rolls; fewer for short clips under 90 seconds.

COACHING_INTENT (required on every section_plan row — choose exactly one):
• "praise": specific positive beat with causal why (grounded; omit if no credible beat — then use tactical_lesson instead)
• "correction": tracked athlete adjustment / decision fix
• "opponent_success": opponent action framed ONLY as the driver of the tracked athlete's lesson
• "tactical_lesson": principle + how to apply next rep
• "drill_recommendation": concrete training rep/tempo constraint tied to roll themes
• "summary_takeaway": closing synthesis ONLY — must appear exactly once on the FINAL planned section and pair with story_role summary_takeaway unless impossible.

DISTRIBUTION RULE: at least ~60% of sections (round up) MUST use coaching_intent correction OR tactical_lesson OR opponent_success OR drill_recommendation combined — NOT counting the lone summary_takeaway closing row. Do NOT create sections that only describe motion; every section's coaching_focus must cite which coaching interpretation lesson/drill/improvement threads it advances.

FINAL SECTION CONTRACT: the chronologically last section must have coaching_intent "summary_takeaway". Its coaching_focus must explicitly demand closing lines that state (a) the MAIN thing to work on from this roll referencing repeated themes (no brand-new observations), AND (b) ONE concrete drill/training focus echoed from earlier themes/drills — forbid introducing novel positions not already discussed.

APPROXIMATE TIME RANGES: give each section an approximate_time_range mapping to the part of the footage it discusses. These are soft guides for the scriptwriter — not hard timing constraints. No single section's time span should exceed ~40 seconds — if a topic needs more time, plan multiple adjacent sections instead of one huge window.

ENERGY CURVE: 4–6 strings describing the pacing arc, chosen from: calm_opening, slow_technical, rising_engagement, scramble, explosion, pressure, grind, defensive, survival, reflective_close, summary

EVIDENCE: section coaching_focus must cite what the visual timeline or coaching interpretation actually shows — no invented techniques.

When Visual Claim Verification is supplied: section arcs and coaching_focus must agree with verified dominant_player, roles, verified_visible_facts, and must not rely on claims listed under claims_to_avoid for those phases.

OUTPUT JSON ONLY:
{
  "narrative_style": string,
  "primary_arc": string (one sentence — the main story of this roll),
  "secondary_arc": string (one sentence — secondary thread, or empty string if none),
  "energy_curve": [string, ...],
  "section_plan": [
    {
      "section_id": "s1",
      "label": string (short title for this section),
      "story_role": string,
      "narrative_priority": "high" | "medium" | "low",
      "coaching_focus": string (what the scriptwriter should address — must include explicit lesson + improvement hook, not just scene setup),
      "coaching_intent": "praise" | "correction" | "opponent_success" | "tactical_lesson" | "drill_recommendation" | "summary_takeaway",
      "linked_phase_indexes": [number, ...],
      "approximate_time_range": { "start": number, "end": number },
      "target_words": number (optional — if omitted or zero, server computes from duration)
    }
  ]
}`;

const PASS4_SCRIPT_INSTRUCTION = `Write spoken COACHING-LED voiceover — instructive retrospective review, NOT descriptive sports narration.

WORD BUDGET (mandatory — from narrative plan.section_plan[].target_words for that section_id):
• For EACH section row, aim for roughly target_words spoken words — strive for target_words − 10 through target_words + 10 spoken words inclusive.
• The server enforces a minimum near that band (targets long sections harder than very short splits). Undershooting causes automatic regeneration — extend with grounded coaching clauses, hedged principles, and concrete next-rep cues rather than shortening.

AUTHORITATIVE WHITELIST (must obey):
• For each narration section you MUST only assert dominance, positional control, pressure, passing, guard work, defence/defense, attack, escapes, mounts, pins, submissions, sweeps when that exact idea appears in merged allowed_claims OR verified_visible_facts for EVERY phase_index listed in verified_against_phase_indexes.
• Uncertainty rule — VISIBILITY ALLOWLIST FALLBACK COACHING: if granular positional assertions aren't warranted, still coach with principles (timing, posture/frames, hip connection, pressure sequencing, distance, closing space, control-before-next-transition, reading opponent recovery) phrased cautiously and tied to what verification lists as allowed visible facts.
• NEVER invent named grips or finishes absent from allowed_claims / verified_visible_facts — teach decision-making and positional habits instead.

SECTION MICRO-STRUCTURE — every non-summary section must knit three beats into one flowing paragraph:
(1) Brief anchor to what is visually verifiable (one or two short clauses max).
(2) The coaching lesson / mistake pattern / principle (this is the bulk).
(3) A concrete improvement lever: decision to change next time, positional habit, or compact drill/tempo cue drawn from coaching interpretation themes.

coaching_intent from the narrative plan guides tone:
• praise → only if moments truly merit it; explain WHY it worked mechanically.
• opponent_success → frame opponent action as the REASON the tracked athlete must adjust; always loop to the user's lesson.
• drill_recommendation → name a tight rep constraint (e.g., "hold three seconds before advancing") without inventing unsupported techniques.
• tactical_lesson / correction → default teaching spine.
• summary_takeaway → reserved for the CLOSING section only (see below).

FORBIDDEN / LOW-VALUE DOMINANT PATTERNS — do not let these carry a section:
• Colour-jersey headline play-by-play ("green shirt pressures…") unless immediately followed by a lesson clause.
• Standalone narration with no transferable lesson ("bottom player tries to hip escape").
• Thin blow-by-blow: "maintains top pressure"; "attempts an escape"; "dynamic exchange"; "both athletes scramble" WITHOUT an explicit corrective or principle clause in the SAME section.

CLOSING SUMMARY SECTION — the chronologically FINAL narrative plan row (coaching_intent summary_takeaway) MUST end spoken copy with BOTH recognisable stems (light paraphrase OK but keep clear):
• "The main thing to work on from this roll is …"
• "A good drill or training focus would be …"
Echo ONLY themes/drills already argued earlier — zero brand-new factual claims.

OPENERS you may weave (not obligatory every line):
"What we can say here is…" / "The clear change is…" / "The useful correction is…" / "The lesson looping back for you is…"

FORBIDDEN LANGUAGE (still banned):
circular dance; tables turn; defensive shield; offensive weapon; culmination; pivotal; crucial; vital; strategic understanding; leaving a lasting impression; proactive engagement; adaptive strategies; momentum carries forward; committed effort at control.
Also ban documentary flourish.

STRUCTURE:
• Emit EXACTLY one JSON entry per narrative plan row in the SAME ORDER with EXACT matching section_id (including splits like "s3a"). Do NOT merge segments.
• story_role MUST copy from narrative plan verbatim per row.

OUTPUT JSON ONLY — INCLUDE schema_version exact string "${PASS_FOUR_SCHEMA_VERSION}":
{
  "sections": [
    {
      "section_id": string,
      "start": number (copy approximate_time_range.start from narrative plan),
      "end": number (copy approximate_time_range.end from narrative plan),
      "story_role": string,
      "text": string,
      "word_count": number,
      "references_phase": string,
      "verified_against_phase_indexes": [number, ...]
    }
  ],
  "schema_version": "${PASS_FOUR_SCHEMA_VERSION}"
}`;

const VISUAL_CLAIM_VERIFICATION_SYSTEM_PROMPT =
  "You are the VISUAL CLAIM VERIFICATION stage for Brazilian Jiu-Jitsu roll footage. You do NOT coach or narrate. Your job is conservative fact verification only. Use sampled frames plus the visual timeline JSON; coaching interpretation is an unverified hypothesis you may contradict. Never infer dominance in one phase from another; never let a story arc override what you see in that phase. Do NOT name specific techniques unless clearly visible. RESPOND WITH JSON ONLY. Dominance rule: NEVER set dominant_player to green_shirt or opponent unless verified_visible_facts explicitly describe sustained positional advantage visible in-frame: unmistakable top/bottom control keeping someone flattened, pinning pressure, completed or clearly held passes, mount, back control WITH control (not fleeting), side control pinning, or a clearly dominant positional chain. Transitioning toward the ground is NOT dominance; an attempted clamp or scramble is NOT dominance; leg entanglement visible or dynamic standing grip fighting is NOT dominance. If initiative shifts, control is disputed, or the phase is transitional, dominant_player MUST be neutral, mixed, or unclear—not green_shirt or opponent. When visual confidence is ambiguous, use unclear or mixed. If verification confidence would be medium or low, downstream voiceover MUST hedge—note that in global_warnings when useful. Respond with JSON only. Never apologise, never refuse.";

const PASS_FOUR_QA_SYSTEM_PROMPT =
  "You are an internal QA evaluator for an automated BJJ video coaching pipeline. Score PIPELINE OUTPUT QUALITY for developers only — not athlete performance. Emphasise coaching-led output: concrete improvement, opponent-as-lesson linkage, drills, and grounded closing takeaways; penalise description-only narration. Return JSON with actionable_feedback and improvement_identified sub-scores alongside the other dimensions. Respond with JSON only. Never refuse.";

/** Weights include actionable coaching dimensions (Pass 7 QA). */
const QA_WEIGHTS = {
  visual_accuracy: 0.16,
  coaching_usefulness: 0.16,
  timing_accuracy: 0.15,
  speech_coverage: 0.12,
  output_compliance: 0.09,
  narrative_coherence: 0.2,
  actionable_feedback: 0.07,
  improvement_identified: 0.05
};

// ---------------------------------------------------------------------------
// Pass 3 — Narrative Planning Agent
// ---------------------------------------------------------------------------

const PASS3_VALID_NARRATIVE_STYLES = new Set([
  "technical_breakdown",
  "momentum_analysis",
  "defensive_survival",
  "guard_retention_study",
  "failed_attack_breakdown",
  "beginner_explanation"
]);

const PASS3_VALID_STORY_ROLES = new Set([
  "intro_context",
  "rolling_analysis",
  "main_coaching_point",
  "transition_explanation",
  "defensive_breakdown",
  "summary_takeaway"
]);

const PASS3_VALID_PRIORITIES = new Set(["high", "medium", "low"]);

const PASS3_VALID_COACHING_INTENTS = new Set([
  "praise",
  "correction",
  "opponent_success",
  "tactical_lesson",
  "drill_recommendation",
  "summary_takeaway"
]);

const PASS3_COACHING_HEAVY_INTENTS = new Set([
  "correction",
  "opponent_success",
  "tactical_lesson",
  "drill_recommendation"
]);

/** @param {unknown} raw @param {string} fallback */
function normalizePass3CoachingIntent(raw, fallback) {
  const v = typeof raw === "string" ? raw.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (PASS3_VALID_COACHING_INTENTS.has(v)) return v;
  return fallback;
}

/** Ensure ≥60% of non-summary sections carry heavy coaching intents (deterministic uplift). */
function enforceSectionPlanCoachingIntentMinimum(section_plan) {
  if (!Array.isArray(section_plan) || section_plan.length === 0) return;
  const nonSummaryIndexes = [];
  for (let i = 0; i < section_plan.length; i += 1) {
    const ci = String(/** @type {Record<string, unknown>} */ (section_plan[i]).coaching_intent || "");
    if (ci !== "summary_takeaway") nonSummaryIndexes.push(i);
  }
  const nBody = nonSummaryIndexes.length;
  if (nBody === 0) return;
  const needHeavy = Math.ceil((60 * nBody) / 100);

  let heavy = nonSummaryIndexes.filter((idx) =>
    PASS3_COACHING_HEAVY_INTENTS.has(
      String(/** @type {Record<string, unknown>} */ (section_plan[idx]).coaching_intent || "")
    )
  ).length;

  /** @returns {number} sort key — lower uplift first */
  const upliftPenalty = (idx) => {
    const row = /** @type {Record<string, unknown>} */ (section_plan[idx]);
    const ci = String(row.coaching_intent || "");
    const sr = String(row.story_role || "");
    if (PASS3_COACHING_HEAVY_INTENTS.has(ci)) return 1000;
    let p = 0;
    if (sr === "intro_context") p -= 25;
    if (ci === "praise") p -= 15;
    if (sr === "main_coaching_point") p += 5;
    return p;
  };

  const sortedIdx = [...nonSummaryIndexes].sort((a, b) => upliftPenalty(a) - upliftPenalty(b));

  for (const i of sortedIdx) {
    if (heavy >= needHeavy) break;
    const row = /** @type {Record<string, unknown>} */ (section_plan[i]);
    const ci = String(row.coaching_intent || "");
    if (PASS3_COACHING_HEAVY_INTENTS.has(ci)) continue;
    row.coaching_intent = "tactical_lesson";
    const cf = typeof row.coaching_focus === "string" ? row.coaching_focus.trim() : "";
    if (!/\[Coaching-led\]/i.test(cf)) {
      row.coaching_focus =
        cf.length === 0
          ? "[Coaching-led] Lead with tactical principle + one concrete athlete adjustment — forbid description-only narration."
          : `${cf} [Coaching-led] Lead with tactical lesson/improvement, not play-by-play.`;
    }
    heavy += 1;
  }
}

/**
 * Builds the Pass 3 user message prompt with video duration interpolated.
 * @param {number} videoDurationSeconds
 */
function buildPassThreeNarrativePlanPrompt(videoDurationSeconds) {
  return PASS3_NARRATIVE_PLAN_INSTRUCTION
    .split("{videoDurationSeconds}")
    .join(String(videoDurationSeconds));
}

/**
 * Validates and normalises the Pass 3 (Narrative Planning Agent) JSON output.
 * @param {unknown} raw
 * @param {number} videoDurationSeconds
 * @param {number} phaseCount
 * @returns {Record<string, unknown>}
 */
function normalizePass3NarrativePlan(raw, videoDurationSeconds, phaseCount, timeline) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Pass 3 failed: plan is not an object");
  }
  const r = /** @type {Record<string, unknown>} */ (raw);

  // Narrative style — default gracefully if unrecognised
  let style = typeof r.narrative_style === "string" ? r.narrative_style.trim() : "";
  if (!PASS3_VALID_NARRATIVE_STYLES.has(style)) {
    console.warn(`[Pass 3] unrecognised narrative_style "${style}", defaulting to technical_breakdown`);
    style = "technical_breakdown";
  }

  // Primary arc
  if (typeof r.primary_arc !== "string" || !r.primary_arc.trim()) {
    throw new Error("Pass 3 failed: primary_arc required");
  }

  // Energy curve
  if (!Array.isArray(r.energy_curve) || r.energy_curve.length === 0) {
    throw new Error("Pass 3 failed: energy_curve array required");
  }
  const energy_curve = r.energy_curve.filter((x) => typeof x === "string" && String(x).trim());

  // Section plan
  if (!Array.isArray(r.section_plan) || r.section_plan.length < 2) {
    throw new Error("Pass 3 failed: section_plan needs at least 2 sections");
  }

  const maxPhase = Math.max(0, phaseCount - 1);
  const phases = Array.isArray(timeline?.phases) ? /** @type {unknown[]} */ (timeline.phases) : [];

  const section_plan = r.section_plan.map((sec, i) => {
    if (!sec || typeof sec !== "object") {
      throw new Error(`Pass 3 failed: section_plan[${i}] must be an object`);
    }
    const s = /** @type {Record<string, unknown>} */ (sec);

    const section_id =
      typeof s.section_id === "string" && s.section_id.trim()
        ? s.section_id.trim()
        : `s${i + 1}`;

    const label = typeof s.label === "string" ? s.label.trim() : "";

    const rawRole = typeof s.story_role === "string" ? s.story_role.trim() : "";
    const story_role = PASS3_VALID_STORY_ROLES.has(rawRole) ? rawRole : "rolling_analysis";
    if (!PASS3_VALID_STORY_ROLES.has(rawRole)) {
      console.warn(`[Pass 3] section_plan[${i}].story_role "${rawRole}" unrecognised, using rolling_analysis`);
    }

    const rawPriority =
      typeof s.narrative_priority === "string" ? s.narrative_priority.trim() : "";
    const narrative_priority = PASS3_VALID_PRIORITIES.has(rawPriority) ? rawPriority : "medium";

    const coaching_focus =
      typeof s.coaching_focus === "string" ? s.coaching_focus.trim() : "";

    let linked_phase_indexes = Array.isArray(s.linked_phase_indexes)
      ? s.linked_phase_indexes
          .map((x) => Number(x))
          .filter((n) => Number.isInteger(n) && n >= 0 && n <= maxPhase)
      : [];

    // approximate_time_range — soft guidance for the scriptwriter, not enforced
    let approximate_time_range = { start: 0, end: videoDurationSeconds };
    if (s.approximate_time_range && typeof s.approximate_time_range === "object") {
      const tr = /** @type {Record<string, unknown>} */ (s.approximate_time_range);
      const ts = Number(tr.start);
      const te = Number(tr.end);
      if (Number.isFinite(ts) && Number.isFinite(te) && te > ts) {
        approximate_time_range = {
          start: Math.max(0, Math.min(ts, videoDurationSeconds)),
          end: Math.max(0, Math.min(te, videoDurationSeconds))
        };
      }
    }

    if (linked_phase_indexes.length === 0 && phases.length > 0) {
      const inferred = phaseIndexesOverlappingTimeRange(
        phases,
        approximate_time_range.start,
        approximate_time_range.end,
        phaseCount
      ).filter((n) => n >= 0 && n <= maxPhase);
      linked_phase_indexes = inferred;
    }

    const fallbackIntent =
      rawRole === "summary_takeaway"
        ? "summary_takeaway"
        : rawRole === "intro_context"
          ? "tactical_lesson"
          : "tactical_lesson";
    const coaching_intent = normalizePass3CoachingIntent(s.coaching_intent, fallbackIntent);

    return {
      section_id,
      label,
      story_role,
      narrative_priority,
      coaching_focus,
      coaching_intent,
      linked_phase_indexes,
      approximate_time_range
    };
  });

  enforceSectionPlanCoachingIntentMinimum(section_plan);

  return {
    narrative_style: style,
    primary_arc: r.primary_arc.trim(),
    secondary_arc: typeof r.secondary_arc === "string" ? r.secondary_arc.trim() : "",
    energy_curve,
    section_plan
  };
}

// ---------------------------------------------------------------------------
// Pass 4 — Natural Scriptwriting Agent
// ---------------------------------------------------------------------------

/**
 * Minimum words Pass 4 accepts versus Pass 3 `target_words`.
 * Caps at legacy (target − 10) but allows shortfalls on splits via a ~69.5% floor
 * so one tight section doesn't fail jobs when copy is coaching-dense yet slightly lean.
 *
 * @param {number} twGoal
 * @returns {number}
 */
function pass4MinWordsForTarget(twGoal) {
  const tw = Math.floor(Number(twGoal) || 0);
  if (tw <= 0) return 8;
  const legacySlack = Math.max(8, tw - 10);
  const ratioFloor = Math.max(8, Math.floor(tw * 0.695));
  return Math.min(legacySlack, ratioFloor);
}

/**
 * Validates and normalises voiceover JSON from the Natural Scriptwriting stage.
 * @param {unknown} raw
 * @param {Array<Record<string, unknown>>} sectionPlan
 * @param {number} phaseCount
 * @param {Record<string, unknown> | null | undefined} timeline
 * @returns {Record<string, unknown>}
 */
function normalizePass4ContinuousScript(raw, sectionPlan, phaseCount, timeline) {
  if (!phaseCount || !Number.isFinite(phaseCount) || phaseCount < 1) {
    throw new Error("Voiceover normalization failed: invalid phase count");
  }
  if (!Array.isArray(sectionPlan) || sectionPlan.length === 0) {
    throw new Error("Pass 4 failed: narrative plan section_plan missing");
  }
  if (!raw || typeof raw !== "object") {
    throw new Error("Pass 4 failed: payload is not an object");
  }
  const r = /** @type {Record<string, unknown>} */ (raw);
  const sections = r.sections;

  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error("Pass 4 failed: sections array required");
  }

  if (sections.length < sectionPlan.length) {
    throw new Error(
      `Pass 4 failed: model returned ${sections.length} sections but narrative plan expects ${sectionPlan.length} matching section_ids`
    );
  }

  const timelinePhases = Array.isArray(timeline?.phases) ? /** @type {unknown[]} */ (timeline.phases) : [];

  /** @type {Map<string, { start: number, end: number }>} */
  const planTimeRangeById = new Map();
  /** @type {Map<string, number[]>} */
  const linkedPhasesBySectionId = new Map();
  /** @type {Map<string, number>} */
  const planTargetWordsById = new Map();
  for (const planSec of sectionPlan) {
    if (!planSec || typeof planSec !== "object") continue;
    const pr = /** @type {Record<string, unknown>} */ (planSec);
    const id = typeof pr.section_id === "string" ? pr.section_id.trim() : "";
    if (!id) continue;
    const atr = pr.approximate_time_range;
    if (atr && typeof atr.start === "number" && typeof atr.end === "number") {
      planTimeRangeById.set(id, { start: atr.start, end: atr.end });
    }
    const lp = Array.isArray(pr.linked_phase_indexes)
      ? pr.linked_phase_indexes
          .map((x) => Number(x))
          .filter((n) => Number.isInteger(n) && n >= 0 && n < phaseCount)
      : [];
    linkedPhasesBySectionId.set(id, [...new Set(lp)].sort((a, b) => a - b));
    const ptw = Number(pr.target_words);
    if (Number.isFinite(ptw) && ptw >= 0) {
      planTargetWordsById.set(id, Math.floor(ptw));
    }
  }

  const planTimeRanges = sectionPlan
    .map((p) => {
      if (!p || typeof p !== "object") return null;
      const atr = /** @type {Record<string, unknown>} */ (p).approximate_time_range;
      return atr && typeof atr.start === "number" && typeof atr.end === "number"
        ? { start: atr.start, end: atr.end }
        : null;
    })
    .filter(Boolean);

  /** @type {Map<string, Record<string, unknown>>} */
  const modelById = new Map();
  for (const sec of sections) {
    if (!sec || typeof sec !== "object") continue;
    const s = /** @type {Record<string, unknown>} */ (sec);
    const sid = typeof s.section_id === "string" ? s.section_id.trim() : "";
    if (!sid) continue;
    modelById.set(sid, s);
  }

  /** @type {Record<string, unknown>[]} */
  const out = [];

  /** @type {Array<{ section_id: string, repair_method: string, verified_against_phase_indexes: number[] }>} */
  const verification_index_repairs = [];
  /** @type {string[]} */
  const pass4_verification_warnings = [];

  for (let i = 0; i < sectionPlan.length; i += 1) {
    const planRow = /** @type {Record<string, unknown>} */ (sectionPlan[i]);
    const section_id =
      typeof planRow.section_id === "string" && planRow.section_id.trim()
        ? planRow.section_id.trim()
        : `s${i + 1}`;

    const s = modelById.get(section_id);
    if (!s || typeof s !== "object") {
      throw new Error(
        `Pass 4 failed: missing narration for narrative plan section_id "${section_id}" (model must emit exactly one section per row in any order)`
      );
    }

    const text = typeof s.text === "string" ? s.text.trim() : "";
    if (!text || text.length < 10) {
      throw new Error(`Pass 4 failed: section "${section_id}" text is empty or too short`);
    }

    const word_count = countWordsInText(text);
    const twGoal = planTargetWordsById.get(section_id) ?? 0;
    const minWordsForSection = pass4MinWordsForTarget(twGoal);
    if (word_count < minWordsForSection) {
      throw new Error(
        `Pass 4 failed: section "${section_id}" only ${word_count} words — need at least ${minWordsForSection} (budget vs target_words ${twGoal})`
      );
    }

    const story_role =
      typeof s.story_role === "string" ? s.story_role.trim() : String(planRow.story_role || "rolling_analysis").trim();

    const planStory =
      typeof planRow.story_role === "string" ? String(planRow.story_role).trim() : "";
    const coaching_intent = normalizePass3CoachingIntent(
      planRow.coaching_intent,
      planStory === "summary_takeaway" ? "summary_takeaway" : "tactical_lesson"
    );

    const planRange =
      planTimeRangeById.get(section_id) ?? (i < planTimeRanges.length ? planTimeRanges[i] : null);

    const modelStart = typeof s.start === "number" && Number.isFinite(s.start) ? s.start : null;
    const modelEnd = typeof s.end === "number" && Number.isFinite(s.end) ? s.end : null;

    const start = modelStart ?? planRange?.start ?? 0;
    const end = modelEnd ?? planRange?.end ?? 0;

    if (modelStart === null || modelEnd === null) {
      console.warn(
        `[Pass 4] section (${section_id}) missing start/end from model — using plan fallback: [${start}, ${end}]`
      );
    }

    const references_phase =
      typeof s.references_phase === "string" ? s.references_phase.trim() : "";

    const linkedFallback = linkedPhasesBySectionId.get(section_id) ?? [];

    const planTimeForRepair =
      planRange && typeof planRange.start === "number" && typeof planRange.end === "number"
        ? { start: planRange.start, end: planRange.end }
        : null;

    const repairResult = repairPass4SectionVerifiedIndexes({
      section_id,
      rawVerified: s.verified_against_phase_indexes,
      linkedFallback,
      references_phase,
      planTimeRange: planTimeForRepair,
      timelinePhases,
      phaseCount,
      sectionLabel: `Pass 4 (${section_id})`
    });

    if (repairResult.warning) {
      pass4_verification_warnings.push(repairResult.warning);
      console.warn(repairResult.warning);
    }
    if (repairResult.repair) {
      verification_index_repairs.push(repairResult.repair);
    }

    out.push({
      section_id,
      start,
      end,
      story_role,
      coaching_intent,
      text,
      word_count,
      references_phase,
      verified_against_phase_indexes: repairResult.verified_against_phase_indexes,
      unverified_script_section: repairResult.unverified_script_section,
      plan_target_words: planTargetWordsById.get(section_id) ?? 0
    });
  }

  const allEmpty =
    out.length > 0 &&
    out.every(
      (row) => !(Array.isArray(row.verified_against_phase_indexes) && row.verified_against_phase_indexes.length > 0)
    );

  if (allEmpty) {
    throw new Error(
      "Pass 4 failed: every section lacks verified_against_phase_indexes after repair — cannot anchor script to visual verification"
    );
  }

  return {
    sections: out,
    schema_version: PASS_FOUR_SCHEMA_VERSION,
    verification_index_repairs,
    pass4_verification_warnings
  };
}



const PASS_FOUR_RETRY_WORD_BUDGET_SUFFIX = `

SECTION WORD BUDGET RETRY — previous draft undershot lengths.
Rewrite ALL sections hitting each narrative plan target_words − 10 … target_words + 10 (count accurately in word_count). Keep every section_id, start/end, and story_role exactly as supplied in the plan. Prefer slightly longer explanatory glue over thin copy.`;

const PASS_FOUR_CRITICAL_WORD_RETRY_SUFFIX = `

CRITICAL LENGTH PASS — normalization still rejected a section for low word_count. Expand EVERY section whose text feels lean: add 2–4 short sentences of principle-led coaching (posture/pressure/timing/space/frames/hip connection/control-before-transition) strictly allowed by merged allowed_claims and verified_visible_facts for each section's phases. Do not trim other sections to compensate. Re-count word_count accurately before emitting JSON.`;

const PASS_FOUR_STRICT_POST_GROUNDING_SUFFIX = `

STRICT MODE — grounding removed too much material: stay ONLY inside merged allowed_claims and verified_visible_facts for cited phases yet still REACH the server word minimum per section (see narrative_plan target_words — write toward the upper half of the band). Use cautious hedges ("what we can say here is …") and **principle-led coaching** (posture, frames, pressure, timing, hip connection, space, control-before-transition) that does NOT invent named positions absent from verification. Paraphrase allowed_claim verbatim detail where thin. Never invent positions or outcomes.`;

/**
 * Runs Pass 4 + normaliser (exported for grounded-coverage salvage in processVideo).
 *
 * @param {{
 *   videoDurationSeconds: number,
 *   timeline: Record<string, unknown>,
 *   coaching: Record<string, unknown>,
 *   visualClaimVerification: Record<string, unknown>,
 *   narrativePlan: Record<string, unknown>,
 *   participantInstruction: string,
 *   phaseCount: number
 * }} ctx
 * @param {string} appendedSuffix appended to PASS4_SCRIPT_INSTRUCTION tail
 * @param {string} passLabel label for billing logs
 */
export async function runPassFourVoiceoverPipeline(ctx, appendedSuffix = "", passLabel = "Voiceover script") {
  const {
    videoDurationSeconds,
    timeline,
    coaching,
    visualClaimVerification,
    narrativePlan,
    participantInstruction,
    phaseCount
  } = ctx;
  const sectionPlan = /** @type {Record<string, unknown>[]} */ (narrativePlan.section_plan);

  const attemptBundledSuffixes = [
    appendedSuffix,
    `${appendedSuffix}${PASS_FOUR_RETRY_WORD_BUDGET_SUFFIX}`,
    `${appendedSuffix}${PASS_FOUR_RETRY_WORD_BUDGET_SUFFIX}${PASS_FOUR_CRITICAL_WORD_RETRY_SUFFIX}`
  ];

  let mergedPromptTokens = 0;
  let mergedCompletionTokens = 0;
  let mergedCost = 0;
  /** @type {Error | null} */
  let lastNormError = null;

  for (let attempt = 0; attempt < attemptBundledSuffixes.length; attempt += 1) {
    const bundle = attemptBundledSuffixes[attempt];
    const passFourUser = `${PASS4_SCRIPT_INSTRUCTION}${bundle}\n\nVisual timeline:\n${JSON.stringify(timeline)}\n\nCoaching interpretation:\n${JSON.stringify(
      coaching
    )}\n\nVisual Claim Verification (obey strictly — dominates coaching on factual claims):\n${JSON.stringify(
      visualClaimVerification
    )}\n\nNarrative plan (${sectionPlan.length} sections — emit EXACTLY one JSON section per row with matching section_id in plan order):\n${JSON.stringify(
      narrativePlan
    )}${participantInstruction}`;

    const passFourMessages = [
      { role: "system", content: PASS_FOUR_SYSTEM_PROMPT },
      { role: "user", content: passFourUser }
    ];
    const label =
      attempt === 0 ? passLabel : `${passLabel} (word retry ${attempt})`;
    const passFour = await runJsonPass(passFourMessages, label);
    mergedPromptTokens += passFour.promptTokensTotal;
    mergedCompletionTokens += passFour.completionTokensTotal;
    mergedCost += passFour.costTotal;

    try {
      const scriptPayload = normalizePass4ContinuousScript(
        passFour.parsed,
        sectionPlan,
        phaseCount,
        timeline
      );
      scriptPayload.speech_density_metrics = narrativePlan.speech_density_metrics ?? null;
      return {
        passFour: {
          ...passFour,
          promptTokensTotal: mergedPromptTokens,
          completionTokensTotal: mergedCompletionTokens,
          costTotal: mergedCost
        },
        scriptPayload
      };
    } catch (err) {
      lastNormError = err instanceof Error ? err : new Error(String(err));
      const msg = lastNormError.message || "";
      const isWord =
        /only \d+ words|target_words|WORD BUDGET|empty or too short/i.test(msg);
      if (!isWord || attempt === attemptBundledSuffixes.length - 1) {
        throw lastNormError;
      }
      console.warn(`[Pass 4] ${msg} — retrying (${attempt + 2}/${attemptBundledSuffixes.length}).`);
    }
  }

  throw lastNormError ?? new Error("Pass 4 failed after normalisation retries");
}

/**
 * Regenerates Pass 4 with stricter claim boundaries after grounding over-trimmed.
 * @param {Parameters<typeof runPassFourVoiceoverPipeline>[0]} ctx
 */
export async function rerunPassFourAfterGroundingLoss(ctx) {
  return runPassFourVoiceoverPipeline(
    ctx,
    PASS_FOUR_STRICT_POST_GROUNDING_SUFFIX,
    "Voiceover script (strict reground)"
  );
}

/**
 * Scales Pass 3 target_words (for TTS repair pass after actual audio came up short).
 * @param {Record<string, unknown>|null|undefined} narrativePlan
 * @param {number} [factor]
 */
export function scaleNarrativePlanTargetWords(narrativePlan, factor = 1.2) {
  const sp = narrativePlan && typeof narrativePlan === "object" ? narrativePlan.section_plan : null;
  if (!Array.isArray(sp)) return narrativePlan;
  const f = Number(factor);
  const mult = Number.isFinite(f) && f > 1 ? f : 1.2;
  for (const row of sp) {
    if (!row || typeof row !== "object") continue;
    const tw = Number(/** @type {Record<string, unknown>} */ (row).target_words);
    const base = Number.isFinite(tw) && tw > 0 ? tw : 20;
    /** @type {Record<string, unknown>} */ (row).target_words = Math.max(20, Math.floor(base * mult));
  }
  return narrativePlan;
}

const PASS_FOUR_TTS_DENSITY_REPAIR_SUFFIX = `

TTS DENSITY REPAIR — the first synthesized audio mix was materially short versus the video runtime. Expand each section by roughly 20% more words than its narrative_plan target_words while staying strictly inside merged allowed_claims and verified_visible_facts for cited phases (hedge when verification confidence is medium or low). Keep every section_id in plan order exactly as given; respect target_words − 10 … target_words + 10 as the enforced word band.`;

/**
 * Regenerates Pass 4 after measured TTS/narration track was too short; scales plan target_words first.
 * @param {Parameters<typeof runPassFourVoiceoverPipeline>[0]} ctx
 * @param {{ scaleFactor?: number }} [opts]
 */
export async function rerunPassFourForTtsDensityRepair(ctx, opts = {}) {
  const sf = Number(opts.scaleFactor);
  const factor = Number.isFinite(sf) && sf > 1 ? sf : 1.2;
  if (ctx?.narrativePlan && typeof ctx.narrativePlan === "object") {
    scaleNarrativePlanTargetWords(/** @type {Record<string, unknown>} */ (ctx.narrativePlan), factor);
  }
  return runPassFourVoiceoverPipeline(
    ctx,
    PASS_FOUR_TTS_DENSITY_REPAIR_SUFFIX,
    "Voiceover script (TTS density repair)"
  );
}

// ---------------------------------------------------------------------------
// Legacy: targetNarrationWindowCount kept for any external callers during transition
// ---------------------------------------------------------------------------

/**
 * @deprecated No longer used internally — Pass 3 is now the Narrative Planning Agent.
 * Kept temporarily for any callers importing this export.
 */
export function targetNarrationWindowCount(durationSec) {
  const d = Math.max(0, Number(durationSec) || 0);
  if (d < 240) {
    return Math.max(5, Math.min(7, Math.round(5 + (d / 180) * 2)));
  }
  if (d < 420) {
    return Math.max(8, Math.min(12, Math.round(7 + ((d - 240) / 180) * 5)));
  }
  if (d < 720) {
    return Math.max(12, Math.min(18, Math.round(8 + ((d - 420) / 300) * 10)));
  }
  return Math.min(24, Math.round(18 + (d - 720) / 120));
}

// ---------------------------------------------------------------------------
// Pass 2 helpers (kept intact)
// ---------------------------------------------------------------------------

/** @deprecated - old window count helper, no longer used internally */
function narrationWindowCountBand(durationSec) {
  const mid = targetNarrationWindowCount(durationSec);
  return {
    targetWindowCount: mid,
    minWindows: Math.max(3, mid - 2),
    maxWindows: mid + 3
  };
}

/** @deprecated - old window band helper, no longer used internally */
function pass3DirectedWindowBand(durationSeconds) {
  const d = Math.max(30, Number(durationSeconds) || 0);
  if (d < PASS3_SHORT_VIDEO_MAX_SEC) {
    return {
      minWindows: 6,
      maxWindows: 8,
      hint: "about 6–8 rolling windows for under-3-minute rolls; narrate most of the timeline with only ~2–5s breaths between lanes (aim 65–80% coverage)"
    };
  }
  if (d < 240) {
    return {
      minWindows: 6,
      maxWindows: 8,
      hint: "about 6–8 rolling narration windows; keep near-continuous coaching across the full roll arc"
    };
  }
  if (d < 420) {
    return { minWindows: 7, maxWindows: 10, hint: "about 7–10 narration windows" };
  }
  if (d < 720) {
    return { minWindows: 10, maxWindows: 14, hint: "about 10–14 narration windows" };
  }
  const mid = Math.min(26, Math.max(14, Math.round(d / 50)));
  return {
    minWindows: Math.max(12, mid - 2),
    maxWindows: Math.min(28, mid + 2),
    hint: `${mid}± narration windows scaled to long footage`
  };
}

// uniqSortedIntArray removed — was only used by old Pass 3 window machinery

/** @deprecated Old Pass 3 window helper — no longer used */
function slicePass3TimeSpan(start, end) {
  const MIN = PASS3_WINDOW_MIN_DURATION_SEC;
  const MAX = PASS3_WINDOW_MAX_DURATION_SEC;
  const EPS = 1e-6;
  const total = end - start;
  if (total <= MAX + EPS) {
    return [[start, end]];
  }
  /** @type {Array<[number, number]>} */
  const chunks = [];
  let s = start;
  while (end - s > MAX + EPS) {
    const remaining = end - s;
    const chunkLen = Math.min(MAX, remaining - MIN);
    if (chunkLen < MIN - EPS) {
      throw new Error(
        `Pass 3 failed: cannot auto-split oversized window [${start.toFixed(2)}, ${end.toFixed(2)}] (${total.toFixed(2)}s)`
      );
    }
    chunks.push([s, s + chunkLen]);
    s += chunkLen;
  }
  const tail = end - s;
  if (tail < MIN - EPS) {
    throw new Error(`Pass 3 failed: auto-split produced tail ${tail.toFixed(2)}s < ${MIN}s`);
  }
  chunks.push([s, end]);
  return chunks;
}

/** @deprecated Old Pass 3 row cloner — no longer used */
function clonePass3RowSlice(template, start, end, partTag) {
  const purpose = String(template.purpose || "").trim();
  const theme = String(template.linked_theme || "").trim();
  const va = String(template.visual_anchor || "").trim();
  const tag = partTag ? ` — ${partTag}` : "";
  return {
    ...template,
    start,
    end,
    purpose: purpose ? `${purpose}${tag}` : partTag.trim(),
    linked_theme: theme ? `${theme}${tag}` : partTag.trim(),
    visual_anchor: va ? `${va}${tag}` : partTag.trim()
  };
}

/**
 * Merges smallest valid adjacent pair until row count ≤ band.maxWindows (used after splits and bridge inserts).
 */
function compressPass3ToMaxWindows(rows, band) {
  while (rows.length > band.maxWindows) {
    let bestI = -1;
    let bestScore = Infinity;
    for (let j = 0; j + 1 < rows.length; j += 1) {
      const a = rows[j];
      const b = rows[j + 1];
      const da = a.end - a.start;
      const db = b.end - b.start;
      const mergedDur = b.end - a.start;
      if (mergedDur > PASS3_WINDOW_MAX_DURATION_SEC + 1e-6 || mergedDur < PASS3_WINDOW_MIN_DURATION_SEC - 1e-6) {
        continue;
      }
      const score = da + db;
      if (score < bestScore) {
        bestScore = score;
        bestI = j;
      }
    }
    if (bestI < 0) {
      throw new Error(
        `Pass 3 failed: ${rows.length} narration windows exceed max ${band.maxWindows} — no valid adjacent merge keeps ${PASS3_WINDOW_MIN_DURATION_SEC}–${PASS3_WINDOW_MAX_DURATION_SEC}s`
      );
    }
    tryMergePass3Adjacent(rows, bestI, band);
  }
}

/**
 * Splits any window longer than MAX; if row count exceeds band.maxWindows, merges valid adjacent pairs.
 */
function splitPass3OversizedWindows(rows, band) {
  const MAX = PASS3_WINDOW_MAX_DURATION_SEC;

  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const dur = row.end - row.start;
    if (dur <= MAX + 1e-6) {
      continue;
    }
    const chunks = slicePass3TimeSpan(row.start, row.end);
    if (chunks.length <= 1) {
      continue;
    }
    const replacements = chunks.map(([cs, ce], j) =>
      clonePass3RowSlice(
        row,
        cs,
        ce,
        chunks.length > 1 ? `split ${j + 1}/${chunks.length}` : ""
      )
    );
    rows.splice(i, 1, ...replacements);
    console.warn(
      `[Pass 3] split long narration window (was ${dur.toFixed(2)}s > ${MAX}s) into ${chunks.length} subs`
    );
  }

  compressPass3ToMaxWindows(rows, band);
}

/**
 * Extend into silence gaps and shuffle boundaries from neighbours ≥ MIN so every window clears MIN seconds.
 * Merges only if still short and merging keeps count ≥ band.minWindows and merged span ≤ MAX.
 */
function repairPass3WindowDurations(rows, videoDurationSeconds, band) {
  const MIN = PASS3_WINDOW_MIN_DURATION_SEC;
  const MAX = PASS3_WINDOW_MAX_DURATION_SEC;
  const GAP_EPS = 0.05;

  /** @param {number} idx */
  const durationAt = (idx) => rows[idx].end - rows[idx].start;

  for (let sweep = 0; sweep < rows.length * 6 + 8; sweep += 1) {
    let progressed = false;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      let d = durationAt(i);
      if (d >= MIN - 1e-6) {
        continue;
      }
      let need = MIN - d;

      const nextStart =
        i + 1 < rows.length ? rows[i + 1].start : Number(videoDurationSeconds);
      const gapForward = Math.max(0, nextStart - row.end - GAP_EPS);
      const takeF = Math.min(need, gapForward, MAX - d);
      if (takeF > 1e-6) {
        row.end += takeF;
        need -= takeF;
        d = durationAt(i);
        progressed = true;
      }
      if (d >= MIN - 1e-6) {
        continue;
      }

      const prevEnd = i > 0 ? rows[i - 1].end : 0;
      const gapBack = Math.max(0, row.start - prevEnd - GAP_EPS);
      const takeB = Math.min(need, gapBack, MAX - d);
      if (takeB > 1e-6) {
        row.start -= takeB;
        need -= takeB;
        d = durationAt(i);
        progressed = true;
      }
      if (d >= MIN - 1e-6) {
        continue;
      }

      if (i + 1 < rows.length) {
        const next = rows[i + 1];
        const nd = next.end - next.start;
        const give = Math.min(need, Math.max(0, nd - MIN), MAX - d);
        if (give > 1e-6) {
          row.end += give;
          next.start += give;
          progressed = true;
          need -= give;
          d = durationAt(i);
        }
      }
      if (d >= MIN - 1e-6) {
        continue;
      }

      if (i > 0) {
        const prev = rows[i - 1];
        const pd = prev.end - prev.start;
        const give = Math.min(need, Math.max(0, pd - MIN), MAX - d);
        if (give > 1e-6) {
          row.start -= give;
          prev.end -= give;
          progressed = true;
        }
      }
    }
    if (!progressed) {
      break;
    }
  }

  for (let i = 0; i < rows.length; i += 1) {
    if (durationAt(i) >= MIN - 1e-6 || rows.length <= band.minWindows) {
      continue;
    }
    let mergedOk = false;
    if (i + 1 < rows.length) {
      const mergedDur = rows[i + 1].end - rows[i].start;
      if (mergedDur <= MAX + 1e-6 && tryMergePass3Adjacent(rows, i, band)) {
        i -= 1;
        mergedOk = true;
      }
    }
    if (!mergedOk && i > 0) {
      const mergedDur = rows[i].end - rows[i - 1].start;
      if (mergedDur <= MAX + 1e-6 && tryMergePass3Adjacent(rows, i - 1, band)) {
        i -= 2;
      }
    }
  }
}

/**
 * Merges rows[leftIdx] and rows[leftIdx+1]. Returns false if merge would violate min window count before merge.
 *
 * @param {Array<{ start: number, end: number, linked_phase_indexes?: unknown, linked_learning_moment_indexes?: unknown, linked_theme?: unknown, purpose?: unknown, visual_anchor?: unknown, narrative_role?: unknown }>} rows
 * @param {{ minWindows: number }} band
 */
function tryMergePass3Adjacent(rows, leftIdx, band) {
  if (leftIdx + 1 >= rows.length || rows.length <= band.minWindows) {
    return false;
  }
  const A = rows[leftIdx];
  const B = rows[leftIdx + 1];
  const start = Number(A.start);
  const end = Number(B.end);

  /** @type {Record<string, unknown>} */
  const merged = {
    ...A,
    start,
    end,
    linked_phase_indexes: uniqSortedIntArray([
      ...(Array.isArray(A.linked_phase_indexes) ? A.linked_phase_indexes : []),
      ...(Array.isArray(B.linked_phase_indexes) ? B.linked_phase_indexes : [])
    ]),
    linked_learning_moment_indexes: uniqSortedIntArray([
      ...(Array.isArray(A.linked_learning_moment_indexes) ? A.linked_learning_moment_indexes : []),
      ...(Array.isArray(B.linked_learning_moment_indexes) ? B.linked_learning_moment_indexes : [])
    ]),
    linked_theme: `${String(A.linked_theme || "").trim()} · ${String(B.linked_theme || "").trim()}`.trim(),
    purpose: `${String(A.purpose || "").trim()} | ${String(B.purpose || "").trim()}`.trim(),
    visual_anchor: `${String(A.visual_anchor || "").trim()} | ${String(B.visual_anchor || "").trim()}`.trim(),
    narrative_role:
      String(A.narrative_role || "").trim() ||
      String(B.narrative_role || "").trim() ||
      "main_coaching_point"
  };
  rows[leftIdx] = merged;
  rows.splice(leftIdx + 1, 1);
  console.warn(
    `[Pass 3] merged narration_windows[${leftIdx}+${leftIdx + 1}] to satisfy ${PASS3_WINDOW_MIN_DURATION_SEC}s minimum (model output was too fragmented)`
  );
  return true;
}

function sortPass3RowsByStart(rows) {
  rows.sort((a, b) => a.start - b.start);
}

/** @returns {Set<number>} */
function pass3AvoidPhaseIndexSet(coaching) {
  const s = new Set();
  const raw =
    coaching && typeof coaching === "object"
      ? /** @type {Record<string, unknown>} */ (coaching).avoid_commenting_on
      : null;
  if (!Array.isArray(raw)) {
    return s;
  }
  for (const e of raw) {
    if (!e || typeof e !== "object") {
      continue;
    }
    const pi = Number(/** @type {Record<string, unknown>} */ (e).phase_index);
    if (Number.isInteger(pi) && pi >= 0) {
      s.add(pi);
    }
  }
  return s;
}

function pass3GapAllowsLongSilence(gapStart, gapEnd, phases, avoidIdx) {
  const mid = (gapStart + gapEnd) / 2;
  const ph = phases;
  for (let i = 0; i < ph.length; i += 1) {
    const p = ph[i];
    if (!p || typeof p !== "object") {
      continue;
    }
    const rec = /** @type {Record<string, unknown>} */ (p);
    const ps = Number(rec.start);
    const pe = Number(rec.end);
    if (!Number.isFinite(ps) || !Number.isFinite(pe)) {
      continue;
    }
    if (mid + 1e-4 >= ps && mid - 1e-4 <= pe) {
      if (avoidIdx.has(i)) {
        return true;
      }
      if (String(rec.visual_certainty || "").toLowerCase() === "low") {
        return true;
      }
      return false;
    }
  }
  return false;
}

/**
 * @returns {{
 *   total_narration_seconds: number,
 *   narration_coverage_pct: number,
 *   max_silent_gap: number,
 *   average_silent_gap: number
 * }}
 */
function computePass3TimelineMetrics(rows, videoDurationSeconds) {
  const vd = Math.max(0, Number(videoDurationSeconds) || 0);
  let total = 0;
  for (const r of rows) {
    total += Math.max(0, r.end - r.start);
  }
  const coveragePct = vd > 1e-9 ? Math.round((total / vd) * 1000) / 10 : 0;

  /** @type {number[]} */
  const gaps = [];
  if (!rows.length) {
    gaps.push(vd);
  } else {
    gaps.push(Math.max(0, rows[0].start));
    for (let i = 1; i < rows.length; i += 1) {
      gaps.push(Math.max(0, rows[i].start - rows[i - 1].end));
    }
    gaps.push(Math.max(0, vd - rows[rows.length - 1].end));
  }
  const maxGap = gaps.length ? Math.round(Math.max(...gaps) * 1000) / 1000 : 0;
  const avgGap =
    gaps.length ? Math.round((gaps.reduce((a, g) => a + g, 0) / gaps.length) * 1000) / 1000 : 0;

  return {
    total_narration_seconds: Math.round(total * 1000) / 1000,
    narration_coverage_pct: coveragePct,
    max_silent_gap: maxGap,
    average_silent_gap: avgGap
  };
}

/** @typedef {{ gapStart: number, gapEnd: number, len: number, kind: 'leading' | 'middle' | 'trailing', leftIdx?: number, rightIdx?: number }} Pass3SilenceGap */

/** @returns {Pass3SilenceGap[]} */
function enumeratePass3SilenceGaps(rows, vd) {
  sortPass3RowsByStart(rows);
  /** @type {Pass3SilenceGap[]} */
  const out = [];
  if (!rows.length) {
    out.push({ gapStart: 0, gapEnd: vd, len: vd, kind: "leading", rightIdx: 0 });
    return out;
  }
  const lead = Math.max(0, rows[0].start);
  out.push({ gapStart: 0, gapEnd: rows[0].start, len: lead, kind: "leading", rightIdx: 0 });
  for (let i = 0; i < rows.length - 1; i += 1) {
    const gapStart = rows[i].end;
    const gapEnd = rows[i + 1].start;
    const len = Math.max(0, gapEnd - gapStart);
    out.push({ gapStart, gapEnd, len, kind: "middle", leftIdx: i, rightIdx: i + 1 });
  }
  const tail = Math.max(0, vd - rows[rows.length - 1].end);
  out.push({
    gapStart: rows[rows.length - 1].end,
    gapEnd: vd,
    len: tail,
    kind: "trailing",
    leftIdx: rows.length - 1
  });
  return out;
}

function tryShrinkPass3SilenceGap(rows, gap, goalSilentCeiling, phases, avoidIdx, MIN, MAX, vd) {
  if (pass3GapAllowsLongSilence(gap.gapStart, gap.gapEnd, phases, avoidIdx)) {
    return false;
  }
  const goalGap = Math.max(PASS3_SILENCE_GAP_MIN_SEC, Math.min(goalSilentCeiling, gap.len));
  const need = gap.len - goalGap;
  if (need < 1e-3) {
    return false;
  }
  sortPass3RowsByStart(rows);

  if (gap.kind === "leading" && gap.rightIdx !== undefined) {
    const r = rows[gap.rightIdx];
    const dur = r.end - r.start;
    const room = MAX - dur;
    const take = Math.min(need, room, r.start);
    if (take < 1e-3) {
      return false;
    }
    r.start -= take;
    return true;
  }
  if (gap.kind === "trailing" && gap.leftIdx !== undefined) {
    const r = rows[gap.leftIdx];
    const dur = r.end - r.start;
    const room = MAX - dur;
    const slack = vd - r.end;
    const take = Math.min(need, room, slack);
    if (take < 1e-3) {
      return false;
    }
    r.end += take;
    return true;
  }
  if (gap.kind === "middle" && gap.leftIdx !== undefined && gap.rightIdx !== undefined) {
    const L = rows[gap.leftIdx];
    const R = rows[gap.rightIdx];
    const L0 = L.end;
    const R0 = R.start;
    const roomL = MAX - (L.end - L.start);
    const roomR = MAX - (R.end - R.start);
    let takeL = Math.min(need / 2, roomL);
    let takeR = Math.min(need - takeL, roomR);
    let sum = takeL + takeR;
    if (sum < need - 1e-3) {
      const rem = need - sum;
      const extraL = Math.min(rem, roomL - takeL);
      takeL += extraL;
      takeR += Math.min(rem - extraL, roomR - takeR);
    }
    if (takeL + takeR < 1e-3) {
      return false;
    }
    L.end += takeL;
    R.start -= takeR;
    let newGapVal = R.start - L.end;
    if (newGapVal < PASS3_SILENCE_GAP_MIN_SEC - 1e-6) {
      const fix = PASS3_SILENCE_GAP_MIN_SEC - newGapVal;
      L.end -= fix / 2;
      R.start += fix / 2;
      newGapVal = R.start - L.end;
    }
    const dL = L.end - L.start;
    const dR = R.end - R.start;
    if (
      dL < MIN - 1e-3 ||
      dR < MIN - 1e-3 ||
      dL > MAX + 1e-3 ||
      dR > MAX + 1e-3 ||
      newGapVal < PASS3_SILENCE_GAP_MIN_SEC - 1e-3
    ) {
      L.end = L0;
      R.start = R0;
      return false;
    }
    return true;
  }
  return false;
}

function repairPass3RollingTimeline(rows, videoDurationSeconds, phases, avoidIdx) {
  const MIN = PASS3_WINDOW_MIN_DURATION_SEC;
  const MAX = PASS3_WINDOW_MAX_DURATION_SEC;
  const vd = Number(videoDurationSeconds);

  for (let iter = 0; iter < 28; iter += 1) {
    sortPass3RowsByStart(rows);
    const metrics = computePass3TimelineMetrics(rows, vd);
    const gaps = enumeratePass3SilenceGaps(rows, vd);

    const badMax = gaps.filter(
      (g) =>
        g.len > PASS3_SILENCE_GAP_MAX_HARD_SEC + 1e-3 &&
        !pass3GapAllowsLongSilence(g.gapStart, g.gapEnd, phases, avoidIdx)
    );
    const lowCov = metrics.narration_coverage_pct < PASS3_COVERAGE_REPAIR_BELOW_PCT;
    const stretch = gaps.filter(
      (g) =>
        g.len > PASS3_SILENCE_GAP_TARGET_SEC + 1e-3 &&
        !pass3GapAllowsLongSilence(g.gapStart, g.gapEnd, phases, avoidIdx)
    );

    let progressed = false;
    if (badMax.length > 0) {
      badMax.sort((a, b) => b.len - a.len);
      for (const g of badMax) {
        if (tryShrinkPass3SilenceGap(rows, g, PASS3_SILENCE_GAP_MAX_HARD_SEC, phases, avoidIdx, MIN, MAX, vd)) {
          progressed = true;
          break;
        }
      }
    }
    if (!progressed && lowCov && stretch.length > 0) {
      stretch.sort((a, b) => b.len - a.len);
      for (const g of stretch) {
        if (tryShrinkPass3SilenceGap(rows, g, PASS3_SILENCE_GAP_TARGET_SEC, phases, avoidIdx, MIN, MAX, vd)) {
          progressed = true;
          break;
        }
      }
    }
    if (!progressed) {
      break;
    }
  }
}

function pass3PhaseIndexesOverlapping(phases, start, end) {
  /** @type {number[]} */
  const idxs = [];
  for (let i = 0; i < phases.length; i += 1) {
    const p = phases[i];
    if (!p || typeof p !== "object") {
      continue;
    }
    const r = /** @type {Record<string, unknown>} */ (p);
    const ps = Number(r.start);
    const pe = Number(r.end);
    if (!Number.isFinite(ps) || !Number.isFinite(pe)) {
      continue;
    }
    if (pe >= start && ps <= end) {
      idxs.push(i);
    }
  }
  return uniqSortedIntArray(idxs);
}

function tryInsertPass3BridgeWindow(rows, vd, phases, avoidIdx, band) {
  sortPass3RowsByStart(rows);
  const gaps = enumeratePass3SilenceGaps(rows, vd);
  const candidates = gaps
    .filter(
      (g) =>
        !pass3GapAllowsLongSilence(g.gapStart, g.gapEnd, phases, avoidIdx) &&
        g.len >= PASS3_WINDOW_MIN_DURATION_SEC + 2 * PASS3_SILENCE_GAP_MIN_SEC
    )
    .sort((a, b) => b.len - a.len);
  const gap = candidates[0];
  if (!gap) {
    return false;
  }
  const innerStart = gap.gapStart + PASS3_SILENCE_GAP_MIN_SEC;
  const innerEnd = gap.gapEnd - PASS3_SILENCE_GAP_MIN_SEC;
  const innerLen = innerEnd - innerStart;
  if (innerLen < PASS3_WINDOW_MIN_DURATION_SEC - 1e-3) {
    return false;
  }
  const dur = Math.min(PASS3_WINDOW_MAX_DURATION_SEC, innerLen);
  let start = innerStart;
  let end = innerStart + dur;
  if (innerLen > dur + 1e-3) {
    start = innerStart + (innerLen - dur) / 2;
    end = start + dur;
  }
  let lpi = pass3PhaseIndexesOverlapping(phases, start, end);
  if (lpi.length === 0 && phases.length > 0) {
    lpi = [0];
  }
  let left = null;
  let right = null;
  if (gap.kind === "middle" && gap.leftIdx !== undefined && gap.rightIdx !== undefined) {
    left = rows[gap.leftIdx];
    right = rows[gap.rightIdx];
  } else if (gap.kind === "leading" && gap.rightIdx !== undefined) {
    right = rows[gap.rightIdx];
  } else if (gap.kind === "trailing" && gap.leftIdx !== undefined) {
    left = rows[gap.leftIdx];
  }
  const template = left || right || rows[0];
  const theme = String(template?.linked_theme || "Roll progression").trim() || "Roll progression";
  const va =
    String(template?.visual_anchor || "").trim() ||
    "Auto bridge: describe only what is visible in this segment (no invented techniques).";

  /** @type {Record<string, unknown>} */
  const bridge = {
    start,
    end,
    purpose:
      "Rolling review bridge: narrate visible actions across this stretch using Pass 1 evidence only.",
    linked_phase_indexes: lpi.length ? lpi : [0],
    linked_theme: theme,
    linked_learning_moment_indexes: [],
    visual_anchor: va,
    narrative_role: "rolling_analysis"
  };

  let insertAt = rows.length;
  if (gap.kind === "leading") {
    insertAt = 0;
  } else if (gap.kind === "trailing") {
    insertAt = rows.length;
  } else if (gap.rightIdx !== undefined) {
    insertAt = gap.rightIdx;
  }
  rows.splice(insertAt, 0, bridge);
  sortPass3RowsByStart(rows);
  console.warn(
    `[Pass 3] inserted rolling bridge window [${start.toFixed(2)}, ${end.toFixed(2)}]s to improve coverage/gaps`
  );
  splitPass3OversizedWindows(rows, band);
  repairPass3WindowDurations(rows, vd, band);
  splitPass3OversizedWindows(rows, band);
  compressPass3ToMaxWindows(rows, band);
  return true;
}

function assertPass3RollingTimelineOk(rows, vd, phases, avoidIdx) {
  const m = computePass3TimelineMetrics(rows, vd);
  if (m.narration_coverage_pct < PASS3_COVERAGE_REPAIR_BELOW_PCT - 1e-9) {
    throw new Error(
      `Pass 3 failed: narration_coverage_pct ${m.narration_coverage_pct}% remains below ${PASS3_COVERAGE_REPAIR_BELOW_PCT}% — widen windows or densify lanes`
    );
  }
  const gaps = enumeratePass3SilenceGaps(rows, vd);
  for (const g of gaps) {
    if (
      g.len > PASS3_SILENCE_GAP_MAX_HARD_SEC + 1e-3 &&
      !pass3GapAllowsLongSilence(g.gapStart, g.gapEnd, phases, avoidIdx)
    ) {
      throw new Error(
        `Pass 3 failed: silent gap ${g.len.toFixed(2)}s exceeds ${PASS3_SILENCE_GAP_MAX_HARD_SEC}s without avoid_commenting_on/low-certainty justification`
      );
    }
  }
}

/**
 * Validates Phase 3 plan; recomputes target_words deterministically; enforces rolling coverage + gap policy.
 * @returns {{ narration_windows: Record<string, unknown>[], timeline_metrics: Record<string, number> }}
 */
function normalizePass3DirectedPlan(
  rawPlan,
  videoDurationSeconds,
  phaseCount,
  learningMomentCount,
  band,
  timeline,
  coaching
) {
  if (!rawPlan || typeof rawPlan !== "object") {
    throw new Error("Pass 3 failed: plan is not an object");
  }
  const rp = /** @type {Record<string, unknown>} */ (rawPlan);
  const windows = rp.narration_windows;
  if (!Array.isArray(windows) || windows.length === 0) {
    throw new Error("Pass 3 failed: expected narration_windows array");
  }
  if (windows.length < band.minWindows || windows.length > band.maxWindows) {
    throw new Error(
      `Pass 3 failed: narration_windows count ${windows.length} outside ${band.minWindows}-${band.maxWindows}`
    );
  }

  const maxPhase = Math.max(0, phaseCount - 1);
  const maxLm = Math.max(-1, learningMomentCount - 1);
  /** @type {Record<string, unknown>[]} */
  const sorted = [...windows].sort((a, b) => Number(a?.start) - Number(b?.start));

  /** @type {{ start: number, end: number, [key: string]: unknown }[]} */
  const working = sorted.map((row) => {
    if (!row || typeof row !== "object") {
      return { start: NaN, end: NaN };
    }
    const r = /** @type {Record<string, unknown>} */ (row);
    return {
      ...r,
      start: Number(r.start),
      end: Number(r.end)
    };
  });

  const phases = Array.isArray(timeline?.phases) ? /** @type {unknown[]} */ (timeline.phases) : [];
  const avoidIdx = pass3AvoidPhaseIndexSet(coaching);

  splitPass3OversizedWindows(working, band);
  repairPass3WindowDurations(working, videoDurationSeconds, band);
  splitPass3OversizedWindows(working, band);
  repairPass3RollingTimeline(working, videoDurationSeconds, phases, avoidIdx);
  splitPass3OversizedWindows(working, band);
  repairPass3WindowDurations(working, videoDurationSeconds, band);
  splitPass3OversizedWindows(working, band);

  for (let bridgeTries = 0; bridgeTries < 4; bridgeTries += 1) {
    sortPass3RowsByStart(working);
    const mProbe = computePass3TimelineMetrics(working, videoDurationSeconds);
    const gapsProbe = enumeratePass3SilenceGaps(working, videoDurationSeconds);
    const badGap = gapsProbe.some(
      (g) =>
        g.len > PASS3_SILENCE_GAP_MAX_HARD_SEC + 1e-3 &&
        !pass3GapAllowsLongSilence(g.gapStart, g.gapEnd, phases, avoidIdx)
    );
    if (mProbe.narration_coverage_pct >= PASS3_COVERAGE_REPAIR_BELOW_PCT && !badGap) {
      break;
    }
    if (!tryInsertPass3BridgeWindow(working, videoDurationSeconds, phases, avoidIdx, band)) {
      break;
    }
    repairPass3RollingTimeline(working, videoDurationSeconds, phases, avoidIdx);
  }

  compressPass3ToMaxWindows(working, band);
  repairPass3WindowDurations(working, videoDurationSeconds, band);
  splitPass3OversizedWindows(working, band);
  repairPass3RollingTimeline(working, videoDurationSeconds, phases, avoidIdx);
  sortPass3RowsByStart(working);

  if (working.length < band.minWindows || working.length > band.maxWindows) {
    throw new Error(
      `Pass 3 failed: narration_windows count ${working.length} outside ${band.minWindows}-${band.maxWindows} after rolling-timeline repair`
    );
  }

  assertPass3RollingTimelineOk(working, videoDurationSeconds, phases, avoidIdx);

  /** @type {Record<string, unknown>[]} */
  const out = [];

  for (let i = 0; i < working.length; i += 1) {
    const row = working[i];
    if (!row || typeof row !== "object") {
      throw new Error(`Pass 3 failed: narration_windows[${i}] must be an object`);
    }
    const w = /** @type {Record<string, unknown>} */ (row);
    const start = Number(w.start);
    const end = Number(w.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(`Pass 3 failed: narration_windows[${i}] invalid start/end`);
    }
    if (start < -0.01 || end > videoDurationSeconds + 0.05) {
      throw new Error(`Pass 3 failed: window [${start}, ${end}] outside video duration`);
    }
    const dur = end - start;
    if (dur < PASS3_WINDOW_MIN_DURATION_SEC - 1e-6) {
      throw new Error(
        `Pass 3 failed: narration_windows[${i}] duration ${dur.toFixed(
          2
        )}s < ${PASS3_WINDOW_MIN_DURATION_SEC}s — merge/adjacent-extend windows`
      );
    }
    if (dur > PASS3_WINDOW_MAX_DURATION_SEC + 1e-6) {
      throw new Error(
        `Pass 3 failed: narration_windows[${i}] duration ${dur.toFixed(
          2
        )}s > ${PASS3_WINDOW_MAX_DURATION_SEC}s — split or shorten coherent spans`
      );
    }
    if (i > 0) {
      const prevEnd = Number(out[i - 1].end);
      if (start + 1e-4 < prevEnd) {
        throw new Error(
          `Pass 3 failed: overlapping narration_windows (start ${start}s before previous end ${prevEnd}s)`
        );
      }
    }
    const lpi = w.linked_phase_indexes;
    if (!Array.isArray(lpi) || lpi.length === 0) {
      throw new Error(`Pass 3 failed: narration_windows[${i}] needs linked_phase_indexes[]`);
    }
    for (const pi of lpi) {
      const n = Number(pi);
      if (!Number.isInteger(n) || n < 0 || n > maxPhase) {
        throw new Error(`Pass 3 failed: invalid linked_phase_indexes entry ${pi} (phase count=${phaseCount})`);
      }
    }
    const llm = w.linked_learning_moment_indexes;
    if (!Array.isArray(llm)) {
      throw new Error(`Pass 3 failed: narration_windows[${i}].linked_learning_moment_indexes must be an array`);
    }
    if (learningMomentCount === 0 && llm.length > 0) {
      throw new Error("Pass 3 failed: learning moment indexes present but Phase 2 had zero moments");
    }
    for (const mi of llm) {
      const n = Number(mi);
      if (!Number.isInteger(n) || n < 0 || n > maxLm) {
        throw new Error(`Pass 3 failed: invalid linked_learning_moment_indexes entry ${mi}`);
      }
    }
    if (typeof w.linked_theme !== "string" || !w.linked_theme.trim()) {
      throw new Error(`Pass 3 failed: narration_windows[${i}].linked_theme required`);
    }
    if (typeof w.visual_anchor !== "string" || !w.visual_anchor.trim()) {
      throw new Error(`Pass 3 failed: narration_windows[${i}].visual_anchor required`);
    }
    if (typeof w.purpose !== "string" || !w.purpose.trim()) {
      throw new Error(`Pass 3 failed: narration_windows[${i}].purpose required`);
    }
    let role = typeof w.narrative_role === "string" ? w.narrative_role.trim() : "";
    if (role === "watch_this_moment") {
      role = "rolling_analysis";
    }
    if (!PASS3_NARRATIVE_ROLES.has(role)) {
      throw new Error(`Pass 3 failed: narration_windows[${i}].narrative_role invalid "${role}"`);
    }

    const targetWordsExact = Math.floor(
      Math.max(0, dur - PASS3_DIRECTOR_WORD_BUFFER_SEC) * PASS3_DIRECTOR_WORDS_PER_SECOND
    );

    out.push({
      start,
      end,
      target_words: targetWordsExact,
      purpose: w.purpose,
      linked_phase_indexes: lpi.map((x) => Number(x)),
      linked_theme: w.linked_theme.trim(),
      linked_learning_moment_indexes: llm.map((x) => Number(x)),
      visual_anchor: w.visual_anchor.trim(),
      narrative_role: role
    });
  }

  const timeline_metrics = computePass3TimelineMetrics(
    out.map((row) => ({ start: Number(row.start), end: Number(row.end) })),
    videoDurationSeconds
  );

  return { narration_windows: out, timeline_metrics };
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

function countWordsInText(text) {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) {
    return 0;
  }
  return t.split(/\s+/).filter(Boolean).length;
}

function pass2CoachingScaleHint(durationSeconds) {
  const d = Math.max(1, Math.round(Number(durationSeconds) || 0));
  if (d < 240) {
    return `For a roll of about ${d}s (e.g. ~170s), aim for ABOUT 3 main_coaching_themes (not syllabus titles — story-led), 4–6 best_learning_moments, and 1–3 avoid_commenting_on entries unless Pass 1 has nothing low-value (still avoid padding). Prefer fewer sharper beats over taxonomy labels.`;
  }
  if (d < 420) {
    return `For a roll of about ${d}s, aim for roughly 5–8 main_coaching_themes and 6–10 best_learning_moments.`;
  }
  if (d < 720) {
    return `For a roll of about ${d}s, aim for roughly 7–11 main_coaching_themes and 9–14 best_learning_moments.`;
  }
  return `For longer footage (~${d}s), scale themes and learning moments up proportionally; still avoid generic advice — every point needs Pass 1 evidence.`;
}

/** Pass 2 `confidence`: required downstream; coerce missing/non-enum strings to `"low"` instead of failing the job. */
function normalizePass2ConfidenceField(raw) {
  const v = typeof raw === "string" ? raw.toLowerCase().trim() : "";
  if (v === "high" || v === "medium" || v === "low") {
    return v;
  }
  return "low";
}

/**
 * @param {unknown} coaching
 * @param {number} phaseCount
 * @returns {Record<string, unknown>}
 */
function normalizePass2Interpretation(coaching, phaseCount) {
  if (!coaching || typeof coaching !== "object") {
    throw new Error("Pass 2 failed: coaching interpretation is not an object");
  }
  const c = /** @type {Record<string, unknown>} */ (coaching);
  if (typeof c.coaching_summary !== "string" || !c.coaching_summary.trim()) {
    throw new Error("Pass 2 failed: expected non-empty coaching_summary string");
  }
  if (!Array.isArray(c.main_coaching_themes) || c.main_coaching_themes.length === 0) {
    throw new Error("Pass 2 failed: expected non-empty main_coaching_themes array");
  }
  if (!Array.isArray(c.best_learning_moments) || c.best_learning_moments.length === 0) {
    throw new Error("Pass 2 failed: expected non-empty best_learning_moments array");
  }
  if (!Array.isArray(c.avoid_commenting_on)) {
    c.avoid_commenting_on = [];
  }
  const maxIdx = Math.max(0, phaseCount - 1);
  for (let i = 0; i < c.main_coaching_themes.length; i += 1) {
    const t = c.main_coaching_themes[i];
    if (!t || typeof t !== "object") {
      throw new Error(`Pass 2 failed: main_coaching_themes[${i}] must be an object`);
    }
    const th = /** @type {Record<string, unknown>} */ (t);
    if (typeof th.theme !== "string" || !th.theme.trim()) {
      throw new Error(`Pass 2 failed: main_coaching_themes[${i}].theme required`);
    }
    const idxs = th.evidence_phase_indexes;
    if (!Array.isArray(idxs) || idxs.length === 0) {
      throw new Error(`Pass 2 failed: theme "${th.theme.slice(0, 40)}..." needs at least one evidence_phase_indexes entry`);
    }
    for (const pi of idxs) {
      const n = Number(pi);
      if (!Number.isInteger(n) || n < 0 || n > maxIdx) {
        throw new Error(
          `Pass 2 failed: invalid evidence_phase_index ${pi} for theme (phase count=${phaseCount})`
        );
      }
    }
    if (!Array.isArray(th.visual_evidence)) {
      throw new Error(`Pass 2 failed: main_coaching_themes[${i}].visual_evidence must be an array`);
    }
    for (const ev of th.visual_evidence) {
      if (typeof ev !== "string" || !String(ev).trim()) {
        throw new Error(`Pass 2 failed: visual_evidence entries must be non-empty strings`);
      }
    }
    if (typeof th.why_it_matters !== "string" || !th.why_it_matters.trim()) {
      throw new Error(`Pass 2 failed: main_coaching_themes[${i}].why_it_matters required`);
    }
    if (typeof th.coaching_angle !== "string" || !th.coaching_angle.trim()) {
      throw new Error(`Pass 2 failed: main_coaching_themes[${i}].coaching_angle required`);
    }
    for (const nk of [
      "coaching_lesson",
      "improvement_area",
      "what_user_could_have_done",
      "what_opponent_did_well",
      "suggested_drill",
      "evidence_basis"
    ]) {
      if (typeof th[nk] !== "string" || !String(th[nk]).trim()) {
        throw new Error(`Pass 2 failed: main_coaching_themes[${i}].${nk} required (non-empty coaching string)`);
      }
    }
    th.confidence = normalizePass2ConfidenceField(th.confidence);
  }
  for (let j = 0; j < c.best_learning_moments.length; j += 1) {
    const m = c.best_learning_moments[j];
    if (!m || typeof m !== "object") {
      throw new Error(`Pass 2 failed: best_learning_moments[${j}] must be an object`);
    }
    const mo = /** @type {Record<string, unknown>} */ (m);
    const pIdx = Number(mo.phase_index);
    if (!Number.isInteger(pIdx) || pIdx < 0 || pIdx > maxIdx) {
      throw new Error(`Pass 2 failed: invalid phase_index ${mo.phase_index} in learning moment`);
    }
    const tr = mo.time_range;
    if (!tr || typeof tr !== "object") {
      throw new Error(`Pass 2 failed: best_learning_moments[${j}].time_range required`);
    }
    const rng = /** @type {Record<string, unknown>} */ (tr);
    const ts = Number(rng.start);
    const te = Number(rng.end);
    if (!Number.isFinite(ts) || !Number.isFinite(te)) {
      throw new Error(`Pass 2 failed: time_range.start/end must be numbers`);
    }
    for (const key of ["what_happened", "why_it_matters", "what_to_notice", "possible_correction"]) {
      if (typeof mo[key] !== "string" || !String(mo[key]).trim()) {
        throw new Error(`Pass 2 failed: best_learning_moments[${j}].${key} must be a non-empty string`);
      }
    }
    for (const nk of [
      "coaching_lesson",
      "improvement_area",
      "what_user_could_have_done",
      "what_opponent_did_well",
      "suggested_drill",
      "evidence_basis"
    ]) {
      if (typeof mo[nk] !== "string" || !String(mo[nk]).trim()) {
        throw new Error(`Pass 2 failed: best_learning_moments[${j}].${nk} required`);
      }
    }
    mo.confidence = normalizePass2ConfidenceField(mo.confidence);
  }
  for (let k = 0; k < c.avoid_commenting_on.length; k += 1) {
    const a = c.avoid_commenting_on[k];
    if (!a || typeof a !== "object") {
      throw new Error(`Pass 2 failed: avoid_commenting_on[${k}] must be an object`);
    }
    const av = /** @type {Record<string, unknown>} */ (a);
    const ap = Number(av.phase_index);
    if (!Number.isInteger(ap) || ap < 0 || ap > maxIdx) {
      throw new Error(`Pass 2 failed: avoid_commenting_on[${k}].phase_index invalid`);
    }
    if (typeof av.reason !== "string" || !av.reason.trim()) {
      throw new Error(`Pass 2 failed: avoid_commenting_on[${k}].reason required`);
    }
  }
  return c;
}

/**
 * Map Pass 1 visual_certainty to max allowed Pass 2 confidence rank (low=0, medium=1, high=2).
 * Missing or invalid field → ceiling medium only (cannot emit high unless Pass 1 says high).
 * @returns {number} 0, 1, or 2
 */
function pass1VisualCertaintyCeilingRank(phase) {
  if (!phase || typeof phase !== "object") {
    return 1;
  }
  const raw = /** @type {Record<string, unknown>} */ (phase).visual_certainty;
  const v = typeof raw === "string" ? raw.toLowerCase().trim() : "";
  if (v === "high") {
    return 2;
  }
  if (v === "low") {
    return 0;
  }
  return 1;
}

/**
 * @param {string} claimed
 * @param {number} ceilingRank max rank allowed (from Pass 1)
 */
function clampPass2ConfidenceToPass1Ceiling(claimed, ceilingRank) {
  const claimRank = claimed === "low" ? 0 : claimed === "medium" ? 1 : 2;
  const out = Math.min(claimRank, ceilingRank);
  if (out <= 0) {
    return "low";
  }
  if (out === 1) {
    return "medium";
  }
  return "high";
}

/** Weakest Pass 1 certainty among phases indexed — caps coaching confidence server-side after model output. */
function enforcePass2ConfidenceAgainstPass1(coaching, timeline) {
  const phases = timeline?.phases;
  if (!Array.isArray(phases)) {
    return;
  }

  /** @type {Record<string, unknown>} */
  const c = coaching;
  const themes = c.main_coaching_themes;
  if (!Array.isArray(themes)) {
    return;
  }
  for (const row of themes) {
    const th = /** @type {Record<string, unknown>} */ (row);
    const idxs = th.evidence_phase_indexes;
    if (!Array.isArray(idxs) || idxs.length === 0) {
      continue;
    }
    let ceilingRank = 2;
    for (const pi of idxs) {
      const i = Number(pi);
      if (!Number.isInteger(i) || i < 0 || i >= phases.length) {
        continue;
      }
      ceilingRank = Math.min(ceilingRank, pass1VisualCertaintyCeilingRank(phases[i]));
    }
    const cur = typeof th.confidence === "string" ? th.confidence : "medium";
    th.confidence = clampPass2ConfidenceToPass1Ceiling(cur, ceilingRank);
  }

  const moments = c.best_learning_moments;
  if (!Array.isArray(moments)) {
    return;
  }
  for (const row of moments) {
    const mo = /** @type {Record<string, unknown>} */ (row);
    const pi = Number(mo.phase_index);
    if (!Number.isInteger(pi) || pi < 0 || pi >= phases.length) {
      continue;
    }
    const ceilingRank = pass1VisualCertaintyCeilingRank(phases[pi]);
    const cur = typeof mo.confidence === "string" ? mo.confidence : "medium";
    mo.confidence = clampPass2ConfidenceToPass1Ceiling(cur, ceilingRank);
  }
}

/**
 * Lowest applicable ceiling for analysis_quality_score from objective coverage metrics (developer QA).
 */
export function computeAnalysisQualityScoreCeiling(coverageMetrics) {
  const caps = [];
  if (coverageMetrics.speech_coverage_pct < 22) {
    caps.push(5.5);
  }
  if (coverageMetrics.speech_coverage_pct < 28) {
    caps.push(6.0);
  }
  if (coverageMetrics.max_silent_gap > 30) {
    caps.push(5.8);
  }
  if (coverageMetrics.max_silent_gap > 22) {
    caps.push(6.2);
  }
  if (coverageMetrics.average_silent_gap > 18) {
    caps.push(6.5);
  }
  if (coverageMetrics.average_silent_gap > 14) {
    caps.push(7.0);
  }
  if (coverageMetrics.overlap_count > 0) {
    caps.push(5.0);
  }
  if (coverageMetrics.segment_count < 3 && coverageMetrics.video_duration > 45) {
    caps.push(5.5);
  }
  if (
    typeof coverageMetrics.avg_words_per_segment === "number" &&
    coverageMetrics.avg_words_per_segment < 22 &&
    coverageMetrics.segment_count >= 4
  ) {
    caps.push(6.0);
  }
  if (
    typeof coverageMetrics.unplanned_silence_penalty === "number" &&
    coverageMetrics.unplanned_silence_penalty > 40
  ) {
    caps.push(6.3);
  }
  return caps.length ? Math.min(...caps) : 10;
}

function parseJsonCompletion(rawContent, passLabel, attempt) {
  if (!rawContent) {
    console.error(`${passLabel} attempt ${attempt}: response had no message content`);
    return { ok: false, parsed: undefined };
  }
  console.log(`${passLabel} attempt ${attempt} raw response content:`, rawContent);
  const cleaned = rawContent.replace(/```json|```/g, "").trim();
  try {
    return { ok: true, parsed: JSON.parse(cleaned) };
  } catch (parseError) {
    console.error(`${passLabel} attempt ${attempt} JSON parse failed:`, parseError.message);
    console.error(`${passLabel} raw response text:`, rawContent);
    return { ok: false, parsed: undefined };
  }
}

async function runJsonPass(messages, passLabel) {
  let parsed;
  /** Raw `message.content` from the model for the attempt that parsed successfully. */
  let rawModelOutput = null;
  let costTotal = 0;
  let promptTokensTotal = 0;
  let completionTokensTotal = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    const data = await runChatCompletion(messages);
    const passCost = calculatePassCost(data.usage);
    costTotal += passCost.total;
    promptTokensTotal += passCost.promptTokens;
    completionTokensTotal += passCost.completionTokens;
    console.log(`${passLabel} attempt ${attempt + 1} tokens:`, data.usage);
    console.log(
      `${passLabel} attempt ${attempt + 1} cost: $${passCost.total.toFixed(4)} (${passCost.promptTokens.toLocaleString()} input @ $${INPUT_COST_PER_MILLION.toFixed(
        2
      )}/M + ${passCost.completionTokens.toLocaleString()} output @ $${OUTPUT_COST_PER_MILLION.toFixed(2)}/M)`
    );

    const rawContent = data?.choices?.[0]?.message?.content;
    const { ok, parsed: p } = parseJsonCompletion(
      rawContent,
      passLabel,
      attempt + 1
    );
    if (ok) {
      parsed = p;
      rawModelOutput = typeof rawContent === "string" ? rawContent : null;
      break;
    }
    if (attempt === 1) {
      throw new Error(`${passLabel} failed: GPT-4o returned non-JSON response`);
    }
  }

  if (parsed === undefined) {
    throw new Error(`${passLabel} failed: GPT-4o returned non-JSON response`);
  }

  console.log(`${passLabel} total cost: $${costTotal.toFixed(4)}`);
  return {
    parsed,
    rawModelOutput,
    promptTokensTotal,
    completionTokensTotal,
    costTotal
  };
}

/**
 * Multimodal user message for Visual Claim Verification (reuses sampled frames + JSON context).
 * @param {{ path: string, timestamp: number }[]} sampledFrames
 * @param {number} videoDurationSeconds
 * @param {Record<string, unknown>} timeline
 * @param {Record<string, unknown>} coaching
 * @param {string} participantInstruction
 */
async function buildVisualClaimVerificationUserContent(
  sampledFrames,
  videoDurationSeconds,
  timeline,
  coaching,
  participantInstruction
) {
  const phasesArr = /** @type {unknown[]} */ (timeline.phases);
  const lastIdx = Math.max(0, phasesArr.length - 1);
  const frameTsList = sampledFrames.map((f) => f.timestamp).join(", ");

  let head = `VISUAL CLAIM VERIFICATION

VIDEO DURATION: ${videoDurationSeconds} seconds.
You must output phase_verification covering every phase_index from 0 through ${lastIdx} (inclusive, in order).

SAMPLED FRAME TIMESTAMPS (seconds): ${frameTsList}

Use the JSON below AND the frame images. The coaching interpretation is a hypothesis only — correct it when visuals and timeline disagree.

VISUAL TIMELINE JSON:\n${JSON.stringify(timeline)}

COACHING INTERPRETATION JSON:\n${JSON.stringify(coaching)}${participantInstruction}

Return JSON ONLY with top-level keys schema_version, phase_verification (array), global_warnings (array).
Use schema_version "${VISUAL_CLAIM_VERIFICATION_SCHEMA_VERSION}".
Each phase_verification entry MUST include:
phase_index (0…${lastIdx} in order), time_range {start,end}, green_shirt_role, opponent_role, dominant_player (obey dominance rules above),
verified_visible_facts[] (neutral short visual observations only),
allowed_claims[] — a SHORT whitelist of wording the narrator may use (plain English, no metaphors).
Every string in allowed_claims must stay at or BELOW the certainty of verified_visible_facts (no escalation). Example: facts say "transitioning to the ground" → allowed_claims may include moving from standing toward a grounded exchange—but NOT dominance, pinning, shields, culmination, adaptive strategies.
claims_to_avoid[] — concrete phrases viewers must NOT hear for this phase (e.g. "established control", "defensive shield", dominant language when not earned).
confidence: high | medium | low`;

  const content = [{ type: "text", text: head }];
  for (const frame of sampledFrames) {
    const frameBase64 = await fs.readFile(frame.path, { encoding: "base64" });
    content.push({ type: "text", text: `Frame timestamp seconds: ${frame.timestamp}` });
    content.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${frameBase64}`, detail: "low" }
    });
  }
  return content;
}

/**
 * OpenAI frame-based Pass 1 (Visual timeline) only.
 *
 * @param {{ path: string, timestamp: number }[]} frames
 * @param {string} participantDescription
 * @param {number} videoDurationSeconds
 */
async function runOpenAiVisualTimelinePass1(frames, participantDescription, videoDurationSeconds) {
  const participantInstruction = participantDescription
    ? ` The practitioner you are analysing is identified by: ${participantDescription}. Focus all analysis on this person only. Do not coach their opponent.`
    : "";

  const MAX_FRAMES = 120;
  const sampledFrames =
    frames.length > MAX_FRAMES
      ? Array.from({ length: MAX_FRAMES }, (_, i) =>
          frames[Math.round((i * (frames.length - 1)) / (MAX_FRAMES - 1))])
      : frames;
  console.log(
    `Visual timeline frame sampling: ${frames.length} extracted → ${sampledFrames.length} sent to OpenAI`
  );

  const passOneIntro = `${PASS1_USER_TIMELINE_STATIC}

${pass1PhaseDensityGuidance(videoDurationSeconds)}

Set video_duration_seconds to exactly ${videoDurationSeconds} (use the actual roll duration supplied here; do not round away coverage).`;

  const passOneContent = [{ type: "text", text: passOneIntro }];
  if (participantInstruction) {
    passOneContent[0].text = `${passOneContent[0].text}${participantInstruction}`;
  }
  for (const frame of sampledFrames) {
    const frameBase64 = await fs.readFile(frame.path, { encoding: "base64" });
    passOneContent.push({
      type: "text",
      text: `Frame timestamp seconds: ${frame.timestamp}`
    });
    passOneContent.push({
      type: "image_url",
      image_url: {
        url: `data:image/jpeg;base64;${frameBase64}`,
        detail: "low"
      }
    });
  }

  const passOneMessages = [
    { role: "system", content: PASS_ONE_SYSTEM_PROMPT },
    { role: "user", content: passOneContent }
  ];

  return runJsonPass(passOneMessages, "Visual timeline");
}

/**
 * Visual timeline → coaching interpretation → Visual Claim Verification → narrative plan → voiceover script.
 * Timing adaptation runs in processVideo (pre-TTS).
 */
export async function analyseFrames(
  frames,
  {
    participantDescription = "",
    videoDurationSeconds,
    pipelineDebug = null,
    videoPath = null,
    visionRoute = null
  } = {}
) {
  if (typeof videoDurationSeconds !== "number" || Number.isNaN(videoDurationSeconds) || videoDurationSeconds <= 0) {
    throw new Error("analyseFrames requires videoDurationSeconds (positive number)");
  }

  const participantInstruction = participantDescription
    ? ` The practitioner you are analysing is identified by: ${participantDescription}. Focus all analysis on this person only. Do not coach their opponent.`
    : "";

  /** @type {{ promptTokensTotal: number, completionTokensTotal: number, costTotal: number, rawModelOutput: string | null }} */
  let passOne;
  /** @type {unknown} */
  let timelineRaw;
  /** @type {"openai"|"gemini"} */
  let timelineProviderUsed = "openai";
  /** @type {string | null} */
  let fallbackWarning = null;

  const tryGemini =
    visionRoute?.useGemini === true && typeof videoPath === "string" && videoPath.length > 0;

  if (tryGemini) {
    try {
      const g = await analyseVideoWithGemini({
        videoPath,
        videoDurationSeconds,
        jobId: pipelineDebug?.jobId ?? "unknown",
        pipelineDebug,
        participantDescription,
        apiKey: config.GEMINI_API_KEY,
        visionModel: config.GEMINI_VISION_MODEL
      });
      timelineRaw = g.timelineObject;
      passOne = {
        promptTokensTotal: g.usage.pass1PromptTokens,
        completionTokensTotal: g.usage.pass1CompletionTokens,
        costTotal: g.usage.pass1CostUsd,
        rawModelOutput: g.rawModelOutput
      };
      timelineProviderUsed = "gemini";
    } catch (gemErr) {
      fallbackWarning = sanitizeGeminiErrorForLogs(gemErr);
      console.warn(`Gemini visual timeline failed, falling back to OpenAI: ${fallbackWarning}`);
    }
  }

  if (timelineRaw === undefined) {
    const o = await runOpenAiVisualTimelinePass1(frames, participantDescription, videoDurationSeconds);
    timelineRaw = o.parsed;
    passOne = {
      promptTokensTotal: o.promptTokensTotal,
      completionTokensTotal: o.completionTokensTotal,
      costTotal: o.costTotal,
      rawModelOutput: o.rawModelOutput
    };
    timelineProviderUsed = "openai";
  }

  /** @type {Record<string, unknown>} */
  const timeline = normalizePass1TimelineOutput(timelineRaw);

  await writePipelineDebugArtifact(pipelineDebug, "visual-timeline.json", "Visual timeline", {
    rawModelOutput: passOne.rawModelOutput,
    parsedOutput: timeline,
    normalisedForNextStep: timeline,
    provider: timelineProviderUsed === "gemini" ? "gemini" : "openai",
    providerSource: visionRoute?.providerSource ?? "default",
    costUsd: passOne.costTotal,
    ...(fallbackWarning
      ? {
          fallbackWarning: `Gemini visual timeline failed, fell back to OpenAI: ${fallbackWarning}`
        }
      : {})
  });

  if (pipelineDebug?.jobId) {
    const pass1DebugAbs = path.join(
      getDebugRunsJobDirAbsolute(pipelineDebug.jobId),
      "visual-timeline.json"
    );
    const hiMoments = /** @type {unknown[]} */ (timeline.high_confidence_moments);
    const loMoments = /** @type {unknown[]} */ (timeline.low_confidence_moments);
    const phases = /** @type {unknown[]} */ (timeline.phases);
    if (timelineProviderUsed === "gemini") {
      console.log("GEMINI VISUAL TIMELINE COMPLETE");
    } else {
      console.log("VISUAL TIMELINE COMPLETE");
    }
    console.log(`DEBUG FILE: ${pass1DebugAbs}`);
    console.log(`PHASE COUNT: ${phases.length}`);
    console.log(`HIGH CONFIDENCE MOMENTS: ${hiMoments.length}`);
    console.log(`LOW CONFIDENCE MOMENTS: ${loMoments.length}`);
  }

  const phaseCount = /** @type {unknown[]} */ (timeline.phases).length;
  const passTwoUser = `Derive coaching ONLY from Pass 1 JSON — not imagination. Produce a STORY-LED breakdown of THIS roll. Phase indexes are 0-based (valid: 0 … ${phaseCount - 1}).

STORY THEMES — main_coaching_themes[].theme:
• Themes read like vignettes tied to timestamps, Pass 1 top_player/bottom_player labels, tracked athlete user_role arcs, observable_details/key_events — NOT syllabus titles.
BAD theme wording — do not use generic syllabus headers such as "Handling Side Control Pressure", "Effective Transition to Seated Guard", or "Defensive Guard Maintenance".
BETTER: concrete story beats — cite when the shift happened, approximate second span from phases, who had which role per Pass 1, and what Pass 1 observable_details say changed (e.g. "first meaningful shift was settling to seated guard after standing contact stalls" or "late footage shows tracked athlete stuck underneath with late bridges only, per observable_details").

coaching_summary — narrative arc ONLY for THIS footage:
Opening → pivotal role/control changes (phase-anchored) → clearest proactive window → where the tracked athlete turned reactive/defensive → the single cohesive learning thread — ban generic intros.

EVIDENCE + CORRECTION STYLE:
• Every theme must cite evidence_phase_indexes plus visual_evidence strings that quote or near-quote Pass 1 fields for those phases.
• possible_correction MUST describe what to watch for on the footage (order/timing of hips vs frames, before chest pressure settles) using only what Pass 1 states. Do not output naked study plans alone (e.g. "drill escapes regularly", vague "improve timing", blanket "maintain pressure") unless each ties to a cited Pass 1 observable beat.
• Confidence inherits Pass 1 visual_certainty: never mark confidence \"high\" unless EVERY linked Pass 1 phase is visual_certainty \"high\". If any linked phase is medium → coaching confidence must be medium or low only; any low phase forces low only (the server clamps — still choose correctly).
• Avoid broad fluff unless each clause cites a Pass 1 beat: drill regularly • improve timing • focus on grips • maintain pressure • be more deliberate • stay calm.

COACHING PACKAGE — required non-empty strings on EACH main_coaching_theme AND EACH best_learning_moment:
coaching_lesson, improvement_area, what_user_could_have_done, what_opponent_did_well, suggested_drill, evidence_basis (evidence_basis cites which observable_details/key_events anchor the lesson).
Across ALL themes + moments collectively surface: ≥1 warranted athlete strength with visible WHY OR frank admission positives were scarce; ALWAYS ≥1 improvement corridor; ALWAYS ≥1 opponent-linked teaching moment for the tracked athlete OR honest neutral framing + self-error lesson; ALWAYS ≥1 concrete drill/training constraint.

LONG final phase: split into multiple best_learning_moments only when Pass 1 exposes distinct sub-beats; otherwise prefer one moment and use avoid_commenting_on if the segment is low-value for narration.

SCALE: ${pass2CoachingScaleHint(videoDurationSeconds)}

JSON only — same structure (omit schema_version here; added downstream):
{
  "coaching_summary": string,
  "main_coaching_themes": [
    {
      "theme": string,
      "evidence_phase_indexes": [number],
      "visual_evidence": [string],
      "why_it_matters": string,
      "coaching_angle": string,
      "coaching_lesson": string,
      "improvement_area": string,
      "what_user_could_have_done": string,
      "what_opponent_did_well": string,
      "suggested_drill": string,
      "evidence_basis": string,
      "confidence": "high" | "medium" | "low"
    }
  ],
  "best_learning_moments": [
    {
      "phase_index": number,
      "time_range": { "start": number, "end": number },
      "what_happened": string,
      "why_it_matters": string,
      "what_to_notice": string,
      "possible_correction": string,
      "coaching_lesson": string,
      "improvement_area": string,
      "what_user_could_have_done": string,
      "what_opponent_did_well": string,
      "suggested_drill": string,
      "evidence_basis": string,
      "confidence": "high" | "medium" | "low"
    }
  ],
  "avoid_commenting_on": [
    { "phase_index": number, "reason": string }
  ]
}

Pass 1 timeline (JSON):\n${JSON.stringify(timeline)}${participantInstruction}`;

  const passTwoMessages = [
    { role: "system", content: PASS_TWO_SYSTEM_PROMPT },
    { role: "user", content: passTwoUser }
  ];
  const passTwo = await runJsonPass(passTwoMessages, "Coaching interpretation");
  /** @type {Record<string, unknown>} */
  const coaching = normalizePass2Interpretation(passTwo.parsed, phaseCount);
  enforcePass2ConfidenceAgainstPass1(coaching, timeline);
  coaching.schema_version = PASS_TWO_SCHEMA_VERSION;

  await writePipelineDebugArtifact(
    pipelineDebug,
    "coaching-interpretation.json",
    "Coaching interpretation",
    {
      rawModelOutput: passTwo.rawModelOutput,
      parsedOutput: coaching,
      normalisedForNextStep: coaching
    }
  );

  if (pipelineDebug?.jobId) {
    const themes = /** @type {unknown[]} */ (coaching.main_coaching_themes);
    const moments = /** @type {unknown[]} */ (coaching.best_learning_moments);
    const avoid = /** @type {unknown[]} */ (coaching.avoid_commenting_on);
    console.log("COACHING INTERPRETATION COMPLETE");
    console.log(`SCHEMA VERSION: ${PASS_TWO_SCHEMA_VERSION}`);
    console.log(`THEME COUNT: ${themes.length}`);
    console.log(`LEARNING MOMENT COUNT: ${moments.length}`);
    console.log(`AVOID COMMENTING COUNT: ${avoid.length}`);
  }

  const phaseSpans = /** @type {unknown[]} */ (timeline.phases).map((p) => {
    if (!p || typeof p !== "object") {
      return { start: 0, end: 0 };
    }
    const o = /** @type {Record<string, unknown>} */ (p);
    return {
      start: Number(o.start) || 0,
      end: Number(o.end) || 0
    };
  });

  const vcvUserContent = await buildVisualClaimVerificationUserContent(
    sampledFrames,
    videoDurationSeconds,
    timeline,
    coaching,
    participantInstruction
  );
  const visualClaimMessages = [
    { role: "system", content: VISUAL_CLAIM_VERIFICATION_SYSTEM_PROMPT },
    { role: "user", content: vcvUserContent }
  ];
  const visualClaimPass = await runJsonPass(
    visualClaimMessages,
    "Visual Claim Verification"
  );
  const visualClaimVerification = normalizeVisualClaimVerification(
    visualClaimPass.parsed,
    phaseSpans
  );

  await writePipelineDebugArtifact(
    pipelineDebug,
    "visual-claim-verification.json",
    "Visual Claim Verification",
    {
      rawModelOutput: visualClaimPass.rawModelOutput,
      parsedOutput: visualClaimVerification,
      normalisedForNextStep: visualClaimVerification
    }
  );

  const pv = /** @type {unknown[]} */ (visualClaimVerification.phase_verification ?? []);
  const lowConf = pv.filter(
    (row) =>
      row &&
      typeof row === "object" &&
      /** @type {Record<string, unknown>} */ (row).confidence === "low"
  ).length;
  const gw =
    /** @type {unknown[]} */ (visualClaimVerification.global_warnings ?? []).length;
  console.log("VISUAL CLAIM VERIFICATION COMPLETE");
  console.log(`SCHEMA VERSION: ${VISUAL_CLAIM_VERIFICATION_SCHEMA_VERSION}`);
  console.log(`VERIFIED PHASE COUNT: ${pv.length}`);
  console.log(`LOW CONFIDENCE PHASES: ${lowConf}`);
  console.log(`GLOBAL WARNINGS: ${gw}`);

  // --- Narrative planning ---
  // Designs story structure (arc, energy curve, section plan) with NO timing constraints.
  // Writing comes first; timing adapts after TTS in processVideo.js.
  const passThreeUserText = `${buildPassThreeNarrativePlanPrompt(videoDurationSeconds)}

Visual timeline:\n${JSON.stringify(timeline)}\n\nCoaching interpretation:\n${JSON.stringify(
    coaching
  )}\n\nVisual Claim Verification (binding for positions, dominance, roles — do not plan arcs that contradict it):\n${JSON.stringify(
    visualClaimVerification
  )}${participantInstruction}`;

  const passThreeMessages = [
    { role: "system", content: PASS_THREE_SYSTEM_PROMPT },
    { role: "user", content: passThreeUserText }
  ];
  const passThree = await runJsonPass(passThreeMessages, "Narrative plan");

  const narrativePlan = normalizePass3NarrativePlan(passThree.parsed, videoDurationSeconds, phaseCount, timeline);
  narrativePlan.schema_version = PASS_THREE_SCHEMA_VERSION;

  applySpeechDensityNormalizationToPlan(
    narrativePlan,
    videoDurationSeconds,
    timeline,
    coaching,
    visualClaimVerification
  );

  await writePipelineDebugArtifact(pipelineDebug, "narrative-plan.json", "Narrative plan", {
    rawModelOutput: passThree.rawModelOutput,
    parsedOutput: narrativePlan,
    normalisedForNextStep: narrativePlan
  });

  const dens = /** @type {Record<string, unknown>} */ (narrativePlan.speech_density_metrics ?? {});
  console.log("SPEECH DENSITY PLAN COMPLETE");
  console.log(`SECTION COUNT: ${dens.sectionCount ?? 0}`);
  console.log(`SECTIONS SPLIT: ${dens.sectionsSplitForLength ?? 0}`);
  console.log(`LONGEST SECTION: ${dens.longestSectionSeconds ?? 0}`);
  console.log(
    `ESTIMATED COVERAGE: ${
      typeof dens.estimatedCoveragePct === "number" ? `${dens.estimatedCoveragePct.toFixed(1)}%` : "n/a"
    }`
  );
  console.log(`MAX SILENT GAP: ${dens.maxSilentGapSeconds ?? 0}`);

  console.log("NARRATIVE PLAN COMPLETE");
  console.log(`SCHEMA VERSION: ${PASS_THREE_SCHEMA_VERSION}`);
  console.log(`NARRATIVE STYLE: ${narrativePlan.narrative_style}`);
  console.log(`SECTION COUNT: ${/** @type {unknown[]} */ (narrativePlan.section_plan).length}`);
  console.log(`PRIMARY ARC: ${String(narrativePlan.primary_arc ?? "").slice(0, 80)}`);
  console.log(`ENERGY CURVE: ${/** @type {string[]} */ (narrativePlan.energy_curve ?? []).join(" → ")}`);
  if (pipelineDebug?.jobId) {
    const pass3DebugAbs = path.join(getDebugRunsJobDirAbsolute(pipelineDebug.jobId), "narrative-plan.json");
    console.log(`DEBUG FILE: ${pass3DebugAbs}`);
  }

  // --- Voiceover script ---
  const voiceCtx = {
    videoDurationSeconds,
    timeline,
    coaching,
    visualClaimVerification,
    narrativePlan,
    participantInstruction,
    phaseCount
  };

  let { passFour, scriptPayload } = await runPassFourVoiceoverPipeline(voiceCtx, "", "Voiceover script");

  let scriptSections = /** @type {Record<string, unknown>[]} */ (scriptPayload.sections);

  await writePipelineDebugArtifact(pipelineDebug, "voiceover-script.json", "Voiceover script", {
    rawModelOutput: passFour.rawModelOutput,
    parsedOutput: scriptPayload,
    normalisedForNextStep: scriptPayload
  });

  if (pipelineDebug?.jobId) {
    const wc = scriptSections.map((s) => Number(s.word_count));
    const totalWords = wc.reduce((a, b) => a + b, 0);
    const avgWords = wc.length ? Math.round((totalWords / wc.length) * 10) / 10 : 0;
    console.log("VOICEOVER SCRIPT COMPLETE");
    console.log(`SCHEMA VERSION: ${PASS_FOUR_SCHEMA_VERSION}`);
    console.log(`SECTION COUNT: ${scriptSections.length}`);
    console.log(`TOTAL WORDS: ${totalWords}`);
    console.log(`AVG WORDS PER SECTION: ${avgWords}`);
    const vsAbs = path.join(getDebugRunsJobDirAbsolute(pipelineDebug.jobId), "voiceover-script.json");
    console.log(`DEBUG FILE: ${vsAbs}`);
  }

  const llmTotal =
    passOne.costTotal +
    passTwo.costTotal +
    visualClaimPass.costTotal +
    passThree.costTotal +
    passFour.costTotal;
  console.log(
    `LLM pipeline stages (timeline + coaching + visual verification + narrative + script) total cost: $${llmTotal.toFixed(4)}`
  );

  return {
    // scriptSections: flowing narration sections without timing (timing assigned in processVideo.js)
    scriptSections,
    // voiceoverSectionsRaw kept as alias so existing callers don't hard-crash during transition
    voiceoverSectionsRaw: scriptSections,
    /** @type {typeof timeline} */
    passOneAnalysis: timeline,
    coachingInterpretation: coaching,
    narrativePlan,
    // narrationPlan alias kept for QA pass which still references this field
    narrationPlan: narrativePlan,
    visualClaimVerification,
    usage: {
      pass1PromptTokens: passOne.promptTokensTotal,
      pass1CompletionTokens: passOne.completionTokensTotal,
      pass1CostUsd: passOne.costTotal,
      pass2PromptTokens: passTwo.promptTokensTotal,
      pass2CompletionTokens: passTwo.completionTokensTotal,
      pass2CostUsd: passTwo.costTotal,
      // Visual Claim Verification tokens merged into pass3 slot (no DB migration).
      pass3PromptTokens: passThree.promptTokensTotal + visualClaimPass.promptTokensTotal,
      pass3CompletionTokens:
        passThree.completionTokensTotal + visualClaimPass.completionTokensTotal,
      pass3CostUsd: passThree.costTotal + visualClaimPass.costTotal,
      pass4PromptTokens: passFour.promptTokensTotal,
      pass4CompletionTokens: passFour.completionTokensTotal,
      pass4CostUsd: passFour.costTotal
    },
    visionTimelineProviderUsed: timelineProviderUsed
  };
}

/**
 * Pass 7 — developer QA (does not affect narration output).
 * Weighted sub-scores; final analysis_quality_score is capped by objective metrics.
 */
export async function scoreAnalysisQuality({
  videoDurationSeconds,
  passOneAnalysis,
  coachingInterpretation = null,
  narrationPlan = null,
  passTwoSegments,
  passThreeValidatedDetails,
  passThreeSegmentsDropped,
  passThreeSegmentsPushed,
  passFiveAdjustments = [],
  coverageMetrics
}) {
  const payload = {
    video_duration_seconds: videoDurationSeconds,
    coverage_metrics: coverageMetrics,
    pass1_visual_timeline: {
      video_duration_seconds: passOneAnalysis?.video_duration_seconds,
      phases: passOneAnalysis?.phases,
      roll_title: passOneAnalysis?.roll_title,
      summary: passOneAnalysis?.summary
    },
    pass2_coaching_interpretation: coachingInterpretation ?? null,
    pass3_narration_plan: narrationPlan ?? null,
    pass4_final_voiceover_sections: passTwoSegments,
    pass6_post_tts_validated_timestamps_and_durations: passThreeValidatedDetails,
    pass6_segments_dropped: passThreeSegmentsDropped,
    pass6_segments_pushed: passThreeSegmentsPushed,
    pass5_pre_tts_timing_adjustments: passFiveAdjustments ?? []
  };

  const capsBlock = `HARD SCORE CAPS — apply these before choosing analysis_quality_score (use the lowest applicable cap as the maximum allowed final score):
- If speech_coverage_pct < 22: max analysis_quality_score = 5.5
- If speech_coverage_pct < 28: max analysis_quality_score = 6.0
- If max_silent_gap > 30: max analysis_quality_score = 5.8
- If max_silent_gap > 22: max analysis_quality_score = 6.2
- If average_silent_gap > 18: max analysis_quality_score = 6.5
- If average_silent_gap > 14: max analysis_quality_score = 7.0
- If overlap_count > 0: max analysis_quality_score = 5.0
- If segment_count < 3 and video_duration > 45: max analysis_quality_score = 5.5
- If avg_words_per_segment < 22 with segment_count >= 4: max analysis_quality_score = 6.0
- If unplanned_silence_penalty > 40: max analysis_quality_score = 6.3

Objective coverage_metrics (already computed) are authoritative for these caps.`;

  const userText = `You are evaluating automated pipeline quality for internal QA — post-roll coaching narrative, NOT live commentary.

${capsBlock}

Heavily penalise: isolated one-sentence fragments; timestamps not tied to visual phases; excessive silence that was NOT part of the narration plan; live-commentary tone; generic coaching not grounded in Pass 1 timeline evidence.

Coverage metrics (objective):
${JSON.stringify(coverageMetrics, null, 2)}

Score dimensions (each integer 0–10):
- visual_accuracy: whether Pass 1 timeline phases and key_events are coherent, specific, and plausible.
- coaching_usefulness: whether the full stack (Pass 2 interpretation + Pass 3 intents + Pass 4 script) is genuinely instructive—not just describing motion.
- actionable_feedback: density of concrete corrections, decisions, drills, and training focuses users can apply.
- improvement_identified: whether a clear athlete improvement corridor + final synthesis ("main thing to work on" + drill echo) is unmistakable.
- timing_accuracy: Pass 4/5 text timing vs windows; Pass 6 audio placement vs video duration and gaps.
- speech_coverage: speech time and silence vs plan (use coverage_metrics; penalise unplanned long gaps).
- output_compliance: structural rules, retrospective tense, evidence-based wording, visual claim verification adherence.
- narrative_coherence: holistic review flow vs fragments; coaching_intent variety.

Heavily penalise (drive coaching_usefulness, actionable_feedback, improvement_identified toward 0–3 when applicable):
• Narration mostly describes action without lessons.
• No clear improvement area or final "main thing to work on" + drill restatement grounded in earlier themes.
• No opponent-linked teaching that loops to the tracked athlete (or honest reframing absent).
• Praise is generic / not tied to a visible cause.
• Opponent success without user-facing lesson linkage.
• Closing summary introduces brand-new observations vs earlier themes.

Weights for the weighted average:
0.16×visual_accuracy + 0.16×coaching_usefulness + 0.15×timing_accuracy + 0.12×speech_coverage + 0.09×output_compliance + 0.20×narrative_coherence + 0.07×actionable_feedback + 0.05×improvement_identified

Return ONLY valid JSON in this exact shape (numbers as shown types):
{"analysis_quality_score":0.0,"visual_accuracy":0,"coaching_usefulness":0,"actionable_feedback":0,"improvement_identified":0,"timing_accuracy":0,"speech_coverage":0,"output_compliance":0,"narrative_coherence":0,"main_issues":[],"recommended_fix":""}

Full pipeline data (JSON):\n${JSON.stringify(payload, null, 2)}`;

  const messages = [
    { role: "system", content: PASS_FOUR_QA_SYSTEM_PROMPT },
    { role: "user", content: userText }
  ];

  const qaPass = await runJsonPass(messages, "Pass 7 (QA)");
  const parsed = qaPass.parsed;

  const clamp = (n) => Math.max(0, Math.min(10, Math.round(Number(n)) || 0));
  const visual_accuracy = clamp(parsed.visual_accuracy);
  const coaching_usefulness = clamp(parsed.coaching_usefulness);
  const actionable_feedback = clamp(
    parsed.actionable_feedback !== undefined ? parsed.actionable_feedback : parsed.coaching_usefulness
  );
  const improvement_identified = clamp(
    parsed.improvement_identified !== undefined
      ? parsed.improvement_identified
      : parsed.actionable_feedback !== undefined
        ? parsed.actionable_feedback
        : coaching_usefulness
  );
  const timing_accuracy = clamp(parsed.timing_accuracy);
  const speech_coverage = clamp(
    parsed.speech_coverage !== undefined ? parsed.speech_coverage : parsed.speech_fit
  );
  const output_compliance = clamp(parsed.output_compliance);
  const narrative_coherence = clamp(parsed.narrative_coherence);

  const uncappedWeighted =
    Math.round(
      (visual_accuracy * QA_WEIGHTS.visual_accuracy +
        coaching_usefulness * QA_WEIGHTS.coaching_usefulness +
        timing_accuracy * QA_WEIGHTS.timing_accuracy +
        speech_coverage * QA_WEIGHTS.speech_coverage +
        output_compliance * QA_WEIGHTS.output_compliance +
        narrative_coherence * QA_WEIGHTS.narrative_coherence +
        actionable_feedback * QA_WEIGHTS.actionable_feedback +
        improvement_identified * QA_WEIGHTS.improvement_identified) *
        10
    ) / 10;

  const ceiling = computeAnalysisQualityScoreCeiling(coverageMetrics);
  const analysis_quality_score = Math.min(uncappedWeighted, ceiling);

  const main_issues = Array.isArray(parsed.main_issues)
    ? parsed.main_issues.map((x) => String(x))
    : [];
  const recommended_fix = typeof parsed.recommended_fix === "string" ? parsed.recommended_fix : "";

  return {
    analysis_quality_score,
    visual_accuracy,
    coaching_usefulness,
    actionable_feedback,
    improvement_identified,
    timing_accuracy,
    speech_coverage,
    output_compliance,
    narrative_coherence,
    main_issues,
    recommended_fix,
    usage: {
      pass5PromptTokens: qaPass.promptTokensTotal,
      pass5CompletionTokens: qaPass.completionTokensTotal,
      pass5CostUsd: qaPass.costTotal
    }
  };
}

async function runChatCompletion(messages) {
  const MAX_RETRIES = 4;
  const BASE_DELAY_MS = 5000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages
      })
    });

    if (response.status === 429 && attempt < MAX_RETRIES) {
      const retryAfterSec = parseInt(response.headers.get("retry-after") || "0", 10);
      const resetRequests = response.headers.get("x-ratelimit-reset-requests");
      const resetTokens = response.headers.get("x-ratelimit-reset-tokens");
      const body429 = await response.text().catch(() => "(unreadable)");
      const delay = retryAfterSec > 0 ? retryAfterSec * 1000 : BASE_DELAY_MS * 2 ** attempt;
      console.warn(
        `OpenAI 429 — retry-after=${retryAfterSec}s reset-requests=${resetRequests} reset-tokens=${resetTokens} body=${body429} — waiting ${delay}ms before retry (attempt ${attempt + 1}/${MAX_RETRIES})`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      const preview = errBody.replace(/\s+/g, " ").trim().slice(0, 1500);
      console.error(
        `OpenAI Chat Completions HTTP ${response.status} — user-facing message will be generic. Response preview (log only): ${preview || "(empty body)"}`
      );
      throw new Error(`OpenAI request failed with status ${response.status}`);
    }

    return response.json();
  }

  throw new Error("OpenAI request failed with status 429 after retries");
}

function calculatePassCost(usage) {
  const promptTokens = usage?.prompt_tokens || 0;
  const completionTokens = usage?.completion_tokens || 0;
  const inputCost = (promptTokens / 1_000_000) * INPUT_COST_PER_MILLION;
  const outputCost = (completionTokens / 1_000_000) * OUTPUT_COST_PER_MILLION;

  return {
    promptTokens,
    completionTokens,
    total: inputCost + outputCost
  };
}
