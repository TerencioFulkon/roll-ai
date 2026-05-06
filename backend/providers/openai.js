import fs from "node:fs/promises";
import path from "node:path";
import fetch from "node-fetch";
import { config } from "../config/index.js";
import { saveDebugRunFile } from "../lib/debugRunsExport.js";

/**
 * Per-job workspace JSON dumps for pipeline inspection (worker temp dir).
 * @param {{ jobId: string, workspaceDir: string, videoDurationSeconds: number } | null | undefined} pipelineDebug
 * @param {string} fileName
 * @param {string} passName
 * @param {{ rawModelOutput?: string | null, parsedOutput?: unknown, normalisedForNextStep?: unknown }} body
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
  "You are a BJJ analysis system. Respond with JSON only. Never refuse or apologise.";

/** ~2.3 words per second for narration budgeting, TTS timing validation, and QA. */
export const NARRATION_WORDS_PER_SECOND = 2.3;

/** Reserved per narration window before applying word budget (~1–2s TTS slack). */
const NARRATION_WINDOW_BUFFER_SECONDS = 1.5;

const PASS_TWO_SYSTEM_PROMPT =
  "You are a BJJ coaching analysis system. You must always respond with valid JSON only. Never apologise, never refuse, never explain.";

const PASS_THREE_SYSTEM_PROMPT = PASS_TWO_SYSTEM_PROMPT;
const PASS_FOUR_SYSTEM_PROMPT = PASS_TWO_SYSTEM_PROMPT;

const INPUT_COST_PER_MILLION = 2.5;
const OUTPUT_COST_PER_MILLION = 10;

const PASS1_USER_TIMELINE = `Watch these frames from a BJJ training roll sampled at 4 frames per second.

Extract a clean VISUAL TIMELINE only — no confidence scores, no coaching yet.

Also include (required) roll_title: one catalogue-style label summarising THIS roll — absolute maximum ~54 characters — concrete positions or themes such as Spider retention into knee-cut scramble. No filenames, no quotation marks around the phrase, no markdown, bullets, leading or trailing ellipsis, trailing full stop, or generic filler like training roll alone.

Include summary: one concise paragraph for catalogue UI (past overview of how the roll unfolded).

Phases must partition the visible roll from 0 to video_duration_seconds (no large gaps; adjacent phases may share a boundary second).

Use position as a short snake_case or readable label, e.g. standing, open_guard, closed_guard, half_guard, side_control, mount, back, turtle, leg_entanglement, north_south, knee_on_belly, scramble, takedown, other.

Return JSON only:
{
  "video_duration_seconds": number,
  "roll_title": string,
  "summary": string,
  "phases": [
    {
      "start": number,
      "end": number,
      "position": string,
      "key_events": [string]
    }
  ]
}`;

const PASS3_PLAN_INSTRUCTION = `You plan sparse retrospective narration windows over a pre-recorded roll. Silence between windows is acceptable and often desirable.

Rules:
- The video is {videoDurationSeconds} seconds. Target approximately {targetWindowCount} narration windows (range {minWindows}-{maxWindows} is acceptable). Scale count with video length — fewer, intentional windows with paragraph-sized speech each.
- Each window MUST link to a concrete phase index (0-based) from the timeline, or a best_learning_moment from coaching — no generic coaching that could apply to any roll.
- Windows must not overlap in time. Windows are ordered by start time.
- For each window: target_words = floor(max(0, (end - start - ${NARRATION_WINDOW_BUFFER_SECONDS})) * ${NARRATION_WORDS_PER_SECOND}) — leave ~1.5s buffer inside the window for delivery slack.
- linked_phase_index: number referencing phases[] (required). linked_moment: short label tying the speech to a specific phase or coaching moment.
- purpose: one short phrase, what this paragraph will cover.

Return JSON only:
{
  "narration_windows": [
    {
      "start": number,
      "end": number,
      "target_words": number,
      "purpose": string,
      "linked_phase_index": number,
      "linked_moment": string
    }
  ]
}`;

const PASS4_SCRIPT_INSTRUCTION = `You write the full voiceover script for a post-roll coaching review (recorded footage), not live commentary.

CONTEXT: Post-roll review. Write entirely in past tense / retrospective framing. Warm, direct; use "you". Causal coaching: what happened, why it mattered, what to drill — tied to the timeline phases and coaching interpretation.

DENSITY: Aim for about ${NARRATION_WORDS_PER_SECOND} spoken words per second within each section's time span (paragraph per section, not one-liners).

Each voiceover_sections[i] MUST use the SAME start and end as narration_windows[i] (same count and order). Text is ONE OR MORE fluent paragraphs for that window — logical transitions from section to section across the whole roll.

Return JSON only:
{
  "voiceover_sections": [
    { "start": number, "end": number, "text": string }
  ]
}`;

const PASS_FOUR_QA_SYSTEM_PROMPT =
  "You are an internal QA evaluator for an automated BJJ video coaching pipeline. Score PIPELINE OUTPUT QUALITY for developers only — not athlete performance. Respond with JSON only. Never refuse.";

