import { cn } from "@/lib/utils";

/**
 * Placeholder while session jobs are loading — avoids empty → list flicker.
 */
export function RollsTabSkeleton({ className }) {
  return (
    <div className={cn("flex flex-col gap-6", className)} aria-busy aria-label="Loading rolls">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-3">
          <div
            className={cn("h-3 w-28 animate-pulse rounded bg-muted", i === 0 ? "" : "mt-2")}
            aria-hidden
          />
          <div className="aspect-video w-full animate-pulse rounded-2xl bg-muted" aria-hidden />
        </div>
      ))}
    </div>
  );
}
