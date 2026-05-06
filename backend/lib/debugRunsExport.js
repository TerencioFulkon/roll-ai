import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the `backend` package root (parent of `lib/`). */
export const BACKEND_ROOT = path.resolve(__dirname, "..");

/**
 * @param {string} jobId
 * @returns {string} Absolute path to `backend/debug-runs/{jobId}`.
 */
export function getDebugRunsJobDirAbsolute(jobId) {
  return path.join(BACKEND_ROOT, "debug-runs", jobId);
}

/**
 * Writes one pipeline debug JSON under `backend/debug-runs/{jobId}/`.
 * Creates `debug-runs` and the job subfolder as needed. Does not delete anything.
 *
 * @param {string} jobId
 * @param {string} fileName
 * @param {unknown} envelope Serializable object (same shape as LLM pass envelopes).
 */
export async function saveDebugRunFile(jobId, fileName, envelope) {
  const jobDir = getDebugRunsJobDirAbsolute(jobId);
  await fs.mkdir(jobDir, { recursive: true });
  const absPath = path.join(jobDir, fileName);
  await fs.writeFile(absPath, JSON.stringify(envelope, null, 2), "utf8");
  console.log(`DEBUG FILE SAVED: ${absPath}`);
}
