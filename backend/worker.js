import { randomUUID } from "node:crypto";
import "./env.js";
import { supabase } from "./supabase.js";
import { processVideo } from "./jobs/processVideo.js";

const POLL_INTERVAL_MS = 5000;

/**
 * Short, stable identifier for this worker instance — lets multiple workers
 * be distinguished in logs and makes race conditions easier to diagnose.
 */
const WORKER_ID = randomUUID().slice(0, 8);

let isProcessing = false;

/**
 * Atomically claim the oldest pending job by flipping its status from
 * "pending" → "processing" in a single conditional UPDATE.
 *
 * Postgres row-level locks guarantee only one live worker wins each claim.
 */
async function claimNextQueuedJob() {
  const { data: candidates, error: selectError } = await supabase
    .from("jobs")
    .select("sqlid")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1);

  if (selectError) {
    console.error(`[worker ${WORKER_ID}] poll error:`, selectError.message);
    return null;
  }

  const candidate = candidates?.[0];
  if (!candidate) {
    return null;
  }

  const { data: claimed, error: claimError } = await supabase
    .from("jobs")
    .update({
      status: "processing",
      started_at: new Date().toISOString(),
      progress: `Claimed by worker ${WORKER_ID}`
    })
    .eq("sqlid", candidate.sqlid)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();

  if (claimError) {
    console.error(`[worker ${WORKER_ID}] claim error:`, claimError.message);
    return null;
  }

  return claimed;
}

async function poll() {
  if (isProcessing) {
    return;
  }

  const job = await claimNextQueuedJob();
  if (!job) {
    return;
  }

  isProcessing = true;
  console.log(`[worker ${WORKER_ID}] claimed job ${job.sqlid}`);
  try {
    await processVideo(job);
  } catch (error) {
    console.error(`[worker ${WORKER_ID}] failed processing job ${job.sqlid}:`, error.message);
  } finally {
    isProcessing = false;
  }
}

async function runWorkerLoop() {
  console.log(`[worker ${WORKER_ID}] starting; polling every ${POLL_INTERVAL_MS}ms`);
  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

runWorkerLoop().catch((error) => {
  console.error(`[worker ${WORKER_ID}] crashed:`, error.message);
  process.exit(1);
});
