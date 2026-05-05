import { Building2, Clapperboard, LineChart } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "rolls", label: "Rolls", Icon: Clapperboard },
  { id: "progress", label: "Progress", Icon: LineChart },
  { id: "gym", label: "Gym", Icon: Building2 }
];

/**
 * Fixed bottom navigation — iOS safe-area aware.
 */
export function TabBar({ activeTab, onTabChange }) {
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 border-t border-neutral-200/90 bg-background/95 backdrop-blur-md supports-[backdrop-filter]:bg-background/80 dark:border-neutral-700/55"
      aria-label="Main"
      style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
    >
      <div className="mx-auto flex max-w-2xl items-end justify-around gap-0.5 px-1 pb-1 pt-2.5">
        {TABS.map(({ id, label, Icon }) => {
          const isActive = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              onTouchStart={(e) => {
                // Fire immediately on touch — bypasses iOS Safari's tap suppression
                // that blocks the first click after a scroll gesture.
                e.preventDefault();
                onTabChange(id);
              }}
              onClick={() => onTabChange(id)}
              className={cn(
                "flex min-h-[52px] min-w-0 flex-1 flex-col items-center justify-center gap-1 px-2 py-1 text-[11px] font-normal leading-tight outline-none transition-colors focus-visible:ring-1 focus-visible:ring-primary/25",
                isActive
                  ? "text-primary"
                  : "text-[#717171] hover:text-neutral-900 active:text-neutral-950 dark:text-neutral-400 dark:hover:text-neutral-200 dark:active:text-neutral-100"
              )}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon
                className="size-[22px] shrink-0"
                strokeWidth={isActive ? 1.65 : 1.25}
                aria-hidden
              />
              <span className="mt-px max-w-full truncate">{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
