import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeVisualClaimVerification,
  VISUAL_CLAIM_VERIFICATION_SCHEMA_VERSION
} from "../lib/visualClaimVerification.js";

test("normalizeVisualClaimVerification fills missing phases with conservative defaults", () => {
  const phases = [
    { start: 0, end: 10 },
    { start: 10, end: 20 }
  ];
  const out = normalizeVisualClaimVerification(
    {
      phase_verification: [
        {
          phase_index: 0,
          time_range: { start: 0, end: 10 },
          green_shirt_role: "top",
          opponent_role: "bottom",
          dominant_player: "green_shirt",
          verified_visible_facts: ["Green shirt torso higher"],
          allowed_claims: ["Green shirt torso is slightly higher in the frame"],
          claims_to_avoid: [],
          confidence: "high"
        }
      ],
      global_warnings: ["stay conservative"]
    },
    phases
  );

  assert.equal(out.schema_version, VISUAL_CLAIM_VERIFICATION_SCHEMA_VERSION);
  assert.equal(out.phase_verification.length, 2);
  assert.deepEqual(out.phase_verification[0].allowed_claims, [
    "Green shirt torso is slightly higher in the frame"
  ]);
  assert.deepEqual(out.phase_verification[1].allowed_claims, []);
  assert.equal(out.phase_verification[1].dominant_player, "unclear");
  assert.equal(out.phase_verification[1].confidence, "low");
  assert.deepEqual(out.global_warnings, ["stay conservative"]);
});

test("normalizeVisualClaimVerification clamps invalid enums", () => {
  const phases = [{ start: 0, end: 5 }];
  const out = normalizeVisualClaimVerification(
    {
      phase_verification: [
        {
          phase_index: 0,
          green_shirt_role: "not_a_role",
          opponent_role: "top",
          dominant_player: "alien",
          verified_visible_facts: [],
          claims_to_avoid: [],
          confidence: "maybe"
        }
      ]
    },
    phases
  );
  assert.equal(out.phase_verification[0].green_shirt_role, "unclear");
  assert.equal(out.phase_verification[0].dominant_player, "unclear");
  assert.equal(out.phase_verification[0].confidence, "low");
});
