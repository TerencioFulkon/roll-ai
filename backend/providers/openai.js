import fs from "node:fs/promises";
import fetch from "node-fetch";
import { config } from "../config/index.js";

const PASS_ONE_SYSTEM_PROMPT =
  "You are a BJJ analysis system. Respond with JSON only. Never refuse or apologise.";

const PASS_ONE_USER_PROMPT =
  "Watch these frames from a BJJ training roll sampled at 4 frames per second. Return a highly detailed holistic summary. Identify every significant moment - every position change, every grip fight, every transition, every submission attempt, every mistake, every good decision. Aim for at least 15-20 key moments with accurate timestamps. The more detail you provide, the better the coaching will be. ALSO include roll_title (required): one catalogue-style label summarising THIS roll — absolute maximum ~54 characters — concrete positions or themes such as Spider retention into knee-cut scramble. No filenames, no surrounding quotation marks around the phrase, no markdown, bullets, leading or trailing ellipsis, trailing full stop, or generic filler like training roll alone. Return JSON only: { summary: string, roll_title: string, key_moments: [ { timestamp: seconds, description: string } ], overall_theme: string, strengths: string, areas_to_improve: string }";


const PASS_TWO_SYSTEM_PROMPT =
  "You are a BJJ coaching analysis system. You must always respond with valid JSON only. Never apologise, never refuse, never explain.";
const INPUT_COST_PER_MILLION = 2.5;
const OUTPUT_COST_PER_MILLION = 10;

/** Pass 2 — fixed coaching voice / tense / causal rules (timing injected separately). */
const COACHING_PROMPT_CORE = `You are an expert BJJ coach delivering a post-roll review for a blue belt practitioner. You have already watched the entire roll and understand exactly how it unfolded from beginning to end.

CONTEXT — RECORDED FOOTAGE, NOT LIVE: This commentary will be played back over a pre-recorded video of a roll that already happened. You are NOT ringside or giving live commentary. Every segment must sound like retrospective coaching on footage you already reviewed — never like real-time coaching ("you're", "now you're", "here you're").

VOICE AND TENSE — PAST AND RETROSPECTIVE ONLY: Write entirely in past tense and retrospective framing. Prefer forms like: "you were", "you had", "at this point you had moved into", "by then you had", "what happened here was". For unstable positions or mistakes, use past or retrospective phrasing (e.g. "you were in an unstable position", "at this moment you had ended up in an unstable position") — never present tense ("you're in an unstable position"). Warm, direct, authoritative; instructional, not storytelling.

PERSPECTIVE: Always use "you" - direct, personal, coaching. Never "we". Address the practitioner directly at all times.

THE CORE PRINCIPLE - CAUSAL COACHING: Every observation must connect to a consequence and a correction. The format is: what you did, why it was a problem, what you should have done instead. Use causal language throughout: which meant, because of that, this is why, that opened up, which gave your opponent, so when, this is what allowed, leading to. Chain these together so each coaching point flows into the next.

FORESIGHT: Because you watched the entire roll, reference how early mistakes led to later problems - "the grip you lost at the start was what set up the pass two minutes later." Use this to show patterns across the whole roll.

OPENING: Begin with the practitioner's belt level, one specific physical characteristic visible in the footage, and immediately name the central problem or theme that defined this roll.

BODY (within timing limits below): Direct, instructional coaching through corrections and guidance. Name specific body parts, grips, and angles. For each chosen moment - name it, explain the mechanical reason it mattered, and give the specific correction. For each good moment - name exactly what they did well and why it worked. Prioritise quality over quantity: only the moments you output.

CLOSING: 2-3 sentences. The single most important technical thing to drill before the next session, and why. One genuine strength to build on.

LANGUAGE TOOLKIT (past / retrospective): "you had", "you were", "at this point you had", "by then", "what you had done was", "your right hand needed to have been", "by dropping your elbow there", "that grip had been costing you", "what you should have done instead was", "the reason that worked was", "this was what gave your opponent", "because your hips had been", "the correction there was", "you did a great job of", "this was why", "which had meant that", "that had set up".

NEVER: Live commentary tone ("you're", "now", "right now you're"). Present tense describing the roll as if it is happening now. "We" or "we found ourselves". Storytelling without instruction. Generic advice. Observations without corrections. Condescending framing.

TIMING AND DENSITY (mandatory — Pass 2):
- The video is {videoDurationSeconds} seconds long.
- Output at most {maxSegments} segments total. Select only the {maxSegments} highest-value, most instructionally useful coaching moments from this roll. Do not narrate every exchange or fill time — choose what teaches best.
- Space segments so no two segment start timestamps are closer than {minStartSpacingSeconds} seconds apart (minimum spacing = estimated longest clip {estimatedClipDuration}s + {safeGap}s safety gap).
- Each segment: exactly 1–2 sentences and at most 35 words in the "text" field.
- Do not place any segment start within the last {endBufferSeconds} seconds of the video: every "timestamp" must be strictly less than {latestAllowedStart} seconds (so starts stay at or before the usable window before the final {endBufferSeconds}s).

Return JSON only, no markdown: { segments: [ { timestamp: seconds, text: string } ] }`;

