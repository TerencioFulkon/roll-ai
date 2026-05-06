import test from "node:test";
import assert from "node:assert/strict";
import {
  inferPhaseIndexesFromReferencesPhase,
  phaseIndexesOverlappingTimeRange,
  repairPass4SectionVerifiedIndexes
} from "../lib/voiceoverVerificationIndexRepair.js";

test("inferPhaseIndexesFromReferencesPhase parses phase_7 as [7]", () => {
  assert.deepEqual(inferPhaseIndexesFromReferencesPhase("phase_7", 12), [7]);
  assert.deepEqual(inferPhaseIndexesFromReferencesPhase("Phase_3", 10), [3]);
});

test("phaseIndexesOverlappingTimeRange matches overlapping timeline phases", () => {
  const phases = [
    { start: 0, end: 30 },
    { start: 25, end: 60 },
    { start: 70, end: 100 }
  ];
  assert.deepEqual(phaseIndexesOverlappingTimeRange(phases, 20, 50, 3), [0, 1]);
  assert.deepEqual(phaseIndexesOverlappingTimeRange(phases, 65, 75, 3), [2]);
});

test("repairPass4SectionVerifiedIndexes copies from narrative plan linked_phase_indexes", () => {
  const r = repairPass4SectionVerifiedIndexes({
    section_id: "s2",
    rawVerified: null,
    linkedFallback: [2, 2, 4],
    references_phase: "",
    planTimeRange: null,
    timelinePhases: [],
    phaseCount: 8,
    sectionLabel: "test"
  });
  assert.deepEqual(r.verified_against_phase_indexes, [2, 4]);
  assert.equal(r.unverified_script_section, false);
  assert.equal(r.repair?.repair_method, "copied_from_plan");
});

test("repairPass4SectionVerifiedIndexes infers from references_phase when plan empty", () => {
  const r = repairPass4SectionVerifiedIndexes({
    section_id: "s6",
    rawVerified: [],
    linkedFallback: [],
    references_phase: "phase_5",
    planTimeRange: null,
    timelinePhases: [],
    phaseCount: 10,
    sectionLabel: "test"
  });
  assert.deepEqual(r.verified_against_phase_indexes, [5]);
  assert.equal(r.repair?.repair_method, "inferred_from_references_phase");
});

test("repairPass4SectionVerifiedIndexes infers from time overlap when plan and ref missing", () => {
  const phases = [
    { start: 0, end: 40 },
    { start: 35, end: 80 }
  ];
  const r = repairPass4SectionVerifiedIndexes({
    section_id: "s1",
    rawVerified: undefined,
    linkedFallback: [],
    references_phase: "",
    planTimeRange: { start: 30, end: 50 },
    timelinePhases: phases,
    phaseCount: 2,
    sectionLabel: "test"
  });
  assert.deepEqual(r.verified_against_phase_indexes, [0, 1]);
  assert.equal(r.repair?.repair_method, "inferred_from_time_overlap");
});

test("repairPass4SectionVerifiedIndexes unverified empty fallback does not throw", () => {
  const r = repairPass4SectionVerifiedIndexes({
    section_id: "sx",
    rawVerified: null,
    linkedFallback: [],
    references_phase: "",
    planTimeRange: null,
    timelinePhases: [],
    phaseCount: 5,
    sectionLabel: "test"
  });
  assert.deepEqual(r.verified_against_phase_indexes, []);
  assert.equal(r.unverified_script_section, true);
  assert.equal(r.repair?.repair_method, "unverified_empty_fallback");
  assert.ok(r.warning?.includes("unverified"));
});

test("repairPass4SectionVerifiedIndexes keeps model output when valid", () => {
  const r = repairPass4SectionVerifiedIndexes({
    section_id: "s1",
    rawVerified: [1, 3],
    linkedFallback: [9],
    references_phase: "phase_0",
    planTimeRange: { start: 0, end: 10 },
    timelinePhases: [{ start: 0, end: 5 }],
    phaseCount: 10,
    sectionLabel: "test"
  });
  assert.deepEqual(r.verified_against_phase_indexes, [1, 3]);
  assert.equal(r.repair, null);
});
