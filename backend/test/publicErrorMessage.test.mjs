import test from "node:test";
import assert from "node:assert/strict";
import {
  ANALYSIS_PROCESSING_FAILED_MESSAGE,
  SERVICE_UNAVAILABLE_MESSAGE,
  toPublicJobErrorMessage
} from "../lib/errorMessages.js";

test("OpenAI HTTP failures map to neutral analysis message", () => {
  assert.equal(
    toPublicJobErrorMessage(new Error("OpenAI request failed with status 500")),
    ANALYSIS_PROCESSING_FAILED_MESSAGE
  );
});

test("GPT JSON failure maps to neutral message", () => {
  assert.equal(
    toPublicJobErrorMessage(new Error('Visual timeline failed: GPT-4o returned non-JSON response')),
    ANALYSIS_PROCESSING_FAILED_MESSAGE
  );
});

test("Service outage message is preserved verbatim", () => {
  assert.equal(toPublicJobErrorMessage(new Error(SERVICE_UNAVAILABLE_MESSAGE)), SERVICE_UNAVAILABLE_MESSAGE);
});

test("empty error falls back to service message", () => {
  assert.equal(toPublicJobErrorMessage(new Error("")), SERVICE_UNAVAILABLE_MESSAGE);
});
