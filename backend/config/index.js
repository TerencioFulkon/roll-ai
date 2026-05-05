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
export const VIDEO_PLAYBACK_SPEED = 0.5;
export const OPENAI_MODEL = "gpt-4o";

export const config = {
  PORT: Number(process.env.PORT || 3001),
  OPENAI_API_KEY: readEnv("OPENAI_API_KEY"),
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
