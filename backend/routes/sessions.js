import express from "express";
import { validate as uuidValidate } from "uuid";
import { supabase } from "../supabase.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

function normalizeSessionId(raw) {
  const sessionId = String(raw || "").trim();
  if (!sessionId || !uuidValidate(sessionId)) {
    return null;
  }
  return sessionId;
}

/**
 * GET /api/sessions/:sessionId/jobs
 * Anonymous session job list (minimal fields).
 */
router.get("/:sessionId/jobs", async (req, res) => {
  try {
    const sessionId = normalizeSessionId(req.params.sessionId);
    if (!sessionId) {
      return res.status(400).json({ error: "Invalid session id." });
    }

    const { data, error } = await supabase
      .from("jobs")
      .select("sqlid,status,created_at,completed_at")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(error.message);
    }

    const jobs = (data || []).map((row) => ({
      job_id: row.sqlid,
      status: row.status,
      created_at: row.created_at,
      completed_at: row.completed_at
    }));

    return res.json({ jobs });
  } catch (err) {
    console.error("[sessions]", err);
    return res.status(500).json({ error: err.message || "Failed to list session jobs." });
  }
});

/**
 * GET /api/sessions/:sessionId/summary
 * Jobs for the session plus completion count and persisted funnel flags.
 */
router.get("/:sessionId/summary", async (req, res) => {
  try {
    const sessionId = normalizeSessionId(req.params.sessionId);
    if (!sessionId) {
      return res.status(400).json({ error: "Invalid session id." });
    }

    const { data: rows, error } = await supabase
      .from("jobs")
      .select("sqlid,status,created_at,completed_at")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(error.message);
    }

    const list = rows || [];
    const jobs = list.map((row) => ({
      job_id: row.sqlid,
      status: row.status,
      created_at: row.created_at,
      completed_at: row.completed_at
    }));

    const completed_count = list.filter((row) => row.status === "complete").length;

    const { data: funnelRow, error: funnelErr } = await supabase
      .from("anonymous_session_funnel")
      .select("first_watch_nudge_shown_at,three_roll_watch_nudge_shown_at,pending_signup_gate_job_id,updated_at")
      .eq("session_id", sessionId)
      .maybeSingle();

    if (funnelErr) {
      throw new Error(funnelErr.message);
    }

    const funnel = {
      first_watch_nudge_shown: Boolean(funnelRow?.first_watch_nudge_shown_at),
      three_roll_watch_nudge_shown: Boolean(funnelRow?.three_roll_watch_nudge_shown_at),
      pending_signup_gate_job_id: funnelRow?.pending_signup_gate_job_id ?? null,
      updated_at: funnelRow?.updated_at ?? null
    };

    return res.json({ jobs, completed_count, funnel });
  } catch (err) {
    console.error("[sessions/summary]", err);
    return res.status(500).json({ error: err.message || "Failed to load session summary." });
  }
});

/**
 * PATCH /api/sessions/:sessionId/funnel
 * Persists anonymous onboarding flags (server — survives refresh / new device with same session UUID).
 *
 * Body JSON (all optional):
 * - first_watch_nudge_shown: boolean — when true, stamps `first_watch_nudge_shown_at` once
 * - three_roll_watch_nudge_shown: boolean — when true, stamps `three_roll_watch_nudge_shown_at` once
 * - pending_signup_gate_job_id: string uuid | null — second-analysis signup gate
 */
