import { config } from "../config/index.js";

/** One-shot startup diagnostics for Pass 1 vision routing (never logs secrets). */
export function logVisionProviderBootstrap(role) {
  const rawEnv = String(process.env.VISION_PROVIDER ?? "").trim();
  const lower = rawEnv.toLowerCase();
  let interpreted;
  if (!rawEnv) {
    interpreted = "openai — VISION_PROVIDER unset (routing default)";
  } else if (lower === "gemini" || lower === "openai") {
    interpreted = `${lower} — from env`;
  } else {
    interpreted = `ignored invalid VISION_PROVIDER="${rawEnv}" — treating as openai`;
  }

  console.log(`[${role}] VISION ROUTING CONFIG (startup)`);
  console.log(`[${role}]   VISION_PROVIDER env raw: "${rawEnv || "(empty)"}"`);
  console.log(`[${role}]   interpreted: ${interpreted}`);
  console.log(`[${role}]   GEMINI_API_KEY: ${config.GEMINI_API_KEY?.trim() ? "present" : "absent"}`);
  console.log(
    `[${role}]   GEMINI_MAX_VIDEO_DURATION_SECONDS: ${config.GEMINI_MAX_VIDEO_DURATION_SECONDS}s`
  );
  console.log(`[${role}]   GEMINI_VISION_MODEL: ${config.GEMINI_VISION_MODEL}`);
  console.log(
    `[${role}]   Pass 1 uses Gemini only when routing is gemini, GEMINI_API_KEY is present, and clip duration ≤ cap (evaluated per job)`
  );
}
