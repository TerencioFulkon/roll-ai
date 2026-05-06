const STORAGE_KEY = "rollai-completed-roll-ids";
const ACTIVE_JOB_KEY = "rollai-active-job-id";
const MAX_IDS = 200;

/**
 * @returns {string[]}
 */
export function readStoredRollJobIds() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function readActiveJobId() {
  try {
    return localStorage.getItem(ACTIVE_JOB_KEY) || "";
  } catch {
    return "";
  }
}

export function saveActiveJobId(jobId) {
  try {
    if (jobId) {
      localStorage.setItem(ACTIVE_JOB_KEY, jobId);
    } else {
      localStorage.removeItem(ACTIVE_JOB_KEY);
    }
  } catch {
    // ignore
  }
}

/**
 * Remember a job that produced a final narrated video (anonymous sessions — server lists by id).
 */
export function rememberRollJobId(jobId) {
  if (!jobId || typeof jobId !== "string") {
    return;
  }
  const ids = readStoredRollJobIds().filter((id) => id !== jobId);
  ids.unshift(jobId);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ids.slice(0, MAX_IDS)));
}

/** Remove one remembered job (e.g. backend 404 after a dev DB reset). */
export function forgetRollJobId(jobId) {
  if (!jobId || typeof jobId !== "string") {
    return;
  }
  try {
    const ids = readStoredRollJobIds().filter((id) => id !== jobId);
    if (ids.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    }
  } catch {
    /* ignore */
  }
}

/** Clear persisted active job if it matches the removed id (localStorage). */
export function clearActiveJobIdIfMatches(jobId) {
  if (!jobId) {
    return;
  }
  try {
    const cur = localStorage.getItem(ACTIVE_JOB_KEY);
    if (cur === jobId) {
      localStorage.removeItem(ACTIVE_JOB_KEY);
    }
  } catch {
    /* ignore */
  }
}

/** Wipe remembered roll IDs + active job hint in localStorage (dev / stale UI recovery). */
export function clearAllStoredRollJobIds() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(ACTIVE_JOB_KEY);
  } catch {
    /* ignore */
  }
}

const SESSION_ACTIVE_ANALYSIS_KEY = "rollai_active_analysis_job_id";

export function clearSessionActiveAnalysisIfMatches(jobId) {
  if (!jobId) {
    return;
  }
  try {
    if (
      typeof sessionStorage !== "undefined" &&
      sessionStorage.getItem(SESSION_ACTIVE_ANALYSIS_KEY) === jobId
    ) {
      sessionStorage.removeItem(SESSION_ACTIVE_ANALYSIS_KEY);
    }
  } catch {
    /* ignore */
  }
}

/** Full client hint reset: local roll list + active job keys (local + session tab). */
export function clearAllRollHintStorage() {
  clearAllStoredRollJobIds();
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(SESSION_ACTIVE_ANALYSIS_KEY);
    }
  } catch {
    /* ignore */
  }
}
