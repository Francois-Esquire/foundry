import type { ReactNode } from "react";
import { cn } from "~/app/lib/cn";

/**
 * Shared container for sub-nav side panels. The nested borders with a 2px gap
 * give the subtle double-border frame; both layers stay here so every side
 * panel matches.
 */
export function SidePanel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="flex h-full w-56 shrink-0 flex-col p-2">
      <div className="flex h-full min-h-0 flex-col rounded-xl border border-border/60 p-0.5">
        <div
          className={cn(
            "flex h-full min-h-0 flex-col overflow-hidden rounded-[0.625rem] border border-border/30",
            className
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/** Eyebrow label on the left, optional actions on the right, no bottom rule. */
export function SidePanelHeader({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-11 shrink-0 items-center justify-between px-3">
      <span className="font-medium text-[0.6875rem] text-muted-foreground/70 uppercase tracking-[0.12em]">
        {title}
      </span>
      {children ? (
        <div className="flex items-center gap-0.5">{children}</div>
      ) : null}
    </div>
  );
}
