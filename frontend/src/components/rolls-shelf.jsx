import { Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatRollListDate, formatVideoDurationClock } from "@/lib/roll-display";
import { cn } from "@/lib/utils";

/**
 * @typedef {{ kind: "heading"; key: string; label: string; isFirst: boolean }} RollsHeading
 * @typedef {{ kind: "roll"; roll: object; rowIndex: number }} RollsRollEntry
 * @typedef {RollsHeading | RollsRollEntry} RollsSectionItem
 */

/**
 * @param {RollsSectionItem[]} items
 * @returns {Array<{ heading: RollsHeading; rolls: RollsRollEntry[] }>}
 */
function groupRollShelfSections(items) {
  /** @type {Array<{ heading: RollsHeading; rolls: RollsRollEntry[] }>} */
  const groups = [];
  /** @type {RollsHeading | null} */
  let currentHeading = null;
  /** @type {RollsRollEntry[]} */
  let buffer = [];

  const flush = () => {
    if (currentHeading) {
      groups.push({ heading: currentHeading, rolls: buffer });
    }
    buffer = [];
  };

  for (const item of items) {
    if (item.kind === "heading") {
      flush();
      currentHeading = item;
    } else {
      buffer.push(item);
    }
  }
  flush();
  return groups;
}

/**
 * @param {object} props
 * @param {object} props.roll
 * @param {number} props.rowIndex
 * @param {(jobId: string) => void} props.onSelect
 */
export function RollShelfCard({ roll, rowIndex, onSelect }) {
  const [posterFailed, setPosterFailed] = useState(false);

  const posterRaw =
    typeof roll.thumbnail_url === "string" && roll.thumbnail_url.trim() !== ""
      ? roll.thumbnail_url.trim()
      : null;
  const poster = posterFailed ? null : posterRaw;

  useEffect(() => {
    setPosterFailed(false);
  }, [posterRaw]);

  const rawDur = roll.duration_seconds;
  const sec =
    typeof rawDur === "number"
      ? rawDur
      : rawDur != null && `${rawDur}`.trim() !== ""
        ? Number(rawDur)
        : NaN;
  const durationLabel = formatVideoDurationClock(sec);

  const dateLabel = formatRollListDate(roll.completed_at || roll.created_at || "");

  const metaLine = [dateLabel, durationLabel].filter(Boolean).join(" · ");

  const fetchPriority = rowIndex < 8 ? "high" : "low";

  return (
    <button
      type="button"
      onClick={() => onSelect(roll.job_id)}
      aria-label={`Watch ${roll.title}${metaLine ? `, ${metaLine}` : ""}`}
      className={cn(
        "group relative isolate aspect-video w-full max-w-full overflow-hidden rounded-2xl text-left shadow-md",
        "bg-black outline-none ring-1 ring-white/15 transition-[transform,opacity,box-shadow] duration-200",
        "hover:opacity-95 hover:ring-white/25 focus-visible:ring-2 focus-visible:ring-primary/45 active:scale-[0.99]"
      )}
    >
      {poster ? (
        <img
          src={poster}
          alt=""
          aria-hidden
          draggable={false}
          loading={rowIndex < 4 ? "eager" : "lazy"}
          decoding="async"
          fetchPriority={fetchPriority}
          onError={() => setPosterFailed(true)}
          className="pointer-events-none absolute inset-0 z-0 h-full w-full scale-110 object-cover opacity-90 blur-3xl saturate-125"
        />
      ) : (
        <div className="pointer-events-none absolute inset-0 z-0 bg-gradient-to-br from-zinc-800 via-zinc-900 to-black" aria-hidden />
      )}

      <div className="pointer-events-none absolute inset-0 z-[1] bg-black/28" aria-hidden />

      {poster ? (
        <img
          src={poster}
          alt=""
          draggable={false}
          loading={rowIndex < 4 ? "eager" : "lazy"}
          decoding="async"
          fetchPriority={fetchPriority}
          onError={() => setPosterFailed(true)}
          className="pointer-events-none absolute inset-0 z-[2] h-full w-full bg-black object-cover"
        />
      ) : (
        <div className="pointer-events-none absolute inset-0 z-[2] flex h-full w-full items-center justify-center bg-zinc-950/80">
          <span className="text-sm font-medium text-white/50">No preview</span>
        </div>
      )}

      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 z-[3] bg-gradient-to-t from-black/92 via-black/45 to-transparent pt-20 pb-3 pl-3 pr-3 sm:pb-3.5 sm:pl-4 sm:pr-4"
        aria-hidden
      >
        <h3 className="line-clamp-2 text-[15px] font-semibold leading-snug tracking-tight text-white drop-shadow-[0_1px_3px_rgb(0_0_0/0.85)]">
          {roll.title}
        </h3>
        {metaLine ? (
          <p className="mt-1 text-[13px] leading-snug text-white/88 tabular-nums drop-shadow-[0_1px_2px_rgb(0_0_0/0.75)]">
            {metaLine}
          </p>
        ) : null}
      </div>

      <div className="pointer-events-none absolute top-2 right-2 z-[4] sm:top-3 sm:right-3" aria-hidden>
        <span className="flex size-9 items-center justify-center rounded-full bg-black/55 text-white shadow-md ring-1 ring-white/35 backdrop-blur-sm">
          <Play className="ml-0.5 size-4 fill-white stroke-transparent text-white opacity-95" strokeWidth={0} />
        </span>
      </div>
    </button>
  );
}

/**
 * Stacked widescreen shelf cards grouped by calendar heading.
 *
 * @param {object} props
 * @param {RollsSectionItem[]} props.sectionItems
 * @param {(jobId: string) => void} props.onSelectRoll
 */
export function RollsShelf({ sectionItems, onSelectRoll }) {
  const groups = useMemo(() => groupRollShelfSections(sectionItems), [sectionItems]);

  return (
    <ul className="flex flex-col gap-0 p-0" aria-label="Your narrated rolls">
      {groups.map(({ heading, rolls }, gi) => (
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
            {rolls.map((entry) => (
              <li key={entry.roll.job_id} className="list-none">
                <RollShelfCard roll={entry.roll} rowIndex={entry.rowIndex} onSelect={onSelectRoll} />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
