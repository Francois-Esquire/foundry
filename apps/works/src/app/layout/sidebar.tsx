import type { ReactNode } from "react";
import { TooltipProvider } from "~/app/components/tooltip";
import { cn } from "~/app/lib/cn";

// Thin, controlled scrollbar. Electron is Chromium, so the WebKit
// pseudo-elements are the lever that actually controls the width.
const THIN_SCROLLBAR =
  "[scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-foreground/15 [&::-webkit-scrollbar-thumb]:hover:bg-foreground/25";

/** A hairline that fades at both ends, reading as a crease in the rail. */
function Fold() {
  return (
    <div
      aria-hidden
      className="mx-auto my-1.5 h-px w-7 bg-gradient-to-r from-transparent via-foreground/15 to-transparent shadow-[0_1px_0_rgb(255_255_255/0.05)]"
    />
  );
}

export interface SidebarProps {
  bottomNav: ReactNode;
  className?: string;
  /**
   * Module nav items in their own band between the fixtures. Pass `null`
   * when there are none to drop the band and its folds. The band scrolls
   * when the window is too short.
   */
  moduleNav?: ReactNode;
  topNav: ReactNode;
}

export function Sidebar({
  topNav,
  moduleNav,
  bottomNav,
  className,
}: SidebarProps) {
  const hasModules = moduleNav !== null && moduleNav !== undefined;

  return (
    <TooltipProvider delayDuration={200}>
      <aside className={cn("flex w-12 shrink-0 flex-col", className)}>
        <div className="flex flex-col items-center gap-1.5 px-2 py-2">
          {topNav}
        </div>

        {hasModules ? <Fold /> : null}

        <nav
          aria-label="Modules"
          className={cn(
            "flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto overflow-x-hidden px-2 py-2",
            THIN_SCROLLBAR,
            "[-webkit-mask-image:linear-gradient(to_bottom,transparent,#000_0.75rem,#000_calc(100%_-_0.75rem),transparent)] [mask-image:linear-gradient(to_bottom,transparent,#000_0.75rem,#000_calc(100%_-_0.75rem),transparent)]"
          )}
        >
          {moduleNav}
        </nav>

        {hasModules ? <Fold /> : null}

        <div className="flex flex-col items-center gap-1.5 px-2 pb-2">
          {bottomNav}
        </div>
      </aside>
    </TooltipProvider>
  );
}