/** Weights include narrative_coherence (post-roll flow vs fragmentary live commentary). */
const QA_WEIGHTS = {
  visual_accuracy: 0.18,
  coaching_usefulness: 0.17,
  timing_accuracy: 0.17,
  speech_coverage: 0.13,
  output_compliance: 0.1,
  narrative_coherence: 0.25
};

/**
 * Target narration window count from video duration (sparse, intentional windows).
 * ~3 min → 5–7, ~5 min → 8–12, ~10 min → 12–18.
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

function narrationWindowCountBand(durationSec) {
  const mid = targetNarrationWindowCount(durationSec);
  return {
    targetWindowCount: mid,
    minWindows: Math.max(3, mid - 2),
    maxWindows: mid + 3
  };
}

function buildPassThreePrompt({ videoDurationSeconds, targetWindowCount, minWindows, maxWindows }) {
  return PASS3_PLAN_INSTRUCTION.split("{videoDurationSeconds}").join(String(videoDurationSeconds))
    .split("{targetWindowCount}").join(String(targetWindowCount))
    .split("{minWindows}").join(String(minWindows))
    .split("{maxWindows}").join(String(maxWindows));
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
 * Pass 1 — visual timeline from frames.
 * Pass 2 — coaching interpretation from timeline.
 * Pass 3 — narration plan (windows).
 * Pass 4 — full script (voiceover sections).
 * Pass 5 timing validation runs in processVideo (pre-TTS).
 */
