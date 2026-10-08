import { cn } from "~/app/lib/cn";
import type { FieldSource } from "~/shared/vault";

const BADGES: Record<FieldSource, { dot?: string; label: string }> = {
  default: { label: "Default fallback" },
  env: { label: "Environment" },
  none: { dot: "bg-amber-400", label: "Not configured" },
  store: { dot: "bg-primary", label: "Custom" },
};

/** The small badge that says where a credential's value comes from. */
export function SourceBadge({
  className,
  source,
}: {
  className?: string;
  source: FieldSource;
}) {
  const badge = BADGES[source];
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 text-muted-foreground text-xs",
        className
      )}
    >
      {badge.dot ? (
        <span className={cn("size-[5px] shrink-0 rounded-full", badge.dot)} />
      ) : null}
      {badge.label}
    </span>
  );
}