function buildPassTwoCoachingPrompt({
  videoDurationSeconds,
  maxSegments,
  estimatedClipDuration,
  safeGap,
  minStartSpacingSeconds,
  endBufferSeconds
}) {
  const latestAllowedStart = Math.max(0, videoDurationSeconds - endBufferSeconds);
  const subst = {
    "{videoDurationSeconds}": String(videoDurationSeconds),
    "{maxSegments}": String(maxSegments),
    "{estimatedClipDuration}": String(estimatedClipDuration),
    "{safeGap}": String(safeGap),
    "{minStartSpacingSeconds}": String(minStartSpacingSeconds),
    "{endBufferSeconds}": String(endBufferSeconds),
    "{latestAllowedStart}": String(latestAllowedStart)
  };
  let out = COACHING_PROMPT_CORE;
  for (const [token, value] of Object.entries(subst)) {
    out = out.split(token).join(value);
  }
  return out;
}

export async function analyseFrames(
  frames,
  {
    participantDescription = "",
    videoDurationSeconds,
    maxSegments,
    estimatedClipDuration,
    safeGap,
    minStartSpacingSeconds,
    endBufferSeconds = 15
  } = {}
) {
  if (
    typeof videoDurationSeconds !== "number" ||
    Number.isNaN(videoDurationSeconds) ||
    typeof maxSegments !== "number" ||
    typeof estimatedClipDuration !== "number" ||
    typeof safeGap !== "number" ||
    typeof minStartSpacingSeconds !== "number"
  ) {
    throw new Error(
      "analyseFrames requires Pass 2 timing: videoDurationSeconds, maxSegments, estimatedClipDuration, safeGap, minStartSpacingSeconds"
    );
  }

  const participantInstruction = participantDescription
    ? ` The practitioner you are analysing is identified by: ${participantDescription}. Focus all analysis and coaching on this person only. Do not coach or analyse their opponent.`
    : "";

  const MAX_FRAMES = 120;
  const sampledFrames = frames.length > MAX_FRAMES
    ? Array.from({ length: MAX_FRAMES }, (_, i) => frames[Math.round(i * (frames.length - 1) / (MAX_FRAMES - 1))])
    : frames;
  console.log(`Pass 1 frame sampling: ${frames.length} extracted → ${sampledFrames.length} sent to OpenAI`);

  const passOneContent = [{ type: "text", text: PASS_ONE_USER_PROMPT }];
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

  let passOneParsed;
  let passOneCostTotal = 0;
  let passOnePromptTokensTotal = 0;
  let passOneCompletionTokensTotal = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    const passOneData = await runChatCompletion(passOneMessages);
    const passOneCost = calculatePassCost(passOneData.usage);
    passOneCostTotal += passOneCost.total;
    passOnePromptTokensTotal += passOneCost.promptTokens;
    passOneCompletionTokensTotal += passOneCost.completionTokens;
    console.log(`Pass 1 attempt ${attempt + 1} tokens:`, passOneData.usage);
    console.log(
      `Pass 1 attempt ${attempt + 1} cost: $${passOneCost.total.toFixed(4)} (${passOneCost.promptTokens.toLocaleString()} input @ $${INPUT_COST_PER_MILLION.toFixed(
        2
      )}/M + ${passOneCost.completionTokens.toLocaleString()} output @ $${OUTPUT_COST_PER_MILLION.toFixed(2)}/M)`
    );

    const rawContent = passOneData?.choices?.[0]?.message?.content;
    if (!rawContent) {
      console.error(`Pass 1 attempt ${attempt + 1}: response had no message content`);
      if (attempt === 1) {
        throw new Error("Pass 1 failed: GPT-4o returned non-JSON response");
      }
      continue;
    }

    console.log(`Pass 1 attempt ${attempt + 1} raw response content:`, rawContent);
    const cleaned = rawContent.replace(/```json|```/g, "").trim();
    try {
      passOneParsed = JSON.parse(cleaned);
      break;
    } catch (parseError) {
      console.error(`Pass 1 attempt ${attempt + 1} JSON parse failed:`, parseError.message);
      console.error("Pass 1 raw response text:", rawContent);
      if (attempt === 1) {
        throw new Error("Pass 1 failed: GPT-4o returned non-JSON response");
      }
    }
  }

  if (passOneParsed === undefined) {
    throw new Error("Pass 1 failed: GPT-4o returned non-JSON response");
  }

  console.log(`Pass 1 total cost: $${passOneCostTotal.toFixed(4)}`);

  const coachingPrompt = buildPassTwoCoachingPrompt({
    videoDurationSeconds,
    maxSegments,
    estimatedClipDuration,
    safeGap,
    minStartSpacingSeconds,
    endBufferSeconds
  });

  const passTwoUserPrompt = `${coachingPrompt}${participantInstruction}

Here is your complete analysis of the roll: ${JSON.stringify(passOneParsed)}. Using this holistic understanding of the entire roll, write the coaching commentary script that obeys all TIMING AND DENSITY rules above.`;

  const passTwoMessages = [
    { role: "system", content: PASS_TWO_SYSTEM_PROMPT },
    { role: "user", content: passTwoUserPrompt }
  ];
  console.log("Pass 2 messages payload:", passTwoMessages);

  let passTwoParsed;
  let passTwoCostTotal = 0;
  let passTwoPromptTokensTotal = 0;
  let passTwoCompletionTokensTotal = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    const passTwoData = await runChatCompletion(passTwoMessages);
    const passTwoCost = calculatePassCost(passTwoData.usage);
    passTwoCostTotal += passTwoCost.total;
    passTwoPromptTokensTotal += passTwoCost.promptTokens;
    passTwoCompletionTokensTotal += passTwoCost.completionTokens;
    console.log(`Pass 2 attempt ${attempt + 1} tokens:`, passTwoData.usage);
    console.log(
      `Pass 2 attempt ${attempt + 1} cost: $${passTwoCost.total.toFixed(4)} (${passTwoCost.promptTokens.toLocaleString()} input @ $${INPUT_COST_PER_MILLION.toFixed(
        2
      )}/M + ${passTwoCost.completionTokens.toLocaleString()} output @ $${OUTPUT_COST_PER_MILLION.toFixed(2)}/M)`
    );

    const rawContent = passTwoData?.choices?.[0]?.message?.content;
    if (!rawContent) {
      console.error(`Pass 2 attempt ${attempt + 1}: response had no message content`);
      if (attempt === 1) {
        throw new Error("Pass 2 failed: GPT-4o returned non-JSON response");
      }
      continue;
    }

    console.log(`Pass 2 attempt ${attempt + 1} raw response content:`, rawContent);
    const cleaned = rawContent.replace(/```json|```/g, "").trim();
    try {
      passTwoParsed = JSON.parse(cleaned);
      break;
    } catch (parseError) {
      console.error(`Pass 2 attempt ${attempt + 1} JSON parse failed:`, parseError.message);
      console.error("Pass 2 raw response text:", rawContent);
      if (attempt === 1) {
        throw new Error("Pass 2 failed: GPT-4o returned non-JSON response");
      }
    }
  }

  if (passTwoParsed === undefined) {
    throw new Error("Pass 2 failed: GPT-4o returned non-JSON response");
  }

  console.log(`Pass 2 total cost: $${passTwoCostTotal.toFixed(4)}`);
  console.log(`Total analysis cost: $${(passOneCostTotal + passTwoCostTotal).toFixed(4)}`);
  const segments = Array.isArray(passTwoParsed) ? passTwoParsed : passTwoParsed.segments;
  if (!Array.isArray(segments)) {
    throw new Error("Expected Pass 2 response with segments array");
  }

  const mappedSegments = segments.map((segment) => ({
    timestamp: Number(segment.timestamp),
    text: String(segment.text || "")
  }));

  return {
    segments: mappedSegments,
    passOneAnalysis: passOneParsed,
    usage: {
      pass1PromptTokens: passOnePromptTokensTotal,
      pass1CompletionTokens: passOneCompletionTokensTotal,
      pass1CostUsd: passOneCostTotal,
      pass2PromptTokens: passTwoPromptTokensTotal,
      pass2CompletionTokens: passTwoCompletionTokensTotal,
      pass2CostUsd: passTwoCostTotal
    }
  };
}

