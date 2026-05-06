import { ensureRollaiSessionId } from "@/lib/session-id";
import { supabase } from "@/lib/supabase-client";

// When VITE_API_URL is set, calls go directly to that host (local dev).
// When unset, calls use relative paths and Vite's proxy forwards them to the backend.
const API_URL = import.meta.env.VITE_API_URL || "";

async function authHeaders() {
  if (!supabase) {
    return {};
  }
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchVoices() {
  const response = await fetch(`${API_URL}/api/voices`, {
    headers: { ...(await authHeaders()) }
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Unable to fetch voices");
  }

  return data;
}

export async function uploadVideo(file, { profilePhoto, participantDescriptor, voiceKey } = {}) {
  const formData = new FormData();
  formData.append("video", file);
  if (profilePhoto) {
    formData.append("profile_photo", profilePhoto);
  }
  if (participantDescriptor) {
    formData.append("participant_descriptor", participantDescriptor);
  }
  const key = voiceKey || "jordan";
  formData.append("voice_key", key);

  const sessionId = ensureRollaiSessionId();
  if (sessionId) {
    formData.append("session_id", sessionId);
  }

  const response = await fetch(`${API_URL}/api/upload`, {
    method: "POST",
    headers: { ...(await authHeaders()) },
    body: formData
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Upload failed");
  }

  return data;
}

export async function getJobStatus(jobId) {
  const response = await fetch(`${API_URL}/status/${jobId}`, {
    headers: { ...(await authHeaders()) }
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Unable to fetch status");
  }

  return data;
}

/**
 * Same as GET /status/:id but returns status code (e.g. 404) without throwing —
 * used to drop stale cached job ids after DB resets.
 *
 * @param {string} jobId
 * @returns {Promise<
 *   | { ok: true; status: number; data: Record<string, unknown> }
 *   | { ok: false; status: number; error: string }
 * >}
 */
export async function fetchJobStatusResult(jobId) {
  const response = await fetch(`${API_URL}/status/${encodeURIComponent(jobId)}`, {
    headers: { ...(await authHeaders()) }
  });
  /** @type {Record<string, unknown>} */
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    const msg = typeof data.error === "string" && data.error.trim() ? data.error : "Unable to fetch status";
    return { ok: false, status: response.status, error: msg };
  }
  return { ok: true, status: response.status, data };
}

/**
 * @param {string} sessionId
 * @returns {Promise<{ jobs: Array<{ job_id: string, status: string, created_at: string | null, completed_at: string | null }> }>}
 */
export async function fetchSessionJobs(sessionId) {
  const response = await fetch(
    `${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/jobs`,
    {
      headers: { ...(await authHeaders()) }
    }
  );
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Unable to fetch session jobs");
  }

  return data;
}

/**
 * Session jobs + onboarding funnel counters (persisted server-side).
 *
 * @param {string} sessionId
 */
export async function fetchSessionSummary(sessionId) {
  const response = await fetch(
    `${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/summary`,
    {
      headers: { ...(await authHeaders()) }
    }
  );
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Unable to fetch session summary");
  }

  return data;
}

/**
 * Update anonymous onboarding funnel flags.
 *
 * @param {string} sessionId
 * @param {{ first_watch_nudge_shown?: boolean, three_roll_watch_nudge_shown?: boolean, pending_signup_gate_job_id?: string | null }} patch
 */
export async function patchSessionFunnel(sessionId, patch = {}) {
  const response = await fetch(
    `${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/funnel`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(await authHeaders())
      },
      body: JSON.stringify(patch)
    }
  );
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Unable to save onboarding state");
  }
  return data;
}

/** Attach all anonymous jobs in `session_id` to the signed-in Supabase user. */
export async function claimSessionJobs(sessionId) {
  const headers = { ...(await authHeaders()) };
  if (!headers.Authorization) {
    throw new Error("You need to create an account first.");
  }
  const response = await fetch(`${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/claim`, {
    method: "POST",
    headers
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Could not attach your rolls to this account.");
  }
  return data;
}

/**
 * @param {string[]} jobIds Known job UUIDs (anonymous — from device storage). Ignored once Bearer auth lists server-side rolls.
 * @returns {Promise<{ rolls: Array<{ job_id: string, title: string, completed_at: string | null, created_at?: string | null, output_url: string, thumbnail_url?: string | null, duration_seconds?: number | null }> }>}
 */
export async function fetchCompletedRolls(jobIds = []) {
  const qs = jobIds.length ? `?ids=${encodeURIComponent(jobIds.join(","))}` : "";
  const response = await fetch(`${API_URL}/api/jobs${qs}`, {
    headers: { ...(await authHeaders()) }
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Unable to fetch rolls");
  }

  return data;
}
