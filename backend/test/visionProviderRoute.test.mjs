import test from "node:test";
import assert from "node:assert/strict";
import { explainGeminiUnavailableForLogs, resolveVisionTimelineRoute } from "../lib/visionProviderRoute.js";

test("VISION_PROVIDER=gemini and GEMINI_API_KEY present uses Gemini path", () => {
  const r = resolveVisionTimelineRoute({
    jobVisionProvider: undefined,
    envVisionProvider: "gemini",
    geminiApiKey: "AIzaFakeKeyForTestOnly",
    videoDurationSeconds: 120,
    geminiMaxVideoDurationSeconds: 600
  });
  assert.equal(r.configuredProvider, "gemini");
  assert.equal(r.useGemini, true);
  assert.equal(r.providerSource, "env");
});

test("VISION_PROVIDER=gemini without key falls back route to OpenAI", () => {
  const r = resolveVisionTimelineRoute({
    jobVisionProvider: undefined,
    envVisionProvider: "gemini",
    geminiApiKey: "",
    videoDurationSeconds: 120,
    geminiMaxVideoDurationSeconds: 600
  });
  assert.equal(r.configuredProvider, "gemini");
  assert.equal(r.useGemini, false);
  assert.equal(r.blockReason, "missing_gemini_api_key");
});

test("VISION_PROVIDER unset defaults to OpenAI routing", () => {
  const r = resolveVisionTimelineRoute({
    jobVisionProvider: undefined,
    envVisionProvider: "",
    geminiApiKey: "fake",
    videoDurationSeconds: 60,
    geminiMaxVideoDurationSeconds: 600
  });
  assert.equal(r.configuredProvider, "openai");
  assert.equal(r.useGemini, false);
  assert.equal(r.providerSource, "default");
});

test("Job-level vision_provider=gemini overrides env var", () => {
  const r = resolveVisionTimelineRoute({
    jobVisionProvider: "gemini",
    envVisionProvider: "openai",
    geminiApiKey: "x",
    videoDurationSeconds: 30,
    geminiMaxVideoDurationSeconds: 600
  });
  assert.equal(r.providerSource, "job_override");
  assert.equal(r.useGemini, true);
});

test("Video duration over GEMINI_MAX_VIDEO_DURATION_SECONDS disables Gemini", () => {
  const r = resolveVisionTimelineRoute({
    jobVisionProvider: "gemini",
    envVisionProvider: undefined,
    geminiApiKey: "x",
    videoDurationSeconds: 700,
    geminiMaxVideoDurationSeconds: 600
  });
  assert.equal(r.useGemini, false);
  assert.equal(r.blockReason, "duration_exceeds_gemini_limit");
});

test("explainGeminiUnavailableForLogs describes missing key", () => {
  const route = resolveVisionTimelineRoute({
    jobVisionProvider: "gemini",
    envVisionProvider: "",
    geminiApiKey: "",
    videoDurationSeconds: 60,
    geminiMaxVideoDurationSeconds: 600
  });
  const msg = explainGeminiUnavailableForLogs(route, 60, 600);
  assert.ok(msg?.includes("GEMINI_API_KEY"));
});

test("explainGeminiUnavailableForLogs describes duration cap", () => {
  const route = resolveVisionTimelineRoute({
    jobVisionProvider: "gemini",
    geminiApiKey: "x",
    videoDurationSeconds: 700,
    geminiMaxVideoDurationSeconds: 600
  });
  const msg = explainGeminiUnavailableForLogs(route, 700, 600);
  assert.ok(msg?.includes("exceeds"));
});