const PASS_FOUR_QA_SYSTEM_PROMPT =
  "You are an internal QA evaluator for an automated BJJ video coaching pipeline. Score PIPELINE OUTPUT QUALITY for developers only — not athlete performance. Respond with JSON only. Never refuse.";

const QA_WEIGHTS = {
  visual_accuracy: 0.25,
  coaching_usefulness: 0.2,
  timing_accuracy: 0.25,
  speech_coverage: 0.2,
  output_compliance: 0.1
};

/**
 * Lowest applicable ceiling for analysis_quality_score from objective coverage metrics (developer QA).
 */
export function computeAnalysisQualityScoreCeiling(coverageMetrics) {
  const caps = [];
  if (coverageMetrics.speech_coverage_pct < 25) {
    caps.push(6.0);
  }
  if (coverageMetrics.max_silent_gap > 25) {
    caps.push(6.5);
  }
  if (coverageMetrics.average_silent_gap > 15) {
    caps.push(7.0);
  }
  if (coverageMetrics.overlap_count > 0) {
    caps.push(5.0);
  }
  if (coverageMetrics.segment_count < 3 && coverageMetrics.video_duration > 45) {
    caps.push(5.5);
  }
  return caps.length ? Math.min(...caps) : 10;
}

/**
 * Pass 4 — developer QA scoring (does not affect narration output).
 * Weighted sub-scores; final analysis_quality_score is capped by objective metrics.
 */