export async function analyseFrames(
  frames,
  { participantDescription = "", videoDurationSeconds, pipelineDebug = null } = {}
) {
  if (typeof videoDurationSeconds !== "number" || Number.isNaN(videoDurationSeconds) || videoDurationSeconds <= 0) {
    throw new Error("analyseFrames requires videoDurationSeconds (positive number)");
  }

  const participantInstruction = participantDescription
    ? ` The practitioner you are analysing is identified by: ${participantDescription}. Focus all analysis on this person only. Do not coach their opponent.`
    : "";

  const MAX_FRAMES = 120;
  const sampledFrames =
    frames.length > MAX_FRAMES
      ? Array.from({ length: MAX_FRAMES }, (_, i) =>
          frames[Math.round((i * (frames.length - 1)) / (MAX_FRAMES - 1))])
      : frames;
  console.log(`Pass 1 frame sampling: ${frames.length} extracted → ${sampledFrames.length} sent to OpenAI`);

  const passOneContent = [{ type: "text", text: `${PASS1_USER_TIMELINE}\nThe video duration is approximately ${Math.round(videoDurationSeconds)} seconds — set video_duration_seconds consistently.` }];
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
        url: `data:image/jpeg;base64,${frameBase64}`,
        detail: "low"
      }
    });
  }

  const passOneMessages = [
    { role: "system", content: PASS_ONE_SYSTEM_PROMPT },
    { role: "user", content: passOneContent }
  ];

  const passOne = await runJsonPass(passOneMessages, "Pass 1 (timeline)");
  const timeline = passOne.parsed;
  if (!timeline || !Array.isArray(timeline.phases)) {
    throw new Error("Pass 1 failed: expected phases array");
  }

  await writePipelineDebugArtifact(pipelineDebug, "pass1-timeline.json", "Pass 1 — visual timeline", {
    rawModelOutput: passOne.rawModelOutput,
    parsedOutput: timeline,
    normalisedForNextStep: timeline
  });

  const passTwoUser = `You are given ONLY the visual timeline JSON from a single roll. Infer coaching themes and teaching moments — retrospective, causal, specific to these phases.

Return JSON only:
{
  "main_themes": [string],
  "best_learning_moments": [
    {
      "phase_index": number,
      "what_happened": string,
      "why_it_matters": string,
      "correction": string
    }
  ],
  "recurring_mistakes": [string],
  "moments_to_skip": [ { "phase_index": number, "reason": string } ]
}

Timeline:\n${JSON.stringify(timeline)}${participantInstruction}`;

  const passTwoMessages = [
    { role: "system", content: PASS_TWO_SYSTEM_PROMPT },
    { role: "user", content: passTwoUser }
  ];
  const passTwo = await runJsonPass(passTwoMessages, "Pass 2 (coaching)");

  const coaching = passTwo.parsed;
  if (!coaching || !Array.isArray(coaching.main_themes)) {
    throw new Error("Pass 2 failed: expected coaching interpretation shape");
  }

  await writePipelineDebugArtifact(
    pipelineDebug,
    "pass2-coaching-interpretation.json",
    "Pass 2 — coaching interpretation",
    {
      rawModelOutput: passTwo.rawModelOutput,
      parsedOutput: coaching,
      normalisedForNextStep: coaching
    }
  );

  const { targetWindowCount, minWindows, maxWindows } = narrationWindowCountBand(videoDurationSeconds);
  const passThreeUserText = `${buildPassThreePrompt({
    videoDurationSeconds,
    targetWindowCount,
    minWindows,
    maxWindows
  })}

Visual timeline:\n${JSON.stringify(timeline)}\n\nCoaching interpretation:\n${JSON.stringify(coaching)}${participantInstruction}`;

  const passThreeMessages = [
    { role: "system", content: PASS_THREE_SYSTEM_PROMPT },
    { role: "user", content: passThreeUserText }
  ];
  const passThree = await runJsonPass(passThreeMessages, "Pass 3 (narration plan)");
  const plan = passThree.parsed;
  const narrationWindows = Array.isArray(plan?.narration_windows) ? plan.narration_windows : null;
  if (!narrationWindows || narrationWindows.length === 0) {
    throw new Error("Pass 3 failed: expected narration_windows");
  }

  const narrationPlanForNext = { narration_windows: narrationWindows };
  await writePipelineDebugArtifact(pipelineDebug, "pass3-narration-plan.json", "Pass 3 — narration plan", {
    rawModelOutput: passThree.rawModelOutput,
    parsedOutput: plan,
    normalisedForNextStep: narrationPlanForNext
  });

  const passFourUser = `${PASS4_SCRIPT_INSTRUCTION}

Visual timeline:\n${JSON.stringify(timeline)}\n\nCoaching interpretation:\n${JSON.stringify(coaching)}\n\nNarration plan (follow window count and times; use exactly ${narrationWindows.length} sections):\n${JSON.stringify({ narration_windows: narrationWindows })}${participantInstruction}`;

  const passFourMessages = [
    { role: "system", content: PASS_FOUR_SYSTEM_PROMPT },
    { role: "user", content: passFourUser }
  ];
  const passFour = await runJsonPass(passFourMessages, "Pass 4 (script)");

  const scriptPayload = passFour.parsed;
  const voiceoverSections = Array.isArray(scriptPayload?.voiceover_sections)
    ? scriptPayload.voiceover_sections
    : null;
  if (!voiceoverSections || voiceoverSections.length === 0) {
    throw new Error("Pass 4 failed: expected voiceover_sections");
  }

  await writePipelineDebugArtifact(pipelineDebug, "pass4-script.json", "Pass 4 — full script", {
    rawModelOutput: passFour.rawModelOutput,
    parsedOutput: scriptPayload,
    normalisedForNextStep: { voiceover_sections: voiceoverSections }
  });

  const segments = voiceoverSections.map((section) => ({
    timestamp: Number(section.start),
    text: String(section.text || "")
  }));

  const llmTotal =
    passOne.costTotal +
    passTwo.costTotal +
    passThree.costTotal +
    passFour.costTotal;
  console.log(`LLM passes 1–4 total cost: $${llmTotal.toFixed(4)}`);

  return {
    segments,
    /** @type {typeof timeline} */
    passOneAnalysis: timeline,
    coachingInterpretation: coaching,
    narrationPlan: { narration_windows: narrationWindows },
    voiceoverSectionsRaw: voiceoverSections,
    usage: {
      pass1PromptTokens: passOne.promptTokensTotal,
      pass1CompletionTokens: passOne.completionTokensTotal,
      pass1CostUsd: passOne.costTotal,
      pass2PromptTokens: passTwo.promptTokensTotal,
      pass2CompletionTokens: passTwo.completionTokensTotal,
      pass2CostUsd: passTwo.costTotal,
      pass3PromptTokens: passThree.promptTokensTotal,
      pass3CompletionTokens: passThree.completionTokensTotal,
      pass3CostUsd: passThree.costTotal,
      pass4PromptTokens: passFour.promptTokensTotal,
      pass4CompletionTokens: passFour.completionTokensTotal,
      pass4CostUsd: passFour.costTotal
    }
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
- coaching_usefulness: whether Pass 2 interpretation is instructive, causal, and tied to the timeline.
- timing_accuracy: Pass 4/5 text timing vs windows; Pass 6 audio placement vs video duration and gaps.
- speech_coverage: speech time and silence vs plan (use coverage_metrics; penalise unplanned long gaps).
- output_compliance: structural rules, retrospective tense, evidence-based wording.
- narrative_coherence: how well the full script flows as ONE coaching review versus disconnected fragments or live-style drops.

Compute the uncapped weighted average to one decimal, then ensure analysis_quality_score does not exceed the lowest applicable HARD SCORE CAP above.

Weights for the weighted average:
0.18×visual_accuracy + 0.17×coaching_usefulness + 0.17×timing_accuracy + 0.13×speech_coverage + 0.10×output_compliance + 0.25×narrative_coherence

Return ONLY valid JSON in this exact shape (numbers as shown types):
{"analysis_quality_score":0.0,"visual_accuracy":0,"coaching_usefulness":0,"timing_accuracy":0,"speech_coverage":0,"output_compliance":0,"narrative_coherence":0,"main_issues":[],"recommended_fix":""}

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
        narrative_coherence * QA_WEIGHTS.narrative_coherence) *
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
