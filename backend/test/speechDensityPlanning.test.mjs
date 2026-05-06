import test from "node:test";
import assert from "node:assert/strict";
import {
  applySpeechDensityNormalizationToPlan,
  repairSectionPlanTimeline,
  sliceTimeSegments,
  splitSectionRowOverMaxLength,
  targetWordsFromSectionDuration
} from "../lib/speechDensityPlanning.js";

test("targetWordsFromSectionDuration uses floor(dur*2.1) with minimums", () => {
  assert.equal(targetWordsFromSectionDuration(30), Math.max(20, Math.floor(30 * 2.1)));
  assert.equal(targetWordsFromSectionDuration(5), Math.max(12, Math.floor(5 * 2.1)));
});

test("repairSectionPlanTimeline removes overlap by shifting non-summary sections", () => {
  const out = repairSectionPlanTimeline(
    [
      {
        section_id: "s1",
        label: "a",
        story_role: "rolling_analysis",
        narrative_priority: "medium",
        coaching_focus: "c",
        linked_phase_indexes: [0],
        approximate_time_range: { start: 0, end: 50 },
        target_words: 0
      },
      {
        section_id: "s2",
        label: "b",
        story_role: "rolling_analysis",
        narrative_priority: "medium",
        coaching_focus: "d",
        linked_phase_indexes: [1],
        approximate_time_range: { start: 40, end: 100 },
        target_words: 0
      }
    ],
    100
  );
  assert.equal(out.length, 2);
  assert.ok(out[1].approximate_time_range.start >= out[0].approximate_time_range.end - 1e-6);
});

test("repairSectionPlanTimeline treats coaching_intent summary_takeaway like summary story_role for overlap", () => {
  const out = repairSectionPlanTimeline(
    [
      {
        section_id: "s1",
        label: "a",
        story_role: "rolling_analysis",
        coaching_intent: "tactical_lesson",
        narrative_priority: "medium",
        coaching_focus: "c",
        linked_phase_indexes: [0],
        approximate_time_range: { start: 0, end: 40 },
        target_words: 0
      },
      {
        section_id: "s2",
        label: "b",
        story_role: "rolling_analysis",
        coaching_intent: "summary_takeaway",
        narrative_priority: "medium",
        coaching_focus: "d",
        linked_phase_indexes: [1],
        approximate_time_range: { start: 30, end: 90 },
        target_words: 0
      }
    ],
    100
  );
  assert.equal(out.length, 2);
  const lastTakeaway = out[out.length - 1];
  assert.equal(String(lastTakeaway?.coaching_intent), "summary_takeaway");
  assert.ok(
    Math.abs(Number(lastTakeaway?.approximate_time_range.start) - 40) < 1e-3,
    "summary should chain after prior section end"
  );
});

test("sliceTimeSegments splits oversized windows", () => {
  const segs = sliceTimeSegments(0, 90);
  assert.ok(segs.length >= 3);
  for (const [a, b] of segs) {
    assert.ok(b - a <= 40 || segs.length > 2);
    assert.ok(b > a);
  }
});

test("splitSectionRowOverMaxLength expands 84s block into ≤40s chunks with suffix labels", () => {
  const { rows } = splitSectionRowOverMaxLength(
    {
      section_id: "s3",
      label: "Leg Engagement",
      story_role: "main_coaching_point",
      narrative_priority: "high",
      coaching_focus: "Discuss legs",
      linked_phase_indexes: [3, 4],
      approximate_time_range: { start: 28.5, end: 112.75 },
      target_words: 999
    },
    170.203
  );
  assert.ok(rows.length >= 3);
  for (const r of rows) {
    const dur =
      Number(r.approximate_time_range.end) - Number(r.approximate_time_range.start);
    assert.ok(dur <= 40.01, `segment ${dur}s too long`);
  }
  assert.match(rows[0].section_id, /^s3[a-z]/);
});

test("applySpeechDensityNormalizationToPlan rejects chronic under-density", () => {
  /** Very short fictional clip so expansion can't fix */
  assert.throws(() => {
    applySpeechDensityNormalizationToPlan(
      {
        narrative_style: "technical_breakdown",
        primary_arc: "x",
        secondary_arc: "",
        energy_curve: ["a", "b", "c", "d"],
        section_plan: [
          {
            section_id: "s1",
            label: "A",
            story_role: "intro_context",
            narrative_priority: "low",
            coaching_focus: "c",
            linked_phase_indexes: [0],
            approximate_time_range: { start: 0, end: 1 }
          },
          {
            section_id: "s2",
            label: "B",
            story_role: "rolling_analysis",
            narrative_priority: "medium",
            coaching_focus: "d",
            linked_phase_indexes: [0],
            approximate_time_range: { start: 1, end: 2 }
          }
        ]
      },
      120,
      { phases: [] },
      {},
      { phase_verification: [] }
    );
  }, /Speech density validation failed/i);
});
