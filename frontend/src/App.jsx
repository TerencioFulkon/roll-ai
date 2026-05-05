import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Plus } from "lucide-react";
import {
  fetchCompletedRolls,
  fetchSessionJobs,
  fetchSessionSummary,
  getJobStatus,
  patchSessionFunnel,
  uploadVideo
} from "./api";
import { rememberRollJobId, readStoredRollJobIds } from "./rollHistory";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { RollsTabJobsList } from "@/components/rolls-tab-jobs-list";
import { RollsTabSkeleton } from "@/components/rolls-tab-skeleton";
import { ThemeToggle } from "@/components/theme-toggle";
import { TabBar } from "@/components/tab-bar";
import { EmptyState } from "@/components/empty-state";
import { GymIllustration, HomeIllustration, ProgressIllustration } from "@/components/empty-state-illustrations";
import { AnalyzingHomeView } from "@/components/analyzing-home-view";
import { FirstRollWatchNudgeSheet } from "@/components/first-roll-watch-nudge-sheet";
import { SecondAnalysisSignupGate } from "@/components/second-analysis-signup-gate";
import { RollDetail } from "@/components/roll-detail";
import { useAuth } from "@/hooks/use-auth";
import { useVideoThumbnail } from "@/hooks/use-video-thumbnail";
import { ensureRollaiSessionId, getRollaiSessionId } from "@/lib/session-id";

/** Content sits flush on `bg-background` (sections + gap) — no bordered panel wrappers. */

const DEFAULT_VOICE_KEY = "jordan";

/**
 * Outage copy surfaced when the backend, worker, or any upstream provider
 * (ElevenLabs, OpenAI, R2, Supabase) fails. Keep in sync with
 * `backend/lib/errorMessages.js`. Actionable validation copy (wrong format,
 * file too large, missing descriptor) is *not* replaced with this — only
 * true "we're down" situations.
 */
const SERVICE_UNAVAILABLE_MESSAGE =
  "RollAI is currently unavailable, but we're working hard to get it back online. Please try again later.";

const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024;
const MAX_VIDEO_DURATION_SECONDS = 600;
const ALLOWED_VIDEO_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska"
];

const ALLOWED_VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".mkv"];

/**
 * Mobile pickers often yield an empty `type` or `application/octet-stream` even for valid video.
 * @param {File} file
 */
function isAllowedVideoFile(file) {
  if (ALLOWED_VIDEO_TYPES.includes(file.type)) return true;
  if (file.type && file.type !== "application/octet-stream") return false;
  const name = String(file.name || "").toLowerCase();
  return ALLOWED_VIDEO_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** Persisted so we resume polling after refresh / navigation when the worker still has an in-flight job. */
const ACTIVE_ANALYSIS_JOB_ID_KEY = "rollai_active_analysis_job_id";

/** Persist first-watch nudge client-side when there is no anonymous session id (parity with server funnel). */
const FIRST_WATCH_NUDGE_LOCAL_KEY = "rollai_first_watch_nudge_shown_local";

function readLocalFirstWatchNudgeShown() {
  try {
    return typeof sessionStorage !== "undefined" && sessionStorage.getItem(FIRST_WATCH_NUDGE_LOCAL_KEY) === "1";
  } catch {
    return false;
  }
}

function writeLocalFirstWatchNudgeShown() {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(FIRST_WATCH_NUDGE_LOCAL_KEY, "1");
    }
  } catch {
    /* private mode / quota */
  }
}

/** Persist three-roll nudge when there is no session id (parity with server funnel). */
const THREE_ROLL_NUDGE_LOCAL_KEY = "rollai_three_roll_watch_nudge_shown_local";

function readLocalThreeRollNudgeShown() {
  try {
    return typeof sessionStorage !== "undefined" && sessionStorage.getItem(THREE_ROLL_NUDGE_LOCAL_KEY) === "1";
  } catch {
    return false;
  }
}

function writeLocalThreeRollNudgeShown() {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(THREE_ROLL_NUDGE_LOCAL_KEY, "1");
    }
  } catch {
    /* private mode / quota */
  }
}

/** @param {string} value */
function looksLikeUuid(value) {
  const v = String(value || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** Max orphan lookups per rolls refresh — avoids noisy status polling. */
const MAX_STORED_JOB_STATUS_LOOKUP = 48;

/**
 * Merge jobs remembered on-device into the session job list when the API list
 * omits them (e.g. upload without session_id linkage or storage/session drift on mobile).
 *
 * @param {Array<{ job_id: string, status: string, created_at: string | null, completed_at: string | null }>} serverList
 */
async function augmentSessionJobsWithStoredRolls(serverList) {
  const storedIds = readStoredRollJobIds().filter(looksLikeUuid);
  if (storedIds.length === 0) return serverList;

  const known = new Set(serverList.map((j) => j.job_id));
  const orphans = storedIds.filter((id) => !known.has(id)).slice(0, MAX_STORED_JOB_STATUS_LOOKUP);
  if (orphans.length === 0) return serverList;

  const rows = await Promise.all(
    orphans.map(async (id) => {
      try {
        const data = await getJobStatus(id);
        const st = typeof data.status === "string" ? data.status : "pending";
        const nowIso = new Date().toISOString();
        return {
          job_id: id,
          status: st,
          created_at: null,
          completed_at: st === "complete" || st === "failed" ? nowIso : null
        };
      } catch {
        const nowIso = new Date().toISOString();
        return {
          job_id: id,
          status: "failed",
          created_at: null,
          completed_at: nowIso
        };
      }
    })
  );

  const seen = new Set();
  /** @type {typeof serverList} */
  const out = [];
  for (const row of [...rows, ...serverList]) {
    if (seen.has(row.job_id)) continue;
    seen.add(row.job_id);
    out.push(row);
  }
  return out;
}

/**
 * Merged session jobs (`/sessions/:id/jobs` + on-device orphans) — same basis as Rolls list.
 * Session summary `completed_count` can be lower when rows lack `session_id`.
 *
 * @param {string} sid
 */
async function fetchMergedSessionJobsForFunnel(sid) {
  try {
    const { jobs } = await fetchSessionJobs(sid);
    const serverList = Array.isArray(jobs) ? jobs : [];
    return await augmentSessionJobsWithStoredRolls(serverList);
  } catch {
    return await augmentSessionJobsWithStoredRolls([]);
  }
}

/**
 * Spreads Rolls across Today / Yesterday / prior calendar months (`import.meta.env.DEV`
 * only) so section headers render without seeding backend data.
 *
 * @param {Array<object>} rolls
 */
function withSyntheticRollTimestampsForUiDev(rolls) {
  if (!import.meta.env.DEV || rolls.length === 0) {
    return rolls;
  }

  const now = new Date();

  const todayAt = /** @param {number} h @param {number} mi @returns {string} */ (h, mi) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi, 0, 0);
    return d.toISOString();
  };

  const daysBackAt = (days, h, mi) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, h, mi, 0, 0);
    return d.toISOString();
  };

  const monthsBackAt = (monthsBack, preferredDom, h, mi) => {
    const d = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1, h, mi, 0, 0);
    const lastDom = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(preferredDom, lastDom));
    return d.toISOString();
  };

  /** Order matches API sort (newest first): Today → Yesterday → earlier months descending. */
  const scheduleIso = [
    todayAt(9, 5),
    todayAt(21, 40),
    daysBackAt(1, 11, 25),
    daysBackAt(1, 7, 0),
    monthsBackAt(2, 16, 15, 20),
    monthsBackAt(2, 5, 10, 45),
    monthsBackAt(3, 28, 18, 0),
    monthsBackAt(4, 11, 12, 30),
    monthsBackAt(5, 3, 9, 15),
    monthsBackAt(6, 20, 20, 0)
  ];

  return rolls.map((roll, index) => {
    const iso = scheduleIso[index % scheduleIso.length];
    return { ...roll, completed_at: iso, created_at: iso };
  });
}

