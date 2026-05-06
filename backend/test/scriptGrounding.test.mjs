import test from "node:test";
import assert from "node:assert/strict";
import { applyVoiceoverGrounding } from "../lib/scriptGrounding.js";

test("applyVoiceoverGrounding removes banned documentary phrasing", () => {
  const vcv = {
    phase_verification: [
      {
        phase_index: 0,
        allowed_claims: ["They stand and close distance."],
        verified_visible_facts: ["Two people standing"]
      }
    ]
  };
  const sections = [
    {
      section_id: "a",
      text: "This is a pivotal moment for the athlete.",
      verified_against_phase_indexes: [0]
    }
  ];
  const r = applyVoiceoverGrounding("job-ban", sections, vcv);
  assert.match(r.unsupported_claims_removed.join(" "), /banned phrasing/);
  assert.ok(!r.sections[0].text.toLowerCase().includes("pivotal"));
});

test("applyVoiceoverGrounding drops unsubstantiated control", () => {
  const vcv = {
    phase_verification: [
      {
        phase_index: 0,
        allowed_claims: ["Both athletes move toward the mat."],
        verified_visible_facts: ["Transition toward ground"]
      }
    ]
  };
  const sections = [
    {
      section_id: "b",
      text: "Green shirt has clear top control here.",
      verified_against_phase_indexes: [0]
    }
  ];
  const r = applyVoiceoverGrounding("job-risk", sections, vcv);
  assert.ok(!r.sections[0].text.toLowerCase().includes("control"));
  assert.match(r.unsupported_claims_removed.join(" "), /unsubstantiated risk term/);
});

test("applyVoiceoverGrounding keeps control language when corpus supports it", () => {
  const vcv = {
    phase_verification: [
      {
        phase_index: 0,
        allowed_claims: [],
        verified_visible_facts: ["Green shirt has top control with chest pressure"]
      }
    ]
  };
  const sections = [
    {
      section_id: "c",
      text: "The footage shows top control and pressure.",
      verified_against_phase_indexes: [0]
    }
  ];
  const r = applyVoiceoverGrounding("job-ok", sections, vcv);
  assert.ok(r.sections[0].text.toLowerCase().includes("control"));
  assert.ok(r.sections[0].text.toLowerCase().includes("pressure"));
});

test("applyVoiceoverGrounding strips risk terms when phase corpus is empty", () => {
  const vcv = {
    phase_verification: [
      {
        phase_index: 0,
        allowed_claims: [],
        verified_visible_facts: []
      }
    ]
  };
  const sections = [
    {
      section_id: "d",
      text: "Good guard retention visible.",
      verified_against_phase_indexes: [0]
    }
  ];
  const r = applyVoiceoverGrounding("job-empty", sections, vcv);
  assert.ok(!r.sections[0].text.toLowerCase().includes("guard"));
  assert.ok(r.grounding_warnings.some((w) => w.includes("cannot be substantiated")));
});

test("applyVoiceoverGrounding strips BJJ risk terms when verified_against_phase_indexes empty", () => {
  const vcv = { phase_verification: [] };
  const sections = [{ section_id: "e", text: "Strong mount position." }];
  const r = applyVoiceoverGrounding("job-skip", sections, vcv);
  assert.ok(!r.sections[0].text.toLowerCase().includes("mount"));
  assert.ok(r.grounding_warnings.some((w) => w.includes("verified_against_phase_indexes empty")));
});
