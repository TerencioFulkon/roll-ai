import test from "node:test";
import assert from "node:assert/strict";
import {
  assertPass1TimelineCore,
  normalizePass1TimelineOutput,
  pass1PhaseDensityGuidance
} from "../lib/pass1Timeline.js";

test("normalizePass1TimelineOutput adds confidence moment arrays", () => {
  const t = {
    video_duration_seconds: 120,
    roll_title: "x",
    summary: "y",
    user_identity_assumption: "Gi colours visible",
    phases: [{ start: 0, end: 120 }]
  };
  normalizePass1TimelineOutput(t);
  assert.deepEqual(t.high_confidence_moments, []);
  assert.deepEqual(t.low_confidence_moments, []);
});

test("normalizePass1TimelineOutput keeps existing arrays", () => {
  const hi = [{ timestamp: 1, what_is_visible: "a", why_it_matters: "b" }];
  const lo = [{ timestamp: 2, reason: "blur" }];
  const t = {
    phases: [{ start: 0, end: 10 }],
    high_confidence_moments: hi,
    low_confidence_moments: lo
  };
  normalizePass1TimelineOutput(t);
  assert.equal(t.high_confidence_moments, hi);
  assert.equal(t.low_confidence_moments, lo);
});

test("assertPass1TimelineCore rejects empty phases", () => {
  assert.throws(
    () => assertPass1TimelineCore({ phases: [] }),
    /non-empty phases/
  );
});

test("pass1PhaseDensityGuidance matches duration bands", () => {
  assert.match(pass1PhaseDensityGuidance(180), /6-10/);
  assert.match(pass1PhaseDensityGuidance(300), /8-14/);
  assert.match(pass1PhaseDensityGuidance(600), /12-20/);
});
