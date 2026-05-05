import { useMemo } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RollShelfCard } from "@/components/rolls-shelf";
import { getRollDateSectionHeading } from "@/lib/roll-display";
import { cn } from "@/lib/utils";

/** @typedef {{ job_id: string, status: string, created_at: string | null, completed_at: string | null }} SessionJobRow */

const STAGE_FALLBACK = {
  pending: "Queued for processing",
  processing: "Analysing your roll",
  generating_audio: "Recording coach audio",
  stitching_video: "Finalising narrated video",
  uploading: "Uploading",
  queued: "Queued for processing"
};

/**
 * @param {SessionJobRow[]} sessionJobs
 * @param {Map<string, object>} completedByJobId
 * @param {Record<string, { status?: string, progress?: string }>} liveByJobId
 * @param {Record<string, string>} failedErrors
 */
function buildSessionJobSectionItems(sessionJobs, completedByJobId, liveByJobId, failedErrors) {
  /** @type {Array<
   *   | { kind: "heading"; key: string; label: string; isFirst: boolean }
   *   | { kind: "complete"; roll: object; rowIndex: number }
   *   | { kind: "complete_loading"; jobId: string; rowIndex: number }
   *   | { kind: "processing"; job: SessionJobRow; rowIndex: number; live?: { status?: string; progress?: string } }
   *   | { kind: "failed"; job: SessionJobRow; rowIndex: number; errorMessage: string }
   * >} */
  const items = [];
  let lastSectionKey = /** @type {string | null} */ (null);
  let rowIndex = 0;

  for (const job of sessionJobs) {
    const iso = job.completed_at || job.created_at || "";
    const { key: sectionKey, label } = getRollDateSectionHeading(iso);

    if (sectionKey !== lastSectionKey) {
      items.push({
        kind: "heading",
        key: sectionKey,
        label,
        isFirst: items.length === 0
      });
      lastSectionKey = sectionKey;
    }

    if (job.status === "complete") {
      const roll = completedByJobId.get(job.job_id);
      if (roll) {
        items.push({ kind: "complete", roll, rowIndex: rowIndex++ });
      } else {
        items.push({ kind: "complete_loading", jobId: job.job_id, rowIndex: rowIndex++ });
      }
    } else if (job.status === "failed") {
      items.push({
        kind: "failed",
        job,
        rowIndex: rowIndex++,
        errorMessage: failedErrors[job.job_id] || "We couldn't finish analysing this roll."
      });
    } else {
      items.push({
        kind: "processing",
        job,
        rowIndex: rowIndex++,
        live: liveByJobId[job.job_id]
      });
    }
  }

  return items;
}

/**
 * @param {object} props
 * @param {SessionJobRow[]} props.sessionJobs
 * @param {Map<string, object>} props.completedByJobId
 * @param {Record<string, { status?: string, progress?: string }>} props.liveByJobId
 * @param {Record<string, string>} props.failedErrors
 * @param {(jobId: string) => void} props.onSelectCompleteRoll
 * @param {() => void} props.onRetryFailed
 */
export function RollsTabJobsList({
  sessionJobs,
  completedByJobId,
  liveByJobId,
  failedErrors,
  onSelectCompleteRoll,
  onRetryFailed
}) {
  const sectionItems = useMemo(
    () => buildSessionJobSectionItems(sessionJobs, completedByJobId, liveByJobId, failedErrors),
    [sessionJobs, completedByJobId, liveByJobId, failedErrors]
  );

  /** @type {Array<{ heading: object, entries: typeof sectionItems }>} */
  const groups = useMemo(() => {
    /** @type {Array<{ heading: (typeof sectionItems)[number]; entries: typeof sectionItems }>} */
    const out = [];
    /** @type {typeof sectionItems} */
    let buf = [];
    /** @type {(typeof sectionItems)[number] | null} */
    let currentHeading = null;

    const flush = () => {
      if (currentHeading) {
        out.push({ heading: currentHeading, entries: buf });
      }
      buf = [];
    };

    for (const item of sectionItems) {
      if (item.kind === "heading") {
        flush();
        currentHeading = item;
      } else {
        buf.push(item);
      }
    }
    flush();
    return out;
  }, [sectionItems]);

  return (
    <ul className="flex flex-col gap-0 p-0" aria-label="Your rolls">
      {groups.map(({ heading, entries }, gi) => (
        <li key={`${heading.key}-${gi}`} className="list-none">
          <p
            className={cn(
              "mb-3 text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground",
              heading.isFirst ? "scroll-mt-4" : "mt-8 scroll-mt-6"
            )}
          >
            {heading.label}
          </p>
          <ul className="flex flex-col gap-4 p-0">
            {entries.map((entry) => {
              if (entry.kind === "complete") {
                return (
                  <li key={entry.roll.job_id} className="list-none">
                    <RollShelfCard
                      roll={entry.roll}
                      rowIndex={entry.rowIndex}
                      onSelect={onSelectCompleteRoll}
                    />
                  </li>
                );
              }
              if (entry.kind === "complete_loading") {
                return (
                  <li key={entry.jobId} className="list-none">
                    <div
                      className="aspect-video w-full animate-pulse rounded-2xl bg-muted"
                      aria-hidden
                    />
                  </li>
                );
              }
              if (entry.kind === "processing") {
                const { job, live } = entry;
                const statusKey = live?.status || job.status;
                const line =
                  (typeof live?.progress === "string" && live.progress.trim() !== ""
                    ? live.progress
                    : STAGE_FALLBACK[statusKey]) || STAGE_FALLBACK.processing;
                return (
                  <li key={job.job_id} className="list-none">
                    <div
                      className={cn(
                        "flex min-h-[120px] flex-col justify-center gap-3 rounded-2xl border border-border/60 bg-card px-4 py-4 shadow-sm"
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary">
                          <Loader2 className="size-5 animate-spin" aria-hidden />
                        </span>
                        <div className="min-w-0 flex-1 space-y-1">
                          <p className="text-base font-semibold leading-snug text-foreground">
                            Processing your roll
                          </p>
                          <p className="text-sm leading-relaxed text-muted-foreground">{line}</p>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              }
              if (entry.kind === "failed") {
                const { job, errorMessage } = entry;
                return (
                  <li key={job.job_id} className="list-none">
                    <div
                      className={cn(
                        "flex flex-col gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-4 shadow-sm"
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <AlertTriangle
                          className="mt-0.5 size-5 shrink-0 text-destructive"
                          aria-hidden
                        />
                        <div className="min-w-0 flex-1 space-y-1">
                          <p className="text-base font-semibold text-foreground">Analysis failed</p>
                          <p className="text-sm leading-relaxed text-muted-foreground">
                            {errorMessage}
                          </p>
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        className="h-auto w-full py-3 text-base font-semibold"
                        onClick={onRetryFailed}
                      >
                        Try again
                      </Button>
                    </div>
                  </li>
                );
              }
              return null;
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}