router.patch("/:sessionId/funnel", async (req, res) => {
  try {
    const sessionId = normalizeSessionId(req.params.sessionId);
    if (!sessionId) {
      return res.status(400).json({ error: "Invalid session id." });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const stampNudge = body.first_watch_nudge_shown === true;
    const stampThreeRollNudge = body.three_roll_watch_nudge_shown === true;
    const pendingRaw = body.pending_signup_gate_job_id;
    const hasPendingKey = Object.prototype.hasOwnProperty.call(body, "pending_signup_gate_job_id");

    if (pendingRaw != null && pendingRaw !== "" && !uuidValidate(String(pendingRaw))) {
      return res.status(400).json({ error: "Invalid pending_signup_gate_job_id." });
    }

    const nowIso = new Date().toISOString();

    const { data: existing, error: readErr } = await supabase
      .from("anonymous_session_funnel")
      .select("first_watch_nudge_shown_at,pending_signup_gate_job_id")
      .eq("session_id", sessionId)
      .maybeSingle();

    if (readErr) {
      throw new Error(readErr.message);
    }

    /** @type {{ session_id: string, first_watch_nudge_shown_at: string | null, three_roll_watch_nudge_shown_at: string | null, pending_signup_gate_job_id: string | null, updated_at: string }} */
    const nextRow = {
      session_id: sessionId,
      first_watch_nudge_shown_at: existing?.first_watch_nudge_shown_at ?? null,
      three_roll_watch_nudge_shown_at: existing?.three_roll_watch_nudge_shown_at ?? null,
      pending_signup_gate_job_id: existing?.pending_signup_gate_job_id ?? null,
      updated_at: nowIso
    };

    if (stampNudge && !nextRow.first_watch_nudge_shown_at) {
      nextRow.first_watch_nudge_shown_at = nowIso;
    }

    if (stampThreeRollNudge && !nextRow.three_roll_watch_nudge_shown_at) {
      nextRow.three_roll_watch_nudge_shown_at = nowIso;
    }

    if (hasPendingKey) {
      nextRow.pending_signup_gate_job_id =
        pendingRaw == null || pendingRaw === "" ? null : String(pendingRaw);
    }

    if (nextRow.pending_signup_gate_job_id) {
      const jid = nextRow.pending_signup_gate_job_id;
      const { data: jobBelongs, error: jobBelongsErr } = await supabase
        .from("jobs")
        .select("sqlid")
        .eq("sqlid", jid)
        .eq("session_id", sessionId)
        .maybeSingle();

      if (jobBelongsErr) {
        throw new Error(jobBelongsErr.message);
      }
      if (!jobBelongs) {
        return res.status(400).json({ error: "Job does not belong to this session." });
      }
    }

    const { error: upsertErr } = await supabase.from("anonymous_session_funnel").upsert(nextRow, {
      onConflict: "session_id"
    });

    if (upsertErr) {
      throw new Error(upsertErr.message);
    }

    return res.json({
      funnel: {
        first_watch_nudge_shown: Boolean(nextRow.first_watch_nudge_shown_at),
        three_roll_watch_nudge_shown: Boolean(nextRow.three_roll_watch_nudge_shown_at),
        pending_signup_gate_job_id: nextRow.pending_signup_gate_job_id,
        updated_at: nowIso
      }
    });
  } catch (err) {
    console.error("[sessions/funnel]", err);
    return res.status(500).json({ error: err.message || "Failed to update funnel." });
  }
});

/**
 * POST /api/sessions/:sessionId/claim
 * Attach every anonymous job in this browser session to the authenticated user (Bearer JWT).
 */
router.post("/:sessionId/claim", requireAuth, async (req, res) => {
  try {
    const sessionId = normalizeSessionId(req.params.sessionId);
    if (!sessionId) {
      return res.status(400).json({ error: "Invalid session id." });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorised." });
    }

    const { data: updatedJobs, error: updateErr } = await supabase
      .from("jobs")
      .update({
        user_id: userId,
        updated_at: new Date().toISOString()
      })
      .eq("session_id", sessionId)
      .is("user_id", null)
      .select("sqlid");

    if (updateErr) {
      throw new Error(updateErr.message);
    }

    await supabase.from("anonymous_session_funnel").delete().eq("session_id", sessionId);

    const count = updatedJobs?.length ?? 0;
    return res.json({ claimed_job_count: count });
  } catch (err) {
    console.error("[sessions/claim]", err);
    return res.status(500).json({ error: err.message || "Failed to claim session jobs." });
  }
});

export default router;