/** Seconds shown on Rolls thumbnails when backend has no duration yet (DEV only). */
const UI_DEV_DURATION_SEC_FALLBACK = [292, 310, 252, 401, 198, 446, 333, 177, 512, 224];

/**
 * @param {Array<object>} rolls
 */
function withSyntheticRollDurationsForUiDev(rolls) {
  if (!import.meta.env.DEV || rolls.length === 0) {
    return rolls;
  }

  return rolls.map((roll, index) => {
    const raw = roll.duration_seconds;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return roll;
    }
    return {
      ...roll,
      duration_seconds: UI_DEV_DURATION_SEC_FALLBACK[index % UI_DEV_DURATION_SEC_FALLBACK.length]
    };
  });
}

/** @param {object[]} rolls */
function finalizeRollListForUiDev(rolls) {
  return withSyntheticRollDurationsForUiDev(withSyntheticRollTimestampsForUiDev(rolls));
}

/** Shared style for the full-width primary button used in the upload onboarding steps. */
const stepPrimaryButtonClass =
  "h-auto w-full rounded-lg bg-primary px-6 py-3 text-base font-semibold text-primary-foreground shadow-sm transition-all duration-300 hover:scale-[1.02] hover:bg-primary/92 hover:shadow-md focus-visible:ring-1 focus-visible:ring-primary/25 disabled:opacity-50 disabled:hover:scale-100";