export async function scoreAnalysisQuality({
  videoDurationSeconds,
  passOneAnalysis,
  passTwoSegments,
  passThreeValidatedDetails,
  passThreeSegmentsDropped,
  passThreeSegmentsPushed,
  coverageMetrics
}) {
  const payload = {
    videoDurationSeconds,
    coverage_metrics: coverageMetrics,
    pass1_summary_and_key_moments: {
      summary: passOneAnalysis?.summary,
      key_moments: passOneAnalysis?.key_moments,
      overall_theme: passOneAnalysis?.overall_theme,
      strengths: passOneAnalysis?.strengths,
      areas_to_improve: passOneAnalysis?.areas_to_improve
    },
    pass2_final_segments: passTwoSegments,
    pass3_final_validated_timestamps_and_tts_durations: passThreeValidatedDetails,
    pass3_segments_dropped: passThreeSegmentsDropped,
    pass3_segments_pushed: passThreeSegmentsPushed
  };

  const capsBlock = `HARD SCORE CAPS — apply these before choosing analysis_quality_score (use the lowest applicable cap as the maximum allowed final score):
- If speech_coverage_pct < 25: max analysis_quality_score = 6.0
- If max_silent_gap > 25: max analysis_quality_score = 6.5
- If average_silent_gap > 15: max analysis_quality_score = 7.0
- If overlap_count > 0: max analysis_quality_score = 5.0
- If segment_count < 3 and video_duration > 45: max analysis_quality_score = 5.5

Objective coverage_metrics (already computed) are authoritative for these caps.`;

  const userText = `You are evaluating automated pipeline quality for internal QA.

${capsBlock}

Coverage metrics (objective):
${JSON.stringify(coverageMetrics, null, 2)}

Score dimensions (each integer 0–10):
- visual_accuracy: whether Pass 1 summary and key moments are coherent, specific, and plausible for sampled-roll analysis.
- coaching_usefulness: whether Pass 2 coaching segments are instructive, causal, and well chosen (pipeline output quality only).
- timing_accuracy: whether Pass 2/3 timestamps and Pass 3 adjustments are consistent with the stated video duration and spacing rules.
- speech_coverage: how well total speech time and silence patterns align with a healthy narration density given coverage_metrics (speech_coverage_pct, gaps, overlaps).
- output_compliance: whether outputs respect implied structural rules (JSON segments, word limits, retrospective tone as evident from text).

Compute the uncapped weighted average to one decimal, then ensure analysis_quality_score does not exceed the lowest applicable HARD SCORE CAP above.

Weights for the weighted average:
0.25×visual_accuracy + 0.20×coaching_usefulness + 0.25×timing_accuracy + 0.20×speech_coverage + 0.10×output_compliance

Return ONLY valid JSON in this exact shape (numbers as shown types):
{"analysis_quality_score":0.0,"visual_accuracy":0,"coaching_usefulness":0,"timing_accuracy":0,"speech_coverage":0,"output_compliance":0,"main_issues":[],"recommended_fix":""}

Full pipeline data (JSON):\n${JSON.stringify(payload, null, 2)}`;

  const messages = [
    { role: "system", content: PASS_FOUR_QA_SYSTEM_PROMPT },
    { role: "user", content: userText }
  ];

  const data = await runChatCompletion(messages);
  const rawContent = data?.choices?.[0]?.message?.content;
  if (!rawContent) {
    throw new Error("Pass 4 QA: empty response content");
  }

  const cleaned = rawContent.replace(/```json|```/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Pass 4 QA: invalid JSON (${e.message})`);
  }

  const clamp = (n) => Math.max(0, Math.min(10, Math.round(Number(n)) || 0));
  const visual_accuracy = clamp(parsed.visual_accuracy);
  const coaching_usefulness = clamp(parsed.coaching_usefulness);
  const timing_accuracy = clamp(parsed.timing_accuracy);
  const speech_coverage = clamp(
    parsed.speech_coverage !== undefined ? parsed.speech_coverage : parsed.speech_fit
  );
  const output_compliance = clamp(parsed.output_compliance);

  const uncappedWeighted =
    Math.round(
      (visual_accuracy * QA_WEIGHTS.visual_accuracy +
        coaching_usefulness * QA_WEIGHTS.coaching_usefulness +
        timing_accuracy * QA_WEIGHTS.timing_accuracy +
        speech_coverage * QA_WEIGHTS.speech_coverage +
        output_compliance * QA_WEIGHTS.output_compliance) *
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
    main_issues,
    recommended_fix
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
      console.warn(`OpenAI 429 — retry-after=${retryAfterSec}s reset-requests=${resetRequests} reset-tokens=${resetTokens} body=${body429} — waiting ${delay}ms before retry (attempt ${attempt + 1}/${MAX_RETRIES})`);
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
