import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { Play, TrendingUp } from "lucide-react";

/**
 * @param {{ tone?: "front" | "mid" | "back" }} props
 */
function RollRowGraphic({ tone = "front" }) {
  if (tone === "back") {
    return (
      <div className="flex items-center gap-2">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-white/12">
          <Play className="size-3.5 fill-white/40 text-white/40" strokeWidth={0} aria-hidden />
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
          <span className="block h-1 w-full rounded-full bg-white/40" />
          <span className="block h-1 max-w-[78%] rounded-full bg-white/22" />
        </div>
        <span className="size-2.5 shrink-0 rounded-full bg-white/28" aria-hidden />
      </div>
    );
  }

  if (tone === "mid") {
    return (
      <div className="flex items-center gap-2">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-white/18">
          <Play className="size-3.5 fill-white/55 text-white/55" strokeWidth={0} aria-hidden />
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
          <span className="block h-1 w-full rounded-full bg-white/52" />
          <span className="block h-1 max-w-[78%] rounded-full bg-white/32" />
        </div>
        <span className="size-2.5 shrink-0 rounded-full bg-white/42" aria-hidden />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-primary text-primary-foreground shadow-inner">
        <Play className="size-4 fill-current text-primary-foreground" strokeWidth={0} aria-hidden />
      </div>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
        <span className="block h-1 w-full rounded-full bg-foreground/95" />
        <span className="block h-1 max-w-[78%] rounded-full bg-muted-foreground/50" />
      </div>
      <span className="size-3 shrink-0 rounded-full bg-primary" aria-hidden />
    </div>
  );
}

/**
 * Dashed curve from right edge of front card (vert. centred) to left edge of insights pill (vert. centred).
 * Geometry from layout measurements so it stays accurate at any width.
 */
function RollInsightsConnector({ rootRef, cardRef, pillRef }) {
  const [path, setPath] = useState("");

  useLayoutEffect(() => {
    const root = rootRef.current;
    const card = cardRef.current;
    const pill = pillRef.current;
    if (!root || !card || !pill) return undefined;

    const update = () => {
      const rb = root.getBoundingClientRect();
      const cb = card.getBoundingClientRect();
      const pb = pill.getBoundingClientRect();
      const x1 = cb.right - rb.left;
      const y1 = cb.top + cb.height / 2 - rb.top;
      const x2 = pb.left - rb.left;
      const y2 = pb.top + pb.height / 2 - rb.top;
      const dx = x2 - x1;
      const c1x = x1 + Math.max(-48, dx * 0.35);
      const c1y = y1 + (y2 - y1) * 0.2;
      const c2x = x2 - Math.min(56, Math.abs(dx) * 0.5);
      const c2y = y2 + (y1 - y2) * 0.15;
      setPath(`M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`);
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(root);
    ro.observe(card);
    ro.observe(pill);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [rootRef, cardRef, pillRef]);

  if (!path) return null;

  return (
    <svg
      className="pointer-events-none absolute inset-0 z-[8] h-full w-full text-primary/45"
      aria-hidden
    >
      <path
        d={path}
        stroke="currentColor"
        strokeWidth="1.75"
        strokeDasharray="4 6"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function RollBuildIllustration() {
  const rootRef = useRef(null);
  const frontCardRef = useRef(null);
  const pillRef = useRef(null);

  return (
    <div
      ref={rootRef}
      className="relative mx-auto aspect-[252/158] w-[min(252px,calc(100vw-2.5rem))] shrink-0"
      aria-hidden
    >
      <RollInsightsConnector rootRef={rootRef} cardRef={frontCardRef} pillRef={pillRef} />

      <div
        ref={pillRef}
        className="absolute right-0 top-0 z-20 flex items-center gap-2 rounded-xl bg-primary px-3 py-2 shadow-lg ring-1 ring-primary/35"
      >
        <TrendingUp className="size-[18px] shrink-0 text-primary-foreground" strokeWidth={2.5} />
        <span className="h-0.5 w-5 shrink-0 rounded-full bg-primary-foreground/95" />
      </div>

      <div className="absolute bottom-0 left-1/2 z-[15] w-[min(216px,100%)] -translate-x-1/2">
        <div className="absolute bottom-[52px] left-1/2 z-10 w-[94%] -translate-x-1/2 scale-[0.94] rounded-lg border border-white/10 bg-muted/35 p-2.5 opacity-[0.46] shadow-sm">
          <RollRowGraphic tone="back" />
        </div>
        <div className="absolute bottom-[26px] left-1/2 z-20 w-[97%] -translate-x-1/2 rounded-lg border border-white/18 bg-muted/70 p-2.5 opacity-[0.92] shadow-md ring-1 ring-white/12">
          <RollRowGraphic tone="mid" />
        </div>
        <div
          ref={frontCardRef}
          className="relative z-30 rounded-lg border-2 border-primary bg-background p-2.5 shadow-xl ring-1 ring-primary/20"
        >
          <RollRowGraphic />
        </div>
      </div>
    </div>
  );
}

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {(open: boolean) => void} props.onOpenChange
 * @param {() => void} props.onUploadAnother
 * @param {"one" | "three"} [props.milestonePhase] — `one`: first-roll highlight; `three`: first + second rows use primary highlight (after 3 rolls).
 */
export function FirstRollWatchNudgeSheet({ open, onOpenChange, onUploadAnother, milestonePhase = "one" }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        aria-labelledby="first-roll-nudge-title"
        overlayClassName="z-[520] bg-black/80 duration-500 ease-out data-open:animate-in data-open:fade-in-0"
        className={cnSheet()}
      >
        <div className="mx-auto mb-0.5 h-1.5 w-11 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden />

        <RollBuildIllustration />

        <div className="w-full max-w-md space-y-2 px-0.5 text-center">
          <h2 id="first-roll-nudge-title" className="text-xl font-semibold leading-snug tracking-tight text-foreground">
            Build your game.
          </h2>
          <p className="text-pretty text-[15px] leading-relaxed text-muted-foreground">
            Patterns in your game begin to emerge when you upload three or more rolls.
          </p>
        </div>

        <ul className="flex w-full max-w-md flex-col gap-2 self-center" aria-label="Roll milestones">
          <li className="rounded-lg border border-primary bg-black/20 px-3.5 py-2 text-left">
            <p className="text-[15px] leading-snug text-primary">
              <span className="font-semibold">1 roll</span>
              <span className="text-primary/80"> → </span>
              <span className="font-normal text-primary/90">isolated analysis and guidance</span>
            </p>
          </li>
          <li
            className={
              milestonePhase === "three"
                ? "rounded-lg border border-primary bg-black/20 px-3.5 py-2 text-left"
                : "rounded-lg bg-white/[0.11] px-3.5 py-2 text-left ring-1 ring-white/10"
            }
          >
            <p
              className={
                milestonePhase === "three" ? "text-[15px] leading-snug text-primary" : "text-[15px] leading-snug"
              }
            >
              <span className={milestonePhase === "three" ? "font-semibold text-primary" : "font-semibold text-foreground"}>
                3 rolls
              </span>
              <span className={milestonePhase === "three" ? "text-primary/80" : "text-muted-foreground"}> → </span>
              <span
                className={
                  milestonePhase === "three" ? "font-normal text-primary/90" : "font-normal text-muted-foreground"
                }
              >
                trends and patterns begin to emerge
              </span>
            </p>
          </li>
          <li className="rounded-lg bg-white/[0.11] px-3.5 py-2 text-left ring-1 ring-white/10">
            <p className="text-[15px] leading-snug">
              <span className="font-semibold text-foreground">5 rolls</span>
              <span className="text-muted-foreground"> → </span>
              <span className="text-muted-foreground">Understand your game</span>
            </p>
          </li>
        </ul>

        <div className="mt-1 flex w-full max-w-md flex-col gap-3 self-center pt-1">
          <Button
            type="button"
            variant="default"
            className="h-auto w-full rounded-lg bg-primary px-6 py-3 text-base font-semibold text-white shadow-sm transition-all duration-300 hover:bg-primary/92 hover:shadow-md focus-visible:ring-1 focus-visible:ring-primary/25"
            onClick={() => {
              onUploadAnother();
            }}
          >
            Upload another roll
          </Button>
          <button
            type="button"
            className="w-full py-2.5 text-[15px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => onOpenChange(false)}
          >
            Not now
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function cnSheet() {
  return cn(
    "dark z-[530] flex max-h-[min(72dvh,680px)] w-full flex-col gap-7 overflow-y-auto rounded-t-2xl border-none",
    "!bg-[#1C1C1C]",
    "px-5 pb-[max(1.5rem,env(safe-area-inset-bottom,0px))] pt-3",
    "items-center shadow-2xl",
    "text-foreground",
    "!duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] data-open:slide-in-from-bottom-8",
    "outline-none"
  );
}