function App() {
  const videoInputRef = useRef(null);
  const mainRef = useRef(null);

  const [file, setFile] = useState(null);
  const [participantDescriptor, setParticipantDescriptor] = useState("");
  const [error, setError] = useState("");
  const [jobId, setJobId] = useState("");
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState("");
  const [outputUrl, setOutputUrl] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [activeTab, setActiveTab] = useState(/** @type {"rolls" | "progress" | "gym"} */ ("rolls"));
  const [sessionJobsList, setSessionJobsList] = useState(
    /** @type {Array<{ job_id: string, status: string, created_at: string | null, completed_at: string | null }>} */ (
      []
    )
  );
  const [completedRolls, setCompletedRolls] = useState(/** @type {Array<{ job_id: string, title: string, completed_at: string | null, created_at?: string | null, output_url: string }>} */ ([]));
  const [rollsLoadStatus, setRollsLoadStatus] = useState(/** @type {"loading" | "loaded" | "error"} */ ("loading"));
  const [rollsError, setRollsError] = useState("");
  const [liveJobDetails, setLiveJobDetails] = useState(/** @type {Record<string, { status?: string, progress?: string }>} */ ({}));
  const [failedJobErrors, setFailedJobErrors] = useState(/** @type {Record<string, string>} */ ({}));
  const rollsScrollTopRef = useRef(/** @type {number} */ (0));
  const [selectedRollJobId, setSelectedRollJobId] = useState(/** @type {string | null} */ (null));
  const [uploadStep, setUploadStep] = useState(/** @type {"welcome" | "descriptor"} */ ("welcome"));
  // Client-side thumbnail preview for the selected file (null until decoded).
  const videoThumbnailUrl = useVideoThumbnail(file);
  /**
   * After a tab swap, Rolls prefetch may update `completedRolls` a few hundred ms later;
   * layout + scroll anchoring can re-apply a non-zero scroll. Bump this deadline on nav
   * and then fire one more shell reset once data lands.
   */
  const suppressScrollAnchoringUntilRef = useRef(/** @type {number} */ (0));
  const { isAuthenticated } = useAuth();
  const [sessionRecoveredAt, setSessionRecoveredAt] = useState(0);
  const [sessionSnapshot, setSessionSnapshot] = useState(/** @type {null | { jobs: Array<{ job_id: string, status: string }>, completed_count: number, funnel: { first_watch_nudge_shown?: boolean, three_roll_watch_nudge_shown?: boolean, pending_signup_gate_job_id?: string | null } }} */ (null));
  const [signupGateJobId, setSignupGateJobId] = useState(/** @type {string | null} */ (null));
  const [watchNudgeOpen, setWatchNudgeOpen] = useState(false);
  const [watchNudgeMilestonePhase, setWatchNudgeMilestonePhase] = useState(/** @type {"one" | "three"} */ ("one"));
  /** After successful PATCH — blocks duplicate progress / exit triggers. */
  const firstRollNudgeDoneRef = useRef(false);
  const threeRollNudgeDoneRef = useRef(false);
  const firstRollNudgeBusyRef = useRef(false);
  /** Limits rapid retries from the ≥80% timeupdate spam when attempt fails early. */
  const progressNudgeCooldownRef = useRef(false);
  /** Latest job status poll impl — invoked on timer, visibility regain, etc. */
  const pollJobStatusNowRef = useRef(/** @type {null | (() => Promise<void>)} */ (null));

  useLayoutEffect(() => {
    if (readLocalFirstWatchNudgeShown()) {
      firstRollNudgeDoneRef.current = true;
    }
    if (readLocalThreeRollNudgeShown()) {
      threeRollNudgeDoneRef.current = true;
    }
  }, []);

  const PAGE_HEADINGS = { rolls: "Rolls", progress: "Progress", gym: "Gym" };
  const pageHeading = PAGE_HEADINGS[activeTab] ?? "";

  /**
   * Narrated roll currently being watched in the Rolls drill-down view.
   * Resolves the selected id against the latest fetched list so the player
   * always uses a freshly re-signed output URL (see routes/status.js).
   */
  const selectedRoll = useMemo(() => {
    if (!selectedRollJobId) return null;
    return completedRolls.find((r) => r.job_id === selectedRollJobId) ?? null;
  }, [selectedRollJobId, completedRolls]);

  const completedByJobId = useMemo(
    () => new Map(completedRolls.map((r) => [r.job_id, r])),
    [completedRolls]
  );

  /** Fully reset scroll for the SPA shell — `main`, document, and `#root`. */
  function scrollShellToTop() {
    const ae = document.activeElement;
    if (ae instanceof HTMLElement) {
      ae.blur();
    }

    const el = mainRef.current;
    if (el) {
      el.scrollTop = 0;
      el.scrollLeft = 0;
      el.scrollTo({ top: 0, left: 0, behavior: "auto" });
    }

    const root = document.getElementById("root");
    if (root) {
      root.scrollTop = 0;
      root.scrollLeft = 0;
    }

    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    document.documentElement.scrollTop = 0;
    document.documentElement.scrollLeft = 0;
    document.body.scrollTop = 0;
    document.body.scrollLeft = 0;
  }

  function armScrollAnchoringBypass() {
    suppressScrollAnchoringUntilRef.current = Date.now() + 500;
  }

  const loadRollsPageData = useCallback(async () => {
    const sid = getRollaiSessionId();

    if (isAuthenticated && !sid) {
      setSessionJobsList([]);
      setCompletedRolls([]);
      setFailedJobErrors({});
      setRollsLoadStatus("loaded");
      setRollsError("");
      return;
    }

    let serverList =
      /** @type {Array<{ job_id: string, status: string, created_at: string | null, completed_at: string | null }>} */ (
        []
      );
    let sessionFetchOk = true;

    if (sid) {
      try {
        const { jobs } = await fetchSessionJobs(sid);
        serverList = Array.isArray(jobs) ? jobs : [];
      } catch (err) {
        sessionFetchOk = false;
        console.warn("[rolls] fetchSessionJobs failed:", err);
        setRollsError(err instanceof Error ? err.message : "Could not load rolls.");
        setRollsLoadStatus("error");
      }
    }

    let list = serverList;

    if (!isAuthenticated) {
      try {
        list = await augmentSessionJobsWithStoredRolls(serverList);
      } catch (err) {
        console.warn("[rolls] augment stored jobs failed:", err);
        list = serverList;
      }
    }

    if (!isAuthenticated && !sid && list.length === 0) {
      setSessionJobsList([]);
      setCompletedRolls([]);
      setFailedJobErrors({});
      setRollsLoadStatus("loaded");
      setRollsError("");
      return;
    }

    try {
      setSessionJobsList(list);

      const completeIds = list.filter((j) => j.status === "complete").map((j) => j.job_id);

      /** @type {typeof completedRolls} */
      let rollsFull = [];

      if (isAuthenticated && completeIds.length > 0) {
        const data = await fetchCompletedRolls([]);
        const byId = new Map(data.rolls.map((r) => [r.job_id, r]));
        rollsFull = completeIds.map((id) => byId.get(id)).filter(Boolean);
      } else if (!isAuthenticated && completeIds.length > 0) {
        const storedIds = readStoredRollJobIds().filter(looksLikeUuid);
        const idSet = [...new Set([...completeIds, ...storedIds])];
        const data = await fetchCompletedRolls(idSet);
        const byId = new Map((Array.isArray(data.rolls) ? data.rolls : []).map((r) => [r.job_id, r]));
        rollsFull = completeIds.map((id) => byId.get(id)).filter(Boolean);
      }

      setCompletedRolls(finalizeRollListForUiDev(rollsFull));

      const failedJobs = list.filter((j) => j.status === "failed");
      if (failedJobs.length > 0) {
        const errs = /** @type {Record<string, string>} */ ({});
        await Promise.all(
          failedJobs.map(async (j) => {
            try {
              const s = await getJobStatus(j.job_id);
              errs[j.job_id] = s.error_message || SERVICE_UNAVAILABLE_MESSAGE;
            } catch {
              errs[j.job_id] = "Something went wrong";
            }
          })
        );
        setFailedJobErrors(errs);
      } else {
        setFailedJobErrors({});
      }

      if (!sessionFetchOk && list.length > 0) {
        setRollsError("");
        setRollsLoadStatus("loaded");
      } else if (sessionFetchOk) {
        setRollsError("");
        setRollsLoadStatus("loaded");
      }
    } catch (err) {
      setRollsError(err instanceof Error ? err.message : "Could not load rolls.");
      setRollsLoadStatus("error");
    } finally {
      if (Date.now() < suppressScrollAnchoringUntilRef.current) {
        queueMicrotask(() => scrollShellToTop());
      }
    }
  }, [isAuthenticated]);

  const handleTabChange = (/** @type {"rolls" | "progress" | "gym"} */ nextTab) => {
    if (activeTab === "rolls" && mainRef.current) {
      rollsScrollTopRef.current = mainRef.current.scrollTop;
    }
    armScrollAnchoringBypass();
    if (nextTab !== "rolls") {
      scrollShellToTop();
    }
    setActiveTab(nextTab);
  };

  const goToUpload = () => {
    armScrollAnchoringBypass();
    scrollShellToTop();
    rollsScrollTopRef.current = 0;
    setActiveTab("rolls");
    window.requestAnimationFrame(() => {
      videoInputRef.current?.click();
    });
  };
  const handleSignIn = () => {
    // TODO: replace with Supabase Auth flow.
    console.info("[auth] sign-in flow is not wired up yet");
  };

  const handleSignUp = () => {
    // TODO: replace with Supabase Auth flow.
    console.info("[auth] sign-up flow is not wired up yet");
  };

  const emptyStateConfigs = {
    progress: isAuthenticated
      ? {
          title: "Your BJJ progress will live here",
          description:
            "As you analyse more rolls, charts of your submission attempts, sweeps, passes and guard retention will build up here.",
          action: { label: "Upload a roll", onClick: goToUpload }
        }
      : {
          title: "Track your BJJ over time",
          description:
            "Sign in to see your submissions, sweeps and guard passes build into a picture of your game.",
          action: { label: "Sign in", onClick: handleSignIn }
        },
    gym: isAuthenticated
      ? {
          title: "Connect with your gym",
          description:
            "Classes, training partners and upcoming events at your gym will show up here.",
          action: null
        }
      : {
          title: "Find your gym community",
          description: "Sign in to connect with classes, partners and events at your gym.",
          action: { label: "Sign in", onClick: handleSignIn }
        }
  };

  const showSecondAnalysisGate = Boolean(signupGateJobId) && !isAuthenticated;

  const refreshSessionSnapshot = useCallback(async () => {
    const sid = getRollaiSessionId();
    if (!sid) return;
    try {
      const sum = await fetchSessionSummary(sid);
      setSessionSnapshot(sum);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (sessionSnapshot?.funnel?.first_watch_nudge_shown) {
      firstRollNudgeDoneRef.current = true;
    }
  }, [sessionSnapshot?.funnel?.first_watch_nudge_shown]);

  useEffect(() => {
    if (sessionSnapshot?.funnel?.three_roll_watch_nudge_shown) {
      threeRollNudgeDoneRef.current = true;
    }
  }, [sessionSnapshot?.funnel?.three_roll_watch_nudge_shown]);

  const attemptFirstRollNudge = useCallback(
    async (/** @type {"progress" | "exit"} */ source) => {
      const releaseProgressCooldownSoon = () => {
        window.setTimeout(() => {
          progressNudgeCooldownRef.current = false;
        }, 1400);
      };

      if (isAuthenticated) return;
      if (firstRollNudgeBusyRef.current) return;

      firstRollNudgeBusyRef.current = true;
      try {
        const sid = getRollaiSessionId();
        let completeCount = 0;
        let firstDone = firstRollNudgeDoneRef.current;
        let threeDone = threeRollNudgeDoneRef.current;

        if (sid) {
          const sum = await fetchSessionSummary(sid).catch(() => null);
          if (sum) {
            setSessionSnapshot(sum);
            if (sum.funnel?.first_watch_nudge_shown) {
              firstRollNudgeDoneRef.current = true;
              firstDone = true;
            }
            if (sum.funnel?.three_roll_watch_nudge_shown) {
              threeRollNudgeDoneRef.current = true;
              threeDone = true;
            }
          }
          const merged = await fetchMergedSessionJobsForFunnel(sid);
          completeCount = merged.filter((j) => j.status === "complete").length;
        } else {
          if (readLocalFirstWatchNudgeShown()) {
            firstRollNudgeDoneRef.current = true;
            firstDone = true;
          }
          if (readLocalThreeRollNudgeShown()) {
            threeRollNudgeDoneRef.current = true;
            threeDone = true;
          }
          completeCount = completedRolls.length;
        }

        /** @type {"one" | "three" | null} */
        let phase = null;
        if (!firstDone) {
          phase = "one";
        } else if (completeCount >= 3 && !threeDone) {
          phase = "three";
        }

        if (phase == null) {
          return;
        }

        if (phase === "one") {
          if (sid) {
            await patchSessionFunnel(sid, { first_watch_nudge_shown: true }).catch(() => {});
            const refreshed = await fetchSessionSummary(sid).catch(() => null);
            if (refreshed) setSessionSnapshot(refreshed);
          } else {
            writeLocalFirstWatchNudgeShown();
          }
          firstRollNudgeDoneRef.current = true;
          setWatchNudgeMilestonePhase("one");
        } else {
          if (sid) {
            await patchSessionFunnel(sid, { three_roll_watch_nudge_shown: true }).catch(() => {});
            const refreshed = await fetchSessionSummary(sid).catch(() => null);
            if (refreshed) setSessionSnapshot(refreshed);
          } else {
            writeLocalThreeRollNudgeShown();
          }
          threeRollNudgeDoneRef.current = true;
          setWatchNudgeMilestonePhase("three");
        }

        setWatchNudgeOpen(true);
      } catch {
        firstRollNudgeDoneRef.current = true;
        writeLocalFirstWatchNudgeShown();
        setWatchNudgeMilestonePhase("one");
        setWatchNudgeOpen(true);
      } finally {
        firstRollNudgeBusyRef.current = false;
        if (source === "progress") {
          releaseProgressCooldownSoon();
        }
      }
    },
    [isAuthenticated, completedRolls.length]
  );

  /** Leaving the Rolls tab while the immersive player is open counts as exiting the watch UX. */
  useEffect(() => {
    if (activeTab === "rolls" || !selectedRollJobId) {
      return;
    }
    void attemptFirstRollNudge("exit");
    setSelectedRollJobId(null);
  }, [activeTab, selectedRollJobId, attemptFirstRollNudge]);

  useEffect(() => {
    progressNudgeCooldownRef.current = false;
  }, [selectedRollJobId]);

  useEffect(() => {
    const sid = ensureRollaiSessionId();
    if (!sid) return;
    fetchSessionSummary(sid)
      .then(async (summary) => {
        setSessionSnapshot(summary);
        summary.jobs
          .filter((j) => j.status === "complete")
          .forEach((j) => rememberRollJobId(j.job_id));
        const inProgress = summary.jobs.find((j) => j.status !== "complete" && j.status !== "failed");
        if (inProgress) {
          setJobId(inProgress.job_id);
        }

        let mergedJobs = summary.jobs;
        try {
          mergedJobs = await fetchMergedSessionJobsForFunnel(sid);
          mergedJobs
            .filter((j) => j.status === "complete")
            .forEach((j) => rememberRollJobId(j.job_id));
        } catch {
          /* keep summary.jobs for gate math */
        }

        const effectiveCompleteCount = mergedJobs.filter((j) => j.status === "complete").length;

        if (summary.funnel?.pending_signup_gate_job_id) {
          setSignupGateJobId(summary.funnel.pending_signup_gate_job_id);
        } else if (effectiveCompleteCount >= 2) {
          // Gate was never set (e.g. videos uploaded before the gate existed).
          const gateJobId = mergedJobs.find((j) => j.status === "complete")?.job_id;
          if (gateJobId) {
            patchSessionFunnel(sid, { pending_signup_gate_job_id: gateJobId })
              .then(() => setSignupGateJobId(gateJobId))
              .catch(() => {});
          }
        }
        setSessionRecoveredAt(Date.now());
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    try {
      if (jobId) sessionStorage.setItem(ACTIVE_ANALYSIS_JOB_ID_KEY, jobId);
      else sessionStorage.removeItem(ACTIVE_ANALYSIS_JOB_ID_KEY);
    } catch {
      /* private mode / quota */
    }
  }, [jobId]);

  /** If React state lost the in-flight job id but session storage still has one, resume polling. */
  useEffect(() => {
    if (jobId) return undefined;
    let stored = null;
    try {
      stored = sessionStorage.getItem(ACTIVE_ANALYSIS_JOB_ID_KEY);
    } catch {
      return undefined;
    }
    if (!stored || !looksLikeUuid(stored)) return undefined;

    let cancelled = false;
    void getJobStatus(stored.trim())
      .then((data) => {
        if (cancelled) return;
        if (data.status === "complete" || data.status === "failed") {
          try {
            sessionStorage.removeItem(ACTIVE_ANALYSIS_JOB_ID_KEY);
          } catch {
            /* ignore */
          }
          return;
        }
        setJobId(stored.trim());
        setStatus(data.status);
        setProgress(data.progress || "");
        setOutputUrl(data.output_url || "");
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [jobId]);

  useEffect(() => {
    const syncWhenBack = () => {
      if (document.visibilityState !== "visible") return;
      void loadRollsPageData();
      const run = pollJobStatusNowRef.current;
      if (run) void run();
    };

    const onFocus = () => {
      void loadRollsPageData();
      const run = pollJobStatusNowRef.current;
      if (run) void run();
    };

    document.addEventListener("visibilitychange", syncWhenBack);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", syncWhenBack);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onFocus);
    };
  }, [loadRollsPageData]);

  useEffect(() => {
    if (!jobId) {
      pollJobStatusNowRef.current = null;
      return undefined;
    }

    let cancelled = false;
    let intervalId = 0;

    const pollStatus = async () => {
      try {
        const data = await getJobStatus(jobId);

        if (cancelled) {
          return;
        }

        setStatus(data.status);
        setProgress(data.progress || "");
        setOutputUrl(data.output_url || "");

        if (data.status === "complete") {
          rememberRollJobId(jobId);
          const completedJobId = jobId;

          if (!cancelled && !isAuthenticated) {
            const sid = getRollaiSessionId();
            if (sid) {
              try {
                const [sum, mergedJobs] = await Promise.all([
                  fetchSessionSummary(sid),
                  fetchMergedSessionJobsForFunnel(sid)
                ]);
                if (cancelled) return;
                setSessionSnapshot(sum);
                const effectiveCompleteCount = mergedJobs.filter((j) => j.status === "complete").length;
                if (effectiveCompleteCount >= 2) {
                  await patchSessionFunnel(sid, {
                    pending_signup_gate_job_id: completedJobId
                  });
                  const refreshed = await fetchSessionSummary(sid);
                  if (cancelled) return;
                  setSessionSnapshot(refreshed);
                  setSignupGateJobId(completedJobId);
                }
              } catch (sessionErr) {
                console.warn("[session] funnel update failed:", sessionErr);
              }
            }
          }

          if (cancelled) return;

          clearInterval(intervalId);
          /** Skip the analysing “completion” screen — go straight to the Rolls list. */
          setJobId("");
          setStatus("");
          setProgress("");
          setOutputUrl("");
          setUploadStep("welcome");
          setFile(null);
          setParticipantDescriptor("");
          if (videoInputRef.current) videoInputRef.current.value = "";
          armScrollAnchoringBypass();
          rollsScrollTopRef.current = 0;
          scrollShellToTop();
          setActiveTab("rolls");
          setSelectedRollJobId(null);
          void loadRollsPageData();
          return;
        }

        if (data.status === "failed") {
          clearInterval(intervalId);
          setError(data.error_message || SERVICE_UNAVAILABLE_MESSAGE);
          setJobId("");
          setStatus("");
          setProgress("");
          setOutputUrl("");
          setUploadStep("welcome");
          setFile(null);
          setParticipantDescriptor("");
          if (videoInputRef.current) videoInputRef.current.value = "";
        }
      } catch (pollError) {
        if (!cancelled) {
          console.error("[status] poll failed:", pollError);
          setError(SERVICE_UNAVAILABLE_MESSAGE);
        }
      }
    };

    pollJobStatusNowRef.current = pollStatus;
    pollStatus();
    intervalId = window.setInterval(pollStatus, 5000);

    return () => {
      cancelled = true;
      pollJobStatusNowRef.current = null;
      clearInterval(intervalId);
    };
  }, [jobId, isAuthenticated, loadRollsPageData]);

  useLayoutEffect(() => {
    if (activeTab === "rolls") {
      const y = rollsScrollTopRef.current;
      requestAnimationFrame(() => {
        if (mainRef.current) {
          mainRef.current.scrollTop = y;
        }
      });
    } else {
      scrollShellToTop();
      requestAnimationFrame(() => scrollShellToTop());
    }
  }, [activeTab]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      ensureRollaiSessionId();
      await loadRollsPageData();
      if (!cancelled && !isAuthenticated && getRollaiSessionId()) {
        const sidSnapshot = getRollaiSessionId();
        if (sidSnapshot) {
          fetchSessionSummary(sidSnapshot)
            .then((snap) => {
              if (!cancelled) setSessionSnapshot(snap);
            })
            .catch(() => {});
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [sessionRecoveredAt, isAuthenticated, loadRollsPageData]);

  const incompleteJobIdsKey = useMemo(
    () =>
      sessionJobsList
        .filter((j) => j.status !== "complete" && j.status !== "failed")
        .map((j) => j.job_id)
        .sort()
        .join(","),
    [sessionJobsList]
  );

  useEffect(() => {
    if (!incompleteJobIdsKey) {
      return undefined;
    }
    const ids = incompleteJobIdsKey.split(",").filter(Boolean);
    if (ids.length === 0) {
      return undefined;
    }
    let cancelled = false;
    const tick = async () => {
      for (const id of ids) {
        try {
          const s = await getJobStatus(id);
          if (cancelled) return;
          setLiveJobDetails((prev) => ({
            ...prev,
            [id]: { status: s.status, progress: s.progress || "" }
          }));
          if (s.status === "complete" || s.status === "failed") {
            await loadRollsPageData();
            return;
          }
        } catch {
          /* ignore */
        }
      }
    };
    tick();
    const intervalId = window.setInterval(tick, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [incompleteJobIdsKey, loadRollsPageData]);

  useEffect(() => {
    if (!selectedRollJobId || isAuthenticated) return undefined;
    const sid = getRollaiSessionId();
    if (!sid) return undefined;
    let cancelled = false;
    fetchSessionSummary(sid)
      .then((sum) => {
        if (!cancelled) setSessionSnapshot(sum);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedRollJobId, isAuthenticated]);

  const validateVideo = async (nextFile) => {
    if (!isAllowedVideoFile(nextFile)) {
      throw new Error("Unsupported file format. Please upload MP4, MOV, WEBM, or MKV.");
    }

    if (nextFile.size > MAX_FILE_SIZE_BYTES) {
      throw new Error("File is too large. Maximum size is 500MB.");
    }

    setIsValidating(true);

    try {
      const duration = await getVideoDuration(nextFile);
      if (duration > MAX_VIDEO_DURATION_SECONDS) {
        throw new Error("Video is too long. Maximum duration is 10 minutes.");
      }
    } finally {
      setIsValidating(false);
    }
  };

  const handleFileChange = async (event) => {
    const nextFile = event.target.files?.[0];
    setError("");

    if (!nextFile) {
      setFile(null);
      return;
    }

    try {
      await validateVideo(nextFile);
      setFile(nextFile);
      setUploadStep("descriptor");
    } catch (validationError) {
      setFile(null);
      if (videoInputRef.current) {
        videoInputRef.current.value = "";
      }
      setError(validationError.message);
    }
  };

  const resetUploadFlow = () => {
    setUploadStep("welcome");
    setFile(null);
    setParticipantDescriptor("");
    if (videoInputRef.current) videoInputRef.current.value = "";
  };

  /**
   * True while an upload is being transmitted or a server-side job exists —
   * gates the analysing view vs. the upload onboarding flow on the Rolls tab.
   */
  const isAnalysisInFlight = isUploading || Boolean(jobId);

  /** Clears job state so the Rolls tab returns to the welcome step. */
  const handleStartNewUpload = () => {
    setJobId("");
    setStatus("");
    setProgress("");
    setOutputUrl("");
    setError("");
    resetUploadFlow();
  };

  /**
   * Jumps from the "analysis complete" view directly into the RollDetail
   * watch screen. We seed the just-finished job into `completedRolls`
   * synchronously so `selectedRoll` resolves on this same render tick —
   * otherwise the Rolls tab would flash the list state before the server
   * fetch populated the entry, breaking the immersive transition.
   *
   * Any subsequent server-side refresh of `completedRolls` will include the
   * same `job_id` (it's already in local storage via `rememberRollJobId`),
   * so the detail view stays mounted with richer server-sourced metadata.
   */
  const handleViewCompletedRoll = () => {
    if (!jobId || !outputUrl) return;

    setCompletedRolls((prev) => {
      if (prev.some((r) => r.job_id === jobId)) return prev;
      const nowIso = new Date().toISOString();
      const next = [
        {
          job_id: jobId,
          title: "Narrated roll",
          output_url: outputUrl,
          completed_at: nowIso,
          created_at: nowIso
        },
        ...prev
      ];
      return finalizeRollListForUiDev(next);
    });
    setSelectedRollJobId(jobId);
    armScrollAnchoringBypass();
    rollsScrollTopRef.current = 0;
    scrollShellToTop();
    setActiveTab("rolls");
    void refreshSessionSnapshot();
  };

  const handleUpload = async (event) => {
    event?.preventDefault?.();
    setError("");

    if (!file) {
      setError("Please choose a video file first.");
      return;
    }

    if (!participantDescriptor.trim()) {
      setError("Please describe what you are wearing so the AI can identify you.");
      return;
    }

    try {
      setIsUploading(true);
      setStatus("uploading");
      setOutputUrl("");
      setProgress("");
      const data = await uploadVideo(file, {
        profilePhoto: null,
        participantDescriptor: participantDescriptor.trim(),
        voiceKey: DEFAULT_VOICE_KEY
      });
      rememberRollJobId(data.job_id);
      setJobId(data.job_id);
      setStatus("pending");
      resetUploadFlow();
      void loadRollsPageData();
    } catch (uploadError) {
      setError(uploadError.message);
      setStatus("failed");
    } finally {
      setIsUploading(false);
    }
  };

  function handleHeaderBack() {
    if (activeTab === "rolls" && !isAnalysisInFlight && uploadStep === "descriptor") {
      armScrollAnchoringBypass();
      scrollShellToTop();
      setUploadStep("welcome");
      setFile(null);
      if (videoInputRef.current) {
        videoInputRef.current.value = "";
      }
    }
  }

  function dismissRollWatch() {
    void attemptFirstRollNudge("exit");
    armScrollAnchoringBypass();
    scrollShellToTop();
    setSelectedRollJobId(null);
  }

  const handleWatchPlaybackFraction = useCallback(
    (fraction) => {
      if (fraction < 0.8) return;
      if (firstRollNudgeDoneRef.current && threeRollNudgeDoneRef.current) return;
      if (progressNudgeCooldownRef.current) return;
      progressNudgeCooldownRef.current = true;
      void attemptFirstRollNudge("progress");
    },
    [attemptFirstRollNudge]
  );

  const handleNudgeSheetOpenChange = useCallback((next) => {
    setWatchNudgeOpen(next);
  }, []);

  const handleNudgeUploadAnotherRoll = useCallback(() => {
    setWatchNudgeOpen(false);
    setSelectedRollJobId(null);
    armScrollAnchoringBypass();
    scrollShellToTop();
    rollsScrollTopRef.current = 0;
    setActiveTab("rolls");
    window.requestAnimationFrame(() => {
      videoInputRef.current?.click();
    });
  }, []);

  const handleSecondAnalysisGateComplete = useCallback(
    async (targetJobId) => {
      setSignupGateJobId(null);
      rememberRollJobId(targetJobId);
      await loadRollsPageData();
      await refreshSessionSnapshot();
      armScrollAnchoringBypass();
      rollsScrollTopRef.current = 0;
      scrollShellToTop();
      setSelectedRollJobId(targetJobId);
      setActiveTab("rolls");
    },
    [refreshSessionSnapshot, loadRollsPageData]
  );

  const headerShowsBack = activeTab === "rolls" && !isAnalysisInFlight && uploadStep === "descriptor";
  const headerBackAriaLabel = "Back to upload start";
  const isRollWatchImmersive = activeTab === "rolls" && Boolean(selectedRollJobId);

  const showFabNewUpload =
    activeTab === "rolls" &&
    !isRollWatchImmersive &&
    !showSecondAnalysisGate &&
    !selectedRoll &&
    rollsLoadStatus === "loaded" &&
    !rollsError &&
    sessionJobsList.length > 0 &&
    !isAnalysisInFlight &&
    !isValidating &&
    uploadStep === "welcome";

  const showCrossTabAnalysisBanner =
    activeTab !== "rolls" &&
    !isRollWatchImmersive &&
    !showSecondAnalysisGate &&
    (isUploading || Boolean(jobId));

  const inputClass =
    "h-auto min-h-[52px] w-full rounded-lg border-border bg-[var(--rollai-input-surface)] px-4 py-3 text-base font-normal text-foreground shadow-sm transition-all duration-300 placeholder:text-muted-foreground hover:shadow-md focus-visible:border-border focus-visible:shadow-md focus-visible:ring-1 focus-visible:ring-primary/25";

  return (
    <>
      {/* Always mounted — upload/analysis continues when navigating between app tabs. */}
      <input
        ref={videoInputRef}
        id="video"
        type="file"
        accept="video/*"
        className="-z-50 fixed left-0 top-[300vh] m-[-1px] h-px w-px opacity-0"
        tabIndex={-1}
        disabled={isUploading || isValidating}
        onChange={handleFileChange}
      />
      <main
        ref={mainRef}
        className={cn(
          "h-[100dvh] overflow-x-clip overflow-y-scroll overscroll-y-none w-full bg-background text-foreground [overflow-anchor:none]",
          !isRollWatchImmersive &&
            cn(
              "rollai-main-under-fixed-header",
              showCrossTabAnalysisBanner && "rollai-main-under-fixed-header--sub-banner"
            )
        )}
      >
        {!isRollWatchImmersive ? (
          <header
            className="fixed inset-x-0 top-0 z-40 grid min-h-[2.75rem] grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 bg-background px-6 pb-4 md:px-10 lg:px-14"
            style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top, 0px))" }}
          >
            <div className="flex shrink-0 items-center justify-start">
              {headerShowsBack ? (
                <button
                  type="button"
                  onClick={handleHeaderBack}
                  aria-label={headerBackAriaLabel}
                  className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-foreground outline-none transition-colors hover:bg-muted/75 focus-visible:ring-2 focus-visible:ring-primary/35"
                >
                  <ChevronLeft className="size-7" aria-hidden strokeWidth={2} />
                </button>
              ) : (
                <span aria-hidden className="inline-flex size-10 shrink-0" />
              )}
            </div>
            {pageHeading ? (
              <h1
                id="page-heading"
                className="max-w-[min(18rem,calc(100vw-7rem))] justify-self-center truncate text-center text-xl font-semibold tracking-tight text-foreground md:max-w-md"
              >
                {pageHeading}
              </h1>
            ) : (
              <span id="page-heading" className="justify-self-center sr-only">
                RollAI
              </span>
            )}
            <div className="flex justify-end">
              <ThemeToggle />
            </div>
          </header>
        ) : null}

        {!isRollWatchImmersive && showCrossTabAnalysisBanner ? (
          <div
            role="status"
            aria-live="polite"
            className={cn(
              "fixed inset-x-0 z-[39] flex justify-center px-6",
              "[top:max(calc(0.75rem+2.75rem+1rem+env(safe-area-inset-top,0px)),4rem)]"
            )}
          >
            <button
              type="button"
              onClick={() => setActiveTab("rolls")}
              className={cn(
                "flex max-w-xl flex-1 items-center justify-between gap-3 rounded-b-lg border-x border-b border-border/70 bg-muted/95 px-4 py-2.5 text-left text-sm shadow-sm backdrop-blur-sm",
                "outline-none supports-[backdrop-filter]:bg-muted/85",
                "focus-visible:ring-2 focus-visible:ring-primary/35"
              )}
            >
              <span className="min-w-0 truncate font-medium text-foreground">
                {isUploading ? "Uploading your video…" : progress || `Analysing your roll (${status || "processing"})…`}
              </span>
              <span className="shrink-0 text-primary">{isUploading ? "Rolls tab" : "View"}</span>
            </button>
          </div>
        ) : null}

        <div
          key={activeTab}
          className={cn(
            "mx-auto flex w-full flex-col gap-8 md:gap-10",
            isRollWatchImmersive
              ? "max-w-none px-0 pt-0 pb-[max(1.25rem,env(safe-area-inset-bottom,0px))]"
              : "max-w-2xl px-6 pb-[calc(5.75rem+env(safe-area-inset-bottom,0px))] md:px-10 lg:px-14"
          )}
        >
          {error ? (
            <div
              className="rounded-lg border border-destructive/25 bg-destructive/5 px-4 py-3 text-base text-destructive"
              role="alert"
            >
              {error}
            </div>
          ) : null}

          {activeTab === "rolls" ? (
            <section aria-labelledby={selectedRollJobId ? "roll-detail-title" : "page-heading"}>
              {showSecondAnalysisGate ? (
                <SecondAnalysisSignupGate
                  sessionId={getRollaiSessionId()}
                  pendingJobId={signupGateJobId ?? ""}
                  onSuccess={handleSecondAnalysisGateComplete}
                />
              ) : null}

              {isAnalysisInFlight ? (
                <AnalyzingHomeView
                  status={status}
                  onViewRoll={handleViewCompletedRoll}
                  onStartOver={handleStartNewUpload}
                  onSignUp={handleSignUp}
                />
              ) : null}

              {!isAnalysisInFlight && !showSecondAnalysisGate && uploadStep === "descriptor" ? (
                <div className="flex flex-col gap-6">
                  {videoThumbnailUrl ? (
                    <img
                      src={videoThumbnailUrl}
                      alt="Preview of your uploaded video"
                      className="aspect-video w-full rounded-lg bg-black object-cover shadow-sm ring-1 ring-border/30"
                    />
                  ) : null}
                  <div className="flex flex-col gap-2">
                    <label htmlFor="participant_descriptor" className="rollai-label">
                      Describe yourself
                    </label>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      Help the AI identify you — include clothing, build, hair colour, facial hair, and anything distinctive e.g. &lsquo;stocky build, shaved head, blue rashguard and black shorts&rsquo;
                    </p>
                    <Input
                      id="participant_descriptor"
                      type="text"
                      placeholder="e.g. blue gi, white rashguard and black shorts"
                      value={participantDescriptor}
                      onChange={(e) => setParticipantDescriptor(e.target.value)}
                      className={cn(inputClass, "mt-1")}
                      autoFocus
                    />
                  </div>
                  <Button
                    type="button"
                    onClick={handleUpload}
                    disabled={!participantDescriptor.trim() || isUploading || isValidating}
                    className={stepPrimaryButtonClass}
                  >
                    {isUploading ? "Uploading..." : "Analyse my roll"}
                  </Button>
                </div>
              ) : null}

              {!isAnalysisInFlight &&
              !showSecondAnalysisGate &&
              uploadStep === "welcome" &&
              rollsLoadStatus === "loading" ? (
                <RollsTabSkeleton />
              ) : null}

              {rollsError && rollsLoadStatus === "error" ? (
                <p
                  className={cn(
                    "text-base text-destructive",
                    selectedRollJobId ? "mx-auto max-w-2xl px-6 md:px-10 lg:px-14" : ""
                  )}
                  role="alert"
                >
                  {rollsError}
                </p>
              ) : null}

              {!selectedRoll &&
              !isAnalysisInFlight &&
              !showSecondAnalysisGate &&
              uploadStep === "welcome" &&
              rollsLoadStatus === "loaded" &&
              !rollsError &&
              sessionJobsList.length === 0 ? (
                <EmptyState
                  illustration={<HomeIllustration />}
                  title="Get AI coaching on your rolls"
                  description="Upload your BJJ footage and RollAI returns a narrated video with coaching commentary and analysis of your roll."
                  action={{
                    label: isValidating ? "Checking video..." : "Upload roll",
                    onClick: () => videoInputRef.current?.click()
                  }}
                />
              ) : null}

              {!selectedRoll &&
              !isAnalysisInFlight &&
              !showSecondAnalysisGate &&
              uploadStep === "welcome" &&
              rollsLoadStatus === "loaded" &&
              !rollsError &&
              sessionJobsList.length > 0 ? (
                <RollsTabJobsList
                  sessionJobs={sessionJobsList}
                  completedByJobId={completedByJobId}
                  liveByJobId={liveJobDetails}
                  failedErrors={failedJobErrors}
                  onSelectCompleteRoll={(jid) => setSelectedRollJobId(jid)}
                  onRetryFailed={goToUpload}
                />
              ) : null}

              {selectedRoll ? (
                <RollDetail
                  roll={selectedRoll}
                  onBack={dismissRollWatch}
                  onSignUp={isAuthenticated ? undefined : handleSignUp}
                  playbackSuspended={watchNudgeOpen}
                  onPlaybackFraction={
                    !isAuthenticated ? handleWatchPlaybackFraction : undefined
                  }
                />
              ) : null}
            </section>
          ) : null}

          {activeTab === "progress" ? (
            <section aria-labelledby="page-heading">
              <EmptyState
                illustration={<ProgressIllustration />}
                title={emptyStateConfigs.progress.title}
                description={emptyStateConfigs.progress.description}
                action={emptyStateConfigs.progress.action}
              />
            </section>
          ) : null}

          {activeTab === "gym" ? (
            <section aria-labelledby="page-heading">
              <EmptyState
                illustration={<GymIllustration />}
                title={emptyStateConfigs.gym.title}
                description={emptyStateConfigs.gym.description}
                action={emptyStateConfigs.gym.action}
              />
            </section>
          ) : null}
        </div>
      </main>
      {showFabNewUpload ? (
        <label
          htmlFor="video"
          aria-label="Upload a new roll"
          className={cn(
            "fixed bottom-[calc(5.75rem+1rem+env(safe-area-inset-bottom,0px))] right-4 z-[60] flex size-14 cursor-pointer items-center justify-center rounded-full bg-primary p-0 text-primary-foreground shadow-lg transition-transform [-webkit-tap-highlight-color:transparent] hover:scale-[1.03] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/40"
          )}
        >
          <Plus className="pointer-events-none size-7 stroke-[2.5]" aria-hidden strokeWidth={2.5} />
        </label>
      ) : null}
      {!isRollWatchImmersive && !showSecondAnalysisGate ? (
        <TabBar activeTab={activeTab} onTabChange={handleTabChange} />
      ) : null}
      <FirstRollWatchNudgeSheet
        open={watchNudgeOpen}
        onOpenChange={handleNudgeSheetOpenChange}
        onUploadAnother={handleNudgeUploadAnotherRoll}
        milestonePhase={watchNudgeMilestonePhase}
      />
    </>
  );
}

function getVideoDuration(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const objectUrl = URL.createObjectURL(file);

    video.preload = "metadata";
    video.src = objectUrl;

    video.onloadedmetadata = () => {
      resolve(video.duration);
      URL.revokeObjectURL(objectUrl);
    };

    video.onerror = () => {
      reject(new Error("Could not read video metadata. Try another file."));
      URL.revokeObjectURL(objectUrl);
    };
  });
}

export default App;
