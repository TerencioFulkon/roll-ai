import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { HomeIllustration } from "@/components/empty-state-illustrations";
import { cn } from "@/lib/utils";

/** Headline copy per backend job status — BJJ-flavoured to match the app's voice. */
const STATUS_TITLES = {
  uploading: "Uploading your roll",
  queued: "Uploading your roll",
  pending: "Uploading your roll",
  processing: "Analysing your roll",
  generating_audio: "Recording your coach's voice",
  stitching_video: "Finalising the narrated video",
  complete: "Your narrated roll is ready",
  failed: "Something went wrong"
};

/**
 * Rotating sub-status lines per phase — cycled while the job is in flight so
 * the user gets a realistic sense of what an actual coach would be doing.
 */
const THINKING_SETS = {
  uploading: ["Sending your footage to the coach"],
  queued: ["Warming up the mats"],
  pending: ["Warming up the mats"],
  processing: [
    "Watching your guard passes and base",
    "Spotting submission attempts, sweeps, and counters",
    "Reading your posture, frames, and grip fights",
    "Tracking transitions between guard and top control",
    "Noting timing, pressure, and pace",
    "Picking the most useful moments to coach"
  ],
  generating_audio: [
    "Recording your coach's commentary",
    "Shaping tone and pacing for each callout"
  ],
  stitching_video: [
    "Dubbing the commentary onto your footage",
    "Polishing the final narrated video"
  ]
};

/** Shared style for the Empty State / onboarding style CTA. */
const primaryCtaClass =
  "h-auto rounded-lg bg-primary px-6 py-3 text-base font-semibold text-primary-foreground shadow-sm transition-all duration-300 hover:scale-[1.02] hover:bg-primary/92 hover:shadow-md focus-visible:ring-1 focus-visible:ring-primary/25";

/**
 * Replaces the Home upload flow while a roll is being analysed.
 *
 * - Drives the animated `HomeIllustration` (breathe + tint + badge pulse).
 * - Rotates a "thinking" sub-status with a shimmer effect.
 * - Swaps in completion / failure CTAs when the job ends.
 */
export function AnalyzingHomeView({ status, onViewRoll, onStartOver, onSignUp }) {
  const isDone = status === "complete";
  const isFailed = status === "failed";
  const isAnalyzing = !isDone && !isFailed;

  const messages = THINKING_SETS[status] || THINKING_SETS.processing;
  const [messageIndex, setMessageIndex] = useState(0);
  /** One-shot reinforcement when rotating lines — pairs with `--burst` CSS. */
  const [lineShimmerBurst, setLineShimmerBurst] = useState(false);

  useEffect(() => {
    setMessageIndex(0);
  }, [status]);

  useEffect(() => {
    if (!isAnalyzing || messages.length <= 1) return undefined;
    const id = setInterval(() => {
      setMessageIndex((i) => (i + 1) % messages.length);
    }, 5200);
    return () => clearInterval(id);
  }, [isAnalyzing, messages.length]);

  useEffect(() => {
    if (!isAnalyzing) return undefined;
    if (typeof window === "undefined") return undefined;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setLineShimmerBurst(false);
      return undefined;
    }
    setLineShimmerBurst(true);
    const t = window.setTimeout(() => setLineShimmerBurst(false), 1300);
    return () => window.clearTimeout(t);
  }, [isAnalyzing, messageIndex]);

  const title = STATUS_TITLES[status] || "Preparing your roll";
  const description = isDone
    ? "Sign up to save your rolls and track your progress over time."
    : isFailed
      ? "We couldn't finish analysing your roll. Please try uploading again."
      : messages[messageIndex] || "Analysing your roll";

  return (
    <div className="flex flex-col items-center gap-6 py-8 text-center">
      <HomeIllustration animated={isAnalyzing} />
      <div className="flex max-w-md flex-col gap-2">
        <h3 className="text-lg font-semibold tracking-tight text-foreground">{title}</h3>
        <p
          className={cn(
            isAnalyzing
              ? cn(
                  "text-base leading-relaxed rollai-shimmer-text transition-[opacity,filter,transform]",
                  lineShimmerBurst && "rollai-shimmer-text--burst"
                )
              : "text-sm leading-normal text-muted-foreground"
          )}
          aria-live="polite"
        >
          {description}
        </p>
      </div>
      {isDone ? (
        <div className="flex flex-col items-center gap-3">
          <Button type="button" onClick={onSignUp} className={primaryCtaClass}>
            Sign up free
          </Button>
          <button
            type="button"
            onClick={onViewRoll}
            className="inline-flex w-fit items-center rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/25"
          >
            Watch video first
          </button>
        </div>
      ) : null}
      {isFailed ? (
        <Button type="button" onClick={onStartOver} className={primaryCtaClass}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
