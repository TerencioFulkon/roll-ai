import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * Generic empty-state shell — decorative illustration + title + description + optional CTA.
 * Illustration is rendered as given; callers pass `aria-hidden` illustrations for decoration.
 *
 * @param {object} props
 * @param {React.ReactNode} props.illustration
 * @param {string} props.title
 * @param {string} props.description
 * @param {{ label: string, onClick: () => void } | null} [props.action]
 * @param {string} [props.className]
 */
export function EmptyState({ illustration, title, description, action = null, className }) {
  return (
    <div className={cn("mt-12 flex flex-col items-center gap-8 text-center", className)}>
      {illustration}
      <div className="flex max-w-[280px] flex-col gap-2">
        <h3 className="text-lg font-semibold tracking-tight text-foreground">{title}</h3>
        <p className="text-sm leading-normal text-muted-foreground">{description}</p>
      </div>
      {action ? (
        <Button
          type="button"
          onClick={action.onClick}
          className="h-auto rounded-lg bg-primary px-6 py-3 text-base font-semibold text-primary-foreground shadow-sm transition-all duration-300 hover:scale-[1.02] hover:bg-primary/92 hover:shadow-md focus-visible:ring-1 focus-visible:ring-primary/25"
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
