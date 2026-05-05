import { cn } from "@/lib/utils";
import { ChevronLeft, Play } from "lucide-react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * @typedef {Object} RollDetailRoll
 * @property {string} job_id
 * @property {string} title
 * @property {string} output_url
 * @property {string | null} [thumbnail_url]
 * @property {number | string | null} [duration_seconds]
 * @property {string | null} [completed_at]
 * @property {string | null} [created_at]
 */

/** @param {RollDetailRoll} roll */
function readInitialDurationSeconds(roll) {
  const r = roll.duration_seconds;
  if (typeof r === "number" && Number.isFinite(r) && r > 0) return r;
  if (r != null && `${r}`.trim() !== "") {
    const n = Number(r);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/** Merge API / streamed duration hints until `loadedmetadata` supplies a definitive value */
function absorbDuration(prev, incoming) {
  if (typeof incoming !== "number" || !Number.isFinite(incoming) || incoming <= 0) {
    return prev;
  }
  if (!(prev > 0) || incoming > prev * 1.01 || incoming < prev * 0.99) {
    return incoming;
  }
  return Math.max(prev, incoming);
}

/** @param {RollDetailRoll} roll @returns {string | null} */
function pickRollTimestampIso(roll) {
  for (const c of [roll.completed_at, roll.created_at]) {
    if (typeof c === "string" && c.trim() !== "") {
      const d = new Date(c.trim());
      if (!Number.isNaN(d.getTime())) return c.trim();
    }
  }
  return null;
}

/** @param {string} iso */
function formatRollDateLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(d);
  } catch {
    return d.toLocaleDateString();
  }
}

/**
 * Full-screen in-app roll player. Custom overlay + scrubber (`controls=false`).
 *
 * @param {Object} props
 * @param {RollDetailRoll} props.roll
 * @param {(() => void) | null | undefined} [props.onBack]
 * @param {(() => void) | null | undefined} [props.onSignUp] Shown as a Shorts-style pill when set (e.g. logged-out users).
 * @param {boolean} [props.playbackSuspended] When true, pauses the player (e.g. marketing sheet over the first roll).
 * @param {(fraction: number) => void} [props.onPlaybackFraction] 0–1 watch progress for onboarding nudges.
 */
