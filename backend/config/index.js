import dotenv from "dotenv";
dotenv.config();

function readEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const FRAMES_PER_SECOND = 4;
export const MAX_VIDEO_DURATION_SECONDS = 600;
export const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024;

/** Stitched output video speed (1 = realtime). Override with VIDEO_PLAYBACK_SPEED env if needed. */
const parsedPlayback = Number(process.env.VIDEO_PLAYBACK_SPEED);
export const VIDEO_PLAYBACK_SPEED =
  Number.isFinite(parsedPlayback) && parsedPlayback > 0 ? parsedPlayback : 1;

export const OPENAI_MODEL = "gpt-4o";

const parsedGeminiMax = Number(process.env.GEMINI_MAX_VIDEO_DURATION_SECONDS);
export const GEMINI_MAX_VIDEO_DURATION_SECONDS =
  Number.isFinite(parsedGeminiMax) && parsedGeminiMax > 0 ? parsedGeminiMax : 600;

/** Optional — Pass 1 video timeline experiments. */
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

/** `openai` | `gemini` — unset defaults to OpenAI at routing layer. */
export const VISION_PROVIDER = (process.env.VISION_PROVIDER || "").trim().toLowerCase();

export const GEMINI_VISION_MODEL = (
  process.env.GEMINI_VISION_MODEL || "gemini-2.0-flash"
).trim();

export const config = {
  PORT: Number(process.env.PORT || 3001),
  OPENAI_API_KEY: readEnv("OPENAI_API_KEY"),
  GEMINI_API_KEY,
  VISION_PROVIDER,
  GEMINI_MAX_VIDEO_DURATION_SECONDS,
  GEMINI_VISION_MODEL,
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || "",
  SUPABASE_URL: readEnv("SUPABASE_URL"),
  SUPABASE_SECRET_KEY: readEnv("SUPABASE_SECRET_KEY"),
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID || "",
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID || "",
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY || "",
  R2_BUCKET_NAME: process.env.R2_BUCKET_NAME || "",
  R2_PUBLIC_URL: process.env.R2_PUBLIC_URL || "",
  FRAMES_PER_SECOND,
  MAX_VIDEO_DURATION_SECONDS,
  MAX_FILE_SIZE_BYTES,
  OPENAI_MODEL,
  VIDEO_PLAYBACK_SPEED
};
