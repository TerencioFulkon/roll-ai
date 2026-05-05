/**
 * One-off backfill: generate a thumbnail for every completed roll that
 * doesn't yet have one in R2.
 *
 * Mirrors the live worker logic in `backend/jobs/processVideo.js` (frame
 * at 5s, or midpoint for clips shorter than that) so the UI sees a
 * consistent thumbnail regardless of whether the job ran through the
 * current worker or predates the thumbnail feature.
 *
 * Usage (from repo root):
 *   cd backend && node scripts/backfillThumbnails.js            # skip rolls that already have one
 *   cd backend && node scripts/backfillThumbnails.js --force    # re-generate all
 *   cd backend && node scripts/backfillThumbnails.js <jobId>    # single job
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "ffprobe-static";
import { supabase } from "../supabase.js";
import { downloadFile, uploadFile } from "../providers/r2.js";

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath.path);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const force = args.includes("--force");
const explicitJobId = args.find((a) => !a.startsWith("--"));

async function listCandidateJobs() {
  if (explicitJobId) {
    const { data, error } = await supabase
      .from("jobs")
      .select("sqlid,status,completed_at")
      .eq("sqlid", explicitJobId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error(`Job ${explicitJobId} not found`);
    if (data.status !== "complete") {
      throw new Error(`Job ${explicitJobId} is "${data.status}", not "complete"`);
    }
    return [data];
  }

  const { data, error } = await supabase
    .from("jobs")
    .select("sqlid,status,completed_at")
    .eq("status", "complete")
    .order("completed_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function thumbnailAlreadyExists(jobId) {
  // R2 via the S3 SDK doesn't expose a dedicated HEAD helper in r2.js, so we
  // probe via GetObject and treat any error as "not there". Cheap enough for
  // a one-off script; avoids duplicating work on re-runs.
  try {
    await downloadFile(`${jobId}/thumbnail.jpg`);
    return true;
  } catch {
    return false;
  }
}

function getVideoDurationSeconds(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) return reject(err);
      const duration = metadata?.format?.duration;
      if (typeof duration !== "number" || !Number.isFinite(duration)) {
        return reject(new Error("ffprobe returned no duration"));
      }
      resolve(duration);
    });
  });
}

function extractFrame(videoPath, outputImagePath, seconds) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .seekInput(Math.max(0, seconds))
      .outputOptions(["-frames:v", "1", "-q:v", "3", "-vf", "scale=640:-2"])
      .output(outputImagePath)
      .on("end", () => resolve())
      .on("error", reject)
      .run();
  });
}

async function backfillOne(jobId) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `backfill-thumb-${jobId}-`));
  const videoPath = path.join(tempDir, "output.mp4");
  const thumbnailPath = path.join(tempDir, "thumbnail.jpg");

  try {
    const videoBuffer = await downloadFile(`${jobId}/output.mp4`);
    await fs.writeFile(videoPath, videoBuffer);

    const duration = await getVideoDurationSeconds(videoPath);
    const offset = duration >= 5 ? 5 : Math.max(0, duration * 0.5);

    await extractFrame(videoPath, thumbnailPath, offset);
    const thumbBuffer = await fs.readFile(thumbnailPath);
    await uploadFile(`${jobId}/thumbnail.jpg`, thumbBuffer, "image/jpeg");

    return { ok: true, offset, bytes: thumbBuffer.length };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const jobs = await listCandidateJobs();
  console.log(
    `[backfill] found ${jobs.length} completed job(s)${force ? " (re-generating all)" : ""}`
  );

  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const job of jobs) {
    const jobId = job.sqlid;
    try {
      if (!force && (await thumbnailAlreadyExists(jobId))) {
        console.log(`[backfill] ${jobId} — skip (thumbnail already exists)`);
        skipped += 1;
        continue;
      }

      const { offset, bytes } = await backfillOne(jobId);
      console.log(
        `[backfill] ${jobId} — uploaded thumbnail (frame @ ${offset.toFixed(1)}s, ${bytes} bytes)`
      );
      generated += 1;
    } catch (error) {
      console.error(`[backfill] ${jobId} — failed:`, error.message);
      failed += 1;
    }
  }

  console.log(
    `[backfill] done. generated=${generated} skipped=${skipped} failed=${failed}`
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("[backfill] fatal:", error);
  process.exit(1);
});
