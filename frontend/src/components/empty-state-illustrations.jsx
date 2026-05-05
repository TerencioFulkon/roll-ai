import { Film, Play, Sparkles, TrendingUp, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shared illustrations for page-level empty states. All are purely decorative
 * (`aria-hidden`) and rely on theme tokens so they respect light/dark.
 *
 * Each piece has a distinct outer silhouette so the four empty states are
 * visually differentiated at a glance:
 * — Home: single video preview with an AI badge breaking the top-right corner.
 * — Rolls: vertical timeline of three separate cards.
 * — Progress: freestanding ascending bars + trend badge (no outer frame).
 * — Gym: free-floating chat bubbles with avatars (no outer frame).
 *
 * Each also features a subtle splash of the brand primary colour.
 */

function Frame({ children, className }) {
  return (
    <div aria-hidden className={cn("w-full max-w-[200px] py-2", className)}>
      {children}
    </div>
  );
}

function SkeletonLines({ titleWidth, subtitleWidth }) {
  return (
    <div className="flex flex-1 flex-col gap-1.5">
      <div className={cn("h-2 rounded-full bg-muted", titleWidth)} />
      <div className={cn("h-2 rounded-full bg-muted/70", subtitleWidth)} />
    </div>
  );
}

function Thumb({ Icon, tone = "muted" }) {
  const isPrimary = tone === "primary";
  return (
    <div
      className={cn(
        "flex size-12 shrink-0 items-center justify-center rounded-md",
        isPrimary ? "bg-primary/15" : "bg-muted/70"
      )}
    >
      <Icon className={cn("size-5", isPrimary ? "text-primary" : "text-muted-foreground")} aria-hidden />
    </div>
  );
}

/**
 * Home: video preview with a circular AI badge breaking the top-right corner.
 * When `animated`, the skeleton lines breathe, one tints between muted and
 * primary, and the AI badge pulses — used while a roll is being analysed.
 */
export function HomeIllustration({ animated = false }) {
  return (
    <Frame>
      <div className="relative">
        <div className="relative flex h-28 items-center justify-center overflow-hidden rounded-lg border border-border/70 bg-muted/70 shadow-sm">
          <div className="flex size-12 items-center justify-center rounded-full bg-background shadow-sm">
            <Play className="size-5 fill-primary text-primary" aria-hidden />
          </div>
        </div>
        <div
          className={cn(
            "absolute -top-3 -right-3 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md ring-4 ring-background",
            animated && "rollai-badge-pulse"
          )}
        >
          <Sparkles className={cn("size-5", animated && "animate-pulse")} aria-hidden />
        </div>
        <div className="mt-4 flex flex-col gap-1.5">
          <div
            className={cn("h-2 w-3/4 rounded-full bg-muted", animated && "rollai-breathe")}
          />
          <div
            className={cn(
              "h-2 w-2/3 rounded-full bg-muted/70",
              animated && "rollai-breathe rollai-breathe-slow rollai-tint"
            )}
          />
          <div
            className={cn(
              "h-2 w-1/2 rounded-full bg-primary/70",
              animated && "rollai-breathe rollai-breathe-fast"
            )}
          />
        </div>
      </div>
    </Frame>
  );
}

/** Rolls: vertical timeline of past roll cards — top (newest) card accented in brand colour. */
export function RollsIllustration() {
  const rows = [
    { Icon: Play, titleWidth: "w-3/4", subtitleWidth: "w-1/2", tone: "primary" },
    { Icon: Film, titleWidth: "w-2/3", subtitleWidth: "w-2/5" },
    { Icon: Trophy, titleWidth: "w-4/5", subtitleWidth: "w-1/3" }
  ];

  return (
    <Frame className="relative">
      <span className="absolute top-8 bottom-8 left-[7px] w-px bg-border/70" />
      <ul className="flex flex-col gap-3">
        {rows.map(({ Icon, titleWidth, subtitleWidth, tone }, i) => (
          <li key={i} className="relative flex items-center pl-6">
            <span
              className={cn(
                "absolute top-1/2 left-0 size-3.5 -translate-y-1/2 rounded-full border bg-background",
                tone === "primary" ? "border-primary" : "border-border"
              )}
            />
            <div className="flex w-full items-center gap-3 rounded-lg border border-border/70 bg-card px-3 py-3 shadow-sm">
              <Thumb Icon={Icon} tone={tone} />
              <SkeletonLines titleWidth={titleWidth} subtitleWidth={subtitleWidth} />
            </div>
          </li>
        ))}
      </ul>
    </Frame>
  );
}

/** Progress: freestanding ascending bars + floating trend badge — no outer card. */
export function ProgressIllustration() {
  const bars = [
    { height: "h-8", tone: "bg-muted" },
    { height: "h-12", tone: "bg-muted" },
    { height: "h-16", tone: "bg-muted" },
    { height: "h-24", tone: "bg-primary/80" }
  ];

  return (
    <Frame>
      <div className="relative px-2 pt-6">
        <div className="absolute top-0 right-2 flex items-center gap-1 rounded-full bg-primary px-2 py-1 text-primary-foreground shadow-sm ring-4 ring-background">
          <TrendingUp className="size-3.5" aria-hidden />
          <div className="h-1 w-5 rounded-full bg-primary-foreground/70" />
        </div>
        <div className="relative flex h-28 items-end justify-between gap-3">
          <span className="absolute right-0 bottom-0 left-0 h-px bg-border/60" />
          {bars.map(({ height, tone }, i) => (
            <div key={i} className={cn("w-8 rounded-t-md", height, tone)} />
          ))}
        </div>
        <div className="mt-3 flex items-start justify-between gap-3">
          {bars.map((_, i) => (
            <div key={i} className="h-1.5 w-6 rounded-full bg-muted/70" />
          ))}
        </div>
      </div>
    </Frame>
  );
}

/** Gym: free-floating chat bubbles + avatars — no outer frame. */
export function GymIllustration() {
  return (
    <Frame>
      <div className="flex flex-col gap-2.5 px-2">
        <div className="flex items-end gap-2">
          <div className="size-7 shrink-0 rounded-full bg-muted" />
          <div className="flex max-w-[75%] flex-col gap-1 rounded-lg rounded-bl-sm bg-muted/70 px-3 py-2 shadow-sm">
            <div className="h-1.5 w-24 rounded-full bg-muted" />
            <div className="h-1.5 w-16 rounded-full bg-muted/70" />
          </div>
        </div>

        <div className="flex items-end justify-end gap-2 pr-1">
          <div className="flex flex-col gap-1 rounded-lg rounded-br-sm bg-primary/80 px-3 py-2 shadow-sm">
            <div className="h-1.5 w-20 rounded-full bg-primary-foreground/70" />
            <div className="h-1.5 w-14 rounded-full bg-primary-foreground/45" />
          </div>
        </div>

        <div className="flex items-end gap-2">
          <div className="size-7 shrink-0 rounded-full bg-muted" />
          <div className="rounded-lg rounded-bl-sm bg-muted/70 px-3 py-2 shadow-sm">
            <div className="h-1.5 w-28 rounded-full bg-muted" />
          </div>
        </div>
      </div>
    </Frame>
  );
}
