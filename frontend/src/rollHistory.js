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
