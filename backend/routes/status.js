import express from "express";
import { validate as uuidValidate } from "uuid";
import { supabase } from "../supabase.js";
import { getSignedUrl } from "../providers/r2.js";
import { clampTitle, placeholderRollTitle } from "../lib/rollTitle.js";

const router = express.Router();

/** Signed URLs stored on the row expire after 24h; we always mint a fresh one for reads. */
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour — comfortably covers a watch session.

/**
 * Loads source video durations from pipeline `usage_logs` (anonymous + authed rolls list).
 *
 * @param {string[]} jobSqlIds
 */
async function durationSecondsByJobIdMap(jobSqlIds) {
  const unique = [...new Set(jobSqlIds)].filter(Boolean);
  if (!unique.length) {
    return new Map();
  }

  const { data, error } = await supabase
    .from("usage_logs")
    .select("job_id,video_duration_seconds")
    .in("job_id", unique);

  if (error) {
    console.warn("[status] usage_logs duration lookup failed:", error.message);
    return new Map();
  }

  const out = /** @type {Map<string, number>} */ (new Map());

  for (const row of data || []) {
    const id = row.job_id;
    if (!id || out.has(id)) continue;
    const raw = row.video_duration_seconds;
    const n = raw == null ? NaN : Number(raw);
    if (Number.isFinite(n) && n >= 0) {
      out.set(id, Math.round(n * 100) / 100);
    }
  }

  return out;
}

async function resolveOutputUrl(row) {
  // Output key is deterministic (see jobs/processVideo.js: `${jobId}/output.mp4`).
  const key = `${row.sqlid}/output.mp4`;
  try {
    return await getSignedUrl(key, SIGNED_URL_TTL_SECONDS);
  } catch (error) {
    console.error(`[status] failed to sign output URL for job ${row.sqlid}:`, error.message);
    return row.output_url || null;
  }
}

/**
 * Mints a fresh signed URL for the roll's thumbnail. The object is written by
 * the worker at `${jobId}/thumbnail.jpg`; older rolls without one will return
 * a URL that 404s — the client hides the image onError in that case.
 */
async function resolveThumbnailUrl(row) {
  const key = `${row.sqlid}/thumbnail.jpg`;
  try {
    return await getSignedUrl(key, SIGNED_URL_TTL_SECONDS);
  } catch (error) {
    console.error(`[status] failed to sign thumbnail URL for job ${row.sqlid}:`, error.message);
    return null;
  }
}

/**
 * @param {object} row
 * @param {number | undefined | null} durationSeconds pipeline source duration from `usage_logs`
 */
async function mapJobToRoll(row, durationSeconds) {
  const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  let title = "";

  const storedDisplay = clampTitle(meta.roll_display_title ?? "");
  if (storedDisplay) title = storedDisplay;
  else if (typeof meta.file_name === "string" && meta.file_name.trim()) {
    // Jobs completed before RollAI stored AI titles — show curated stubs instead of raw filenames.
    title = placeholderRollTitle(row.sqlid);
  } else {
    title = "Narrated roll";
  }

  const [output_url, thumbnail_url] = await Promise.all([
    resolveOutputUrl(row),
    resolveThumbnailUrl(row)
  ]);

  let duration_seconds = durationSeconds != null ? Number(durationSeconds) : null;
  if (!Number.isFinite(duration_seconds)) {
    duration_seconds = null;
  }

  return {
    job_id: row.sqlid,
    completed_at: row.completed_at,
    created_at: row.created_at,
    output_url,
    thumbnail_url,
    duration_seconds,
    title
  };
}

/**
 * Lists completed jobs with a final video.
 * — Authenticated: all complete rolls for `req.user`.
 * — Anonymous: pass known job UUIDs via `?ids=` (from device storage); ownership is implicit (UUID secrecy).
 */
router.get("/", async (req, res) => {
  try {
    if (req.user?.id) {
      const { data, error } = await supabase
        .from("jobs")
        .select("sqlid,completed_at,created_at,output_url,metadata")
        .eq("user_id", req.user.id)
        .eq("status", "complete")
        .not("output_url", "is", null)
        .order("completed_at", { ascending: false });

      if (error) {
        throw new Error(error.message);
      }

      const rowsList = data || [];
      const durationByJob = await durationSecondsByJobIdMap(rowsList.map((r) => r.sqlid));

      const rolls = await Promise.all(
        rowsList.map((row) => mapJobToRoll(row, durationByJob.get(row.sqlid)))
      );
      return res.json({ rolls });
    }

    const raw = req.query.ids ?? req.query.job_ids ?? "";
    const tokens = String(raw)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 100);

    const validIds = tokens.filter((id) => uuidValidate(id));

    if (validIds.length === 0) {
      return res.json({ rolls: [] });
    }

    const { data, error } = await supabase
      .from("jobs")
      .select("sqlid,completed_at,created_at,output_url,metadata")
      .in("sqlid", validIds)
      .eq("status", "complete")
      .not("output_url", "is", null);

    if (error) {
      throw new Error(error.message);
    }

    const byId = new Map((data || []).map((row) => [row.sqlid, row]));
    const ordered = validIds.map((id) => byId.get(id)).filter(Boolean);

    const durationByJob = await durationSecondsByJobIdMap(ordered.map((row) => row.sqlid));

    const rolls = await Promise.all(
      ordered.map((row) => mapJobToRoll(row, durationByJob.get(row.sqlid)))
    );

    return res.json({ rolls });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to list rolls." });
  }
});

/**
 * MVP: any caller who knows the job UUID can read status (including output_url).
 * Revisit with RLS / ownership checks when auth is enforced on reads.
 */
router.get("/:job_id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("jobs")
      .select("sqlid,status,progress,output_url,error_message")
      .eq("sqlid", req.params.job_id)
      .single();

    if (error) {
      return res.status(404).json({ error: "Job not found." });
    }

    const [output_url, thumbnail_url] =
      data.status === "complete"
        ? await Promise.all([resolveOutputUrl(data), resolveThumbnailUrl(data)])
        : [data.output_url, null];

    return res.json({
      job_id: data.sqlid,
      status: data.status,
      progress: data.progress,
      output_url,
      thumbnail_url,
      error_message: data.error_message
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to fetch status." });
  }
});

export default router;
