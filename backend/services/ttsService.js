import fs from "node:fs/promises";
import fetch from "node-fetch";
import OpenAI from "openai";

const VOICE_ENTRIES = [
  { key: "jordan", name: "Jordan", gender: "male", envVar: "ELEVENLABS_VOICE_JORDAN" },
  { key: "george", name: "George", gender: "male", envVar: "ELEVENLABS_VOICE_GEORGE" },
  { key: "daniel", name: "Daniel", gender: "male", envVar: "ELEVENLABS_VOICE_DANIEL" },
  { key: "brian", name: "Brian", gender: "male", envVar: "ELEVENLABS_VOICE_BRIAN" },
  { key: "alice", name: "Alice", gender: "female", envVar: "ELEVENLABS_VOICE_ALICE" },
  { key: "matilda", name: "Matilda", gender: "female", envVar: "ELEVENLABS_VOICE_MATILDA" },
  { key: "sarah", name: "Sarah", gender: "female", envVar: "ELEVENLABS_VOICE_SARAH" }
];

/** ElevenLabs catalogue — { key, name, gender } only */
export const VOICE_MAP = VOICE_ENTRIES.map(({ key, name, gender }) => ({ key, name, gender }));

/** OpenAI TTS — single coach voice while ElevenLabs credits are exhausted */
const OPENAI_VOICE_LIST = [{ key: "onyx", name: "Jordan", gender: "male" }];

const VOICE_BY_KEY = Object.fromEntries(VOICE_ENTRIES.map((e) => [e.key, e]));

/** Legacy uploads/jobs may still store `coach`; treat as `jordan`. */
const VOICE_KEY_ALIASES = { coach: "jordan" };

export const DEFAULT_VOICE_KEY = "jordan";

/**
 * @returns {"openai" | "elevenlabs"}
 */
function resolveTtsProvider() {
  const raw = (process.env.TTS_PROVIDER || "openai").trim().toLowerCase();
  return raw === "elevenlabs" ? "elevenlabs" : "openai";
}

export function normalizeVoiceKey(raw) {
  const k = String(raw || DEFAULT_VOICE_KEY).trim().toLowerCase();
  return VOICE_KEY_ALIASES[k] ?? k;
}

/**
 * Debug info for logs — ElevenLabs env var footprint or OpenAI stub.
 * Does not log full voice IDs.
 */
export function getTtsVoiceDebugInfo(resolvedVoiceKey) {
  if (resolveTtsProvider() === "openai") {
    return {
      resolvedKey: normalizeVoiceKey(resolvedVoiceKey),
      valid: true,
      provider: "openai",
      voice: "onyx",
      envVar: null,
      voiceIdSet: true,
      voiceIdSuffix: null
    };
  }

  const resolvedKey = normalizeVoiceKey(resolvedVoiceKey);
  const voiceEntry = VOICE_BY_KEY[resolvedKey];
  if (!voiceEntry) {
    return { resolvedKey, valid: false };
  }
  const voiceId = process.env[voiceEntry.envVar];
  return {
    resolvedKey,
    valid: true,
    envVar: voiceEntry.envVar,
    voiceIdSet: Boolean(voiceId && String(voiceId).trim().length > 0),
    voiceIdSuffix: voiceId ? String(voiceId).slice(-6) : null
  };
}

export function isValidVoiceKey(key) {
  if (typeof key !== "string") {
    return false;
  }
  const normalized = normalizeVoiceKey(key);
  if (resolveTtsProvider() === "openai") {
    /** Allow legacy job keys (e.g. jordan) and the OpenAI UI key (onyx). */
    return normalized === "onyx" || Object.prototype.hasOwnProperty.call(VOICE_BY_KEY, normalized);
  }
  return Object.prototype.hasOwnProperty.call(VOICE_BY_KEY, normalized);
}

/** Public list for GET /api/voices — { key, name, gender } only */
export function listVoicesForApi() {
  return resolveTtsProvider() === "openai" ? OPENAI_VOICE_LIST : VOICE_MAP;
}

/** ElevenLabs eleven_turbo_v2_5 — per-character estimate for usage tracking. */
export const TTS_COST_PER_CHARACTER_USD = 0.0003;

/**
 * Accumulates characters sent to the active TTS provider for a single job (all generateSpeech calls).
 */
export function createTtsUsageTracker() {
  let characterCount = 0;

  return {
    recordText(text) {
      characterCount += [...String(text)].length;
    },
    getTotals() {
      const costUsd = characterCount * TTS_COST_PER_CHARACTER_USD;
      return { characterCount, costUsd };
    }
  };
}

async function generateSpeechOpenAI(text, outputPath, usageTracker) {
  console.log(`[tts] provider=openai voice=onyx (ElevenLabs unavailable)`);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OpenAI TTS failed: OPENAI_API_KEY is not set");
  }

  if (usageTracker && typeof usageTracker.recordText === "function") {
    usageTracker.recordText(text);
  }

  const openai = new OpenAI({ apiKey });
  const response = await openai.audio.speech.create({
    model: "tts-1",
    voice: "onyx",
    input: text,
    response_format: "mp3"
  });

  const arrayBuffer = await response.arrayBuffer();
  await fs.writeFile(outputPath, Buffer.from(arrayBuffer));
}

async function generateSpeechElevenLabs(text, voiceKey, outputPath, usageTracker) {
  console.log(`[tts] provider=elevenlabs voice=${voiceKey}`);

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error("ElevenLabs TTS failed: ELEVENLABS_API_KEY is not set");
  }

  const voiceEntry = VOICE_BY_KEY[resolvedKey];
  if (!voiceEntry) {
    throw new Error(
      `ElevenLabs TTS failed: unknown voice key "${voiceKey}". Use one of: ${VOICE_ENTRIES.map((e) => e.key).join(", ")}`
    );
  }

  const voiceId = process.env[voiceEntry.envVar];
  if (!voiceId) {
    throw new Error(`ElevenLabs TTS failed: ${voiceEntry.envVar} is not set for voice "${resolvedKey}"`);
  }

  if (usageTracker && typeof usageTracker.recordText === "function") {
    usageTracker.recordText(text);
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_turbo_v2_5",
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.75,
        style: 0.3,
        use_speaker_boost: true
      }
    })
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      detail = "";
    }
    throw new Error(
      `ElevenLabs TTS failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  await fs.writeFile(outputPath, Buffer.from(arrayBuffer));
}

export async function generateSpeech(text, voiceKey, outputPath, usageTracker = null) {
  if (resolveTtsProvider() === "openai") {
    await generateSpeechOpenAI(text, outputPath, usageTracker);
  } else {
    await generateSpeechElevenLabs(text, voiceKey, outputPath, usageTracker);
  }
}