export function RollDetail({ roll, onBack, onSignUp, playbackSuspended = false, onPlaybackFraction }) {
  const videoRef = useRef(/** @type {HTMLVideoElement | null} */ (null));
  const seekRailRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const seekDraggingRef = useRef(false);
  /** `activeScrubDispose` clears window-bound drag listeners started by scrub */
  const activeScrubDisposeRef = useRef(/** @type {null | (() => void)} */ (null));

  const invokeExitFromPlayer = useCallback(() => {
    const v = videoRef.current;
    if (v && !v.paused) {
      v.pause();
    }
    onBack?.();
  }, [onBack]);

  const posterUrl = roll.thumbnail_url || null;
  const [posterBroken, setPosterBroken] = useState(false);
  const [gates, setGates] = useState(() =>
    posterUrl ? { thumb: false, meta: false } : { thumb: true, meta: false }
  );

  const [playing, setPlaying] = useState(false);
  const [currentSec, setCurrentSec] = useState(0);
  const [timelineDurationSec, setTimelineDurationSec] = useState(() => readInitialDurationSeconds(roll));

  useEffect(() => {
    setPosterBroken(false);
    setPlaying(false);
    setCurrentSec(0);
    setTimelineDurationSec(readInitialDurationSeconds(roll));
    if (posterUrl) {
      setGates({ thumb: false, meta: false });
    } else {
      setGates({ thumb: true, meta: false });
    }
  }, [posterUrl, roll.job_id]);

  /** List poll can refresh `duration_seconds` while this player stays open — do not wipe poster/video gates */
  useEffect(() => {
    const n = readInitialDurationSeconds(roll);
    if (!(n > 0)) return;
    setTimelineDurationSec((prev) => absorbDuration(prev, n));
  }, [roll.duration_seconds]);

  useEffect(() => {
    const prevBodyOverflow = document.body.style.overflow;
    const prevRootObx = document.documentElement.style.overscrollBehaviorX;
    const prevBodyObx = document.body.style.overscrollBehaviorX;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overscrollBehaviorX = "none";
    document.body.style.overscrollBehaviorX = "none";
    return () => {
      document.body.style.overflow = prevBodyOverflow;
      document.documentElement.style.overscrollBehaviorX = prevRootObx;
      document.body.style.overscrollBehaviorX = prevBodyObx;
    };
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playbackSuspended) {
      v.pause();
    }
  }, [playbackSuspended]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v || playbackSuspended) return;
    void (async () => {
      try {
        if (v.paused) await v.play();
        else v.pause();
      } catch {
        /* autoplay / gesture policy */
      }
    })();
  }, [playbackSuspended]);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === "Escape" && onBack) {
        invokeExitFromPlayer();
      }
      if (e.code === "Space" || e.code === "KeyK") {
        const root = document.querySelector("[data-roll-watch-root]");
        if (!(root instanceof HTMLElement)) return;

        /** @type {Element | null} */
        const ae = document.activeElement;
        if (ae instanceof HTMLElement && !root.contains(ae)) return;
        if (ae instanceof HTMLButtonElement) return;
        if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) return;
        if (ae instanceof HTMLElement && ae.getAttribute("role") === "slider") return;

        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [invokeExitFromPlayer, togglePlay]);

  /** Pull duration from decoded media — several events can supply it asynchronously */
  const bumpDurationFromVideo = useCallback((el) => {
    const d = el.duration;
    if (typeof d === "number" && Number.isFinite(d) && d > 0) {
      setTimelineDurationSec((prev) => absorbDuration(prev, d));
    }
  }, []);

  /** `loadedmetadata` can miss rebroadcast after remount quirks / poll updates — widen gate opening */
  const markVideoSurfaceMetaReady = useCallback((/** @type {HTMLVideoElement} */ el, wireMetaGate) => {
    if (!wireMetaGate) return;
    if (el.readyState < HTMLMediaElement.HAVE_METADATA) return;
    if (typeof el.duration !== "number" || !Number.isFinite(el.duration) || el.duration <= 0) return;
    setGates((g) => (g.meta ? g : { ...g, meta: true }));
  }, []);

  const clampSeekRatio = useCallback((ratio) => Math.min(1, Math.max(0, ratio)), []);

  /** Timeline length used for maths + %-fill */
  const getActiveDurationSec = useCallback(() => {
    const v = videoRef.current;
    const d =
      typeof v?.duration === "number" && Number.isFinite(v.duration) && v.duration > 0
        ? /** @type {number} */ (v.duration)
        : timelineDurationSec > 0
          ? timelineDurationSec
          : 0;
    return d;
  }, [timelineDurationSec]);

  const applySeekRatio = useCallback(
    (ratio) => {
      const v = videoRef.current;
      const d = getActiveDurationSec();
      if (!v || !(d > 0)) return;
      v.currentTime = clampSeekRatio(ratio) * d;
      setCurrentSec(v.currentTime);
    },
    [clampSeekRatio, getActiveDurationSec]
  );

  const getGrooveElement = () => {
    const root = seekRailRef.current;
    const groove = /** @type {HTMLElement | null} */ (root?.querySelector("[data-rollai-seek-groove]"));
    return groove instanceof HTMLElement ? groove : root;
  };

  /**
   * @param {{ clientX: number; pointerId?: number; captureTarget?: HTMLElement | null }} p
   */
  const beginScrubAtClientX = useCallback(
    (p) => {
      const prevFinish = activeScrubDisposeRef.current;
      activeScrubDisposeRef.current = null;
      prevFinish?.();

      const geom = getGrooveElement();
      if (!(geom instanceof HTMLElement)) return;

      const dragUpdate = (clientX) => {
        const rect = geom.getBoundingClientRect();
        const w = rect.width;
        if (!(w > 0)) return;
        applySeekRatio(clampSeekRatio((clientX - rect.left) / w));
      };
      dragUpdate(p.clientX);
      seekDraggingRef.current = true;

      const captureTarget = p.captureTarget ?? geom;

      try {
        if (typeof p.pointerId === "number") {
          captureTarget.setPointerCapture?.(p.pointerId);
        }
      } catch {
        /* Safari edge cases around capture */
      }

      const touchBlockCapture = /** @type {(te: TouchEvent) => void} */ ((te) => {
        if (seekDraggingRef.current) te.preventDefault();
      });
      document.addEventListener("touchmove", touchBlockCapture, { passive: false, capture: true });

      const onMove = (e) => dragUpdate(e.clientX);
      const finish = () => {
        seekDraggingRef.current = false;
        activeScrubDisposeRef.current = null;
        try {
          if (typeof p.pointerId === "number") {
            captureTarget.releasePointerCapture?.(p.pointerId);
          }
        } catch {
          /* ignore */
        }
        document.removeEventListener("touchmove", touchBlockCapture, { capture: true });
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
      };

      activeScrubDisposeRef.current = finish;

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [applySeekRatio, clampSeekRatio]
  );

  /** Safari often omits actionable pointer streams on custom sliders — use passive:false touch handlers */
  useEffect(() => {
    const el = seekRailRef.current;
    if (!(el instanceof HTMLElement)) return;

    const onTouchStart = (e) => {
      if (!e.touches || e.touches.length !== 1) return;
      if (e.cancelable === false) return;
      e.preventDefault();
      e.stopPropagation();
      const tx = e.touches[0];
      beginScrubAtClientX({ clientX: tx.clientX, captureTarget: el });
    };

    /** passive:false is required before `preventDefault` can cancel horizontal swipe-back during scrub */
    el.addEventListener("touchstart", onTouchStart, { passive: false, capture: true });
    return () => el.removeEventListener("touchstart", onTouchStart, { capture: true });
  }, [beginScrubAtClientX]);

  useEffect(() => {
    return () => {
      activeScrubDisposeRef.current?.();
      activeScrubDisposeRef.current = null;
      seekDraggingRef.current = false;
    };
  }, []);

  const onSeekPointerDown = useCallback(
    (event) => {
      /** Touch devices also emit pointerevents — defer to passive touch hook to prevent double attaches */
      if (event.pointerType === "touch") return;

      event.preventDefault();
      event.stopPropagation();

      /** Track slab may differ from groove metrics */
      beginScrubAtClientX({
        clientX: event.clientX,
        pointerId: event.pointerId,
        captureTarget:
          seekRailRef.current instanceof HTMLElement ? seekRailRef.current : (event.currentTarget.firstElementChild instanceof HTMLElement ? event.currentTarget.firstElementChild : /** @type {HTMLElement | null} */ (null))
      });
    },
    [beginScrubAtClientX]
  );

  const onSeekKeyDown = useCallback(
    (event) => {
      const d = getActiveDurationSec();
      const step = d > 0 ? Math.max(1, d * 0.05) : 5;
      if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
        event.preventDefault();
        const v = videoRef.current;
        if (!v) return;
        v.currentTime = Math.max(0, v.currentTime - step);
        setCurrentSec(v.currentTime);
      }
      if (event.key === "ArrowRight" || event.key === "ArrowUp") {
        event.preventDefault();
        const v = videoRef.current;
        if (!v || !(d > 0)) return;
        v.currentTime = Math.min(d, v.currentTime + step);
        setCurrentSec(v.currentTime);
      }
    },
    [getActiveDurationSec]
  );

  const displayDur = getActiveDurationSec();
  /** `clampSeekRatio` is 0..1 — apply before multiplying to percent */
  const pct = displayDur > 0 ? clampSeekRatio(currentSec / displayDur) * 100 : 0;

  useEffect(() => {
    if (typeof onPlaybackFraction !== "function") return;
    const d = displayDur;
    if (!(d > 0)) return;
    if (seekDraggingRef.current) return;
    onPlaybackFraction(clampSeekRatio(currentSec / d));
  }, [currentSec, displayDur, clampSeekRatio, onPlaybackFraction]);

  const rollTimestampIso = useMemo(
    () => pickRollTimestampIso(roll),
    [roll.completed_at, roll.created_at]
  );
  const rollDateLabel = rollTimestampIso ? formatRollDateLabel(rollTimestampIso) : null;

  const playerSurfaceReady = gates.thumb && gates.meta;
  const showStackedPoster = Boolean(posterUrl) && !posterBroken;

  const stackedVideoCn = cn(
    "pointer-events-none absolute inset-0 z-[1] h-full w-full object-cover object-center transition-opacity duration-200 ease-out",
    playerSurfaceReady ? "opacity-100" : "opacity-0"
  );

  const soloVideoCn =
    "pointer-events-none absolute inset-0 z-[1] h-full w-full object-cover object-center";

  /** @param {string} className @param {boolean} wireMetaGate */
  function videoElement(className, wireMetaGate) {
    return (
      <video
        ref={videoRef}
        key={roll.job_id}
        src={roll.output_url}
        playsInline
        preload="auto"
        className={className}
        controls={false}
        onLoadedMetadata={(e) => {
          bumpDurationFromVideo(e.currentTarget);
          markVideoSurfaceMetaReady(e.currentTarget, wireMetaGate);
        }}
        /** HLS / late duration fixes */
        onDurationChange={(e) => {
          bumpDurationFromVideo(e.currentTarget);
          markVideoSurfaceMetaReady(e.currentTarget, wireMetaGate);
        }}
        /** iOS occasionally delays duration until buffered frames exist */
        onLoadedData={(e) => {
          bumpDurationFromVideo(e.currentTarget);
          markVideoSurfaceMetaReady(e.currentTarget, wireMetaGate);
        }}
        onCanPlay={(e) => {
          bumpDurationFromVideo(e.currentTarget);
          markVideoSurfaceMetaReady(e.currentTarget, wireMetaGate);
        }}
        onTimeUpdate={(e) => {
          if (seekDraggingRef.current) return;
          setCurrentSec(e.currentTarget.currentTime);
        }}
        onSeeking={(e) => setCurrentSec(e.currentTarget.currentTime)}
        onSeeked={(e) => setCurrentSec(e.currentTarget.currentTime)}
        onPlay={(e) => {
          setPlaying(true);
          const v = e.currentTarget;
          markVideoSurfaceMetaReady(v, wireMetaGate);
          queueMicrotask(() => {
            if (!videoRef.current || videoRef.current !== v || v.paused) return;
            const t = v.currentTime;
            /** WebKit occasionally stops repainting decoded frames across pause/play */
            if (Number.isFinite(t)) v.currentTime = t;
          });
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        aria-label={`Narrated roll: ${roll.title}`}
      />
    );
  }

  const shell = (
    <div
      data-roll-watch-root
      className="fixed inset-0 z-[220] flex touch-manipulation flex-col overscroll-none bg-black text-white [overscroll-behavior-x:none]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="roll-detail-title"
    >
      <div className="relative flex min-h-0 w-full flex-1 bg-black">
        <div className="absolute inset-0 m-auto flex max-h-full max-w-full items-center justify-center">
          {showStackedPoster ? (
            <>
              <img
                src={posterUrl}
                alt=""
                draggable={false}
                decoding="async"
                loading="eager"
                fetchPriority="high"
                ref={(imgEl) => {
                  /** Cached thumbnails may skip `load` — unsticks `gates.thumb` */
                  if (!(imgEl instanceof HTMLImageElement)) return;
                  if (imgEl.complete && imgEl.naturalWidth > 0) {
                    setGates((g) => (g.thumb ? g : { ...g, thumb: true }));
                  }
                }}
                onLoad={() => setGates((g) => ({ ...g, thumb: true }))}
                onError={() => {
                  setPosterBroken(true);
                  setGates((g) => ({ ...g, thumb: true }));
                }}
                className={cn(
                  "pointer-events-none absolute inset-0 z-0 h-full w-full object-cover object-center transition-opacity duration-200 ease-out",
                  playerSurfaceReady ? "opacity-0" : "opacity-100"
                )}
                aria-hidden
              />
              {videoElement(stackedVideoCn, true)}
            </>
          ) : (
            videoElement(soloVideoCn, false)
          )}
        </div>

        <div className="pointer-events-none absolute inset-0 z-10 flex min-h-0 flex-col">
          <div
            className="pointer-events-none relative isolate z-[30] shrink-0"
            style={{
              paddingLeft: "max(1rem, env(safe-area-inset-left, 0px))",
              paddingRight: "max(1rem, env(safe-area-inset-right, 0px))",
              paddingTop: "max(env(safe-area-inset-top, 0px), 0.75rem)"
            }}
          >
            {onBack ? (
              <button
                type="button"
                onTouchStart={(e) => {
                  // Match TabBar: fire on touch-start so iOS does not swallow the gesture after scroll /
                  // before the synthesized click fires (mobile back felt “dead”).
                  e.stopPropagation();
                  e.preventDefault();
                  invokeExitFromPlayer();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  invokeExitFromPlayer();
                }}
                aria-label="Back to rolls list"
                className="pointer-events-auto inline-flex size-11 min-h-[44px] min-w-[44px] items-center justify-start rounded-full pl-0 pr-2 text-white [-webkit-tap-highlight-color:transparent] drop-shadow-[0_1px_2px_rgb(0_0_0/0.82)] outline-none transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/70"
              >
                <ChevronLeft className="size-8 shrink-0" aria-hidden strokeWidth={2} />
              </button>
            ) : null}
          </div>

          <div className="pointer-events-auto relative isolate z-[1] min-h-0 flex-1">
            <button
              type="button"
              aria-label={playing ? "Pause video" : "Play video"}
              className="absolute inset-0 z-[1] cursor-pointer border-0 bg-transparent p-0"
              onPointerDown={(e) => {
                e.stopPropagation();
                if (e.pointerType === "mouse" && e.button !== 0) return;
                togglePlay();
              }}
            />
            {!playing ? (
              <div className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center">
                <div
                  className="flex size-14 items-center justify-center rounded-full bg-black/45 text-white shadow-lg ring-1 ring-white/25 backdrop-blur-sm"
                  aria-hidden
                >
                  <Play className="ml-0.5 size-7 fill-white text-white opacity-95" strokeWidth={0} />
                </div>
              </div>
            ) : null}
          </div>

          <div
            className="pointer-events-auto relative isolate z-[5] shrink-0 space-y-2 bg-gradient-to-t from-black/50 to-transparent pb-[max(env(safe-area-inset-bottom,0px),0.75rem)] pt-12"
            style={{
              paddingLeft: "max(1rem, env(safe-area-inset-left, 0px))",
              paddingRight: "max(1rem, env(safe-area-inset-right, 0px))"
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-1">
                <h1
                  id="roll-detail-title"
                  className="max-w-[min(100%,32rem)] text-left text-[15px] font-semibold leading-snug tracking-tight text-white drop-shadow-[0_1px_3px_rgb(0_0_0/0.9)]"
                >
                  {roll.title}
                </h1>
                {rollDateLabel && rollTimestampIso ? (
                  <time
                    dateTime={rollTimestampIso}
                    className="block max-w-[min(100%,32rem)] text-[13px] leading-snug tracking-tight text-white/72 tabular-nums drop-shadow-[0_1px_2px_rgb(0_0_0/0.75)]"
                  >
                    {rollDateLabel}
                  </time>
                ) : null}
              </div>
              {typeof onSignUp === "function" ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSignUp();
                  }}
                  className="shrink-0 rounded-full bg-white px-[18px] py-2 text-sm font-semibold text-neutral-950 shadow-md outline-none transition-[transform,opacity,background-color] hover:bg-white/95 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-white/90 focus-visible:ring-offset-2 focus-visible:ring-offset-black/40"
                >
                  Sign up
                </button>
              ) : null}
            </div>

            <div
              role="slider"
              aria-label="Seek"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pct)}
              aria-valuetext={`${Math.floor(currentSec)} seconds of ${Math.floor(displayDur)}`}
              tabIndex={0}
              onKeyDown={onSeekKeyDown}
              /** Pointer scrub (mouse / pen): touch uses capture-phase listener below */
              onPointerDown={onSeekPointerDown}
              className="touch-none py-2 outline-none [-webkit-touch-callout:none] focus-visible:ring-2 focus-visible:ring-white/55 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
            >
              <div
                ref={seekRailRef}
                data-rollai-seek-track
                className="relative isolate flex min-h-10 w-full cursor-pointer items-center rounded-full [-webkit-touch-callout:none]"
              >
                <div data-rollai-seek-groove className="relative h-1 w-full rounded-full bg-white/30">
                  <div
                    className="absolute inset-y-0 left-0 rounded-full bg-primary"
                    style={{ width: `${pct}%` }}
                    aria-hidden
                  />
                  <div
                    className="pointer-events-none absolute top-1/2 size-3.5 rounded-full bg-primary shadow-md"
                    style={{ left: `${pct}%`, transform: "translate(-50%, -50%)" }}
                    aria-hidden
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(shell, document.body);
}
