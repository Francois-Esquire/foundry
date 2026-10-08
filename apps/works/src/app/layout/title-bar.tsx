import type { CSSProperties, ReactNode } from "react";
import { WindowControls } from "~/app/layout/window-controls";
import { cn } from "~/app/lib/cn";
import {
  ThemeSelector,
  ThemeSelectorCompact,
} from "~/app/theme/theme-selector";

const DRAG = { WebkitAppRegion: "drag" } as CSSProperties;
const NO_DRAG = { WebkitAppRegion: "no-drag" } as CSSProperties;

export interface TitleBarProps {
  actions?: ReactNode;
  className?: string;
  logo: ReactNode;
  onClose: () => void;
  onMaximize?: () => void;
  onMinimize: () => void;
}

export function TitleBar({
  logo,
  actions,
  onMinimize,
  onClose,
  onMaximize,
  className,
}: TitleBarProps) {
  return (
    // `@container/titlebar` lets the right cluster collapse to compact forms
    // off the bar's own width (the window), not the OS viewport.
    <div
      className={cn(
        "@container/titlebar flex h-9 w-full shrink-0 items-center px-3",
        className
      )}
      style={DRAG}
    >
      <div className="flex items-center gap-2">{logo}</div>

      <div className="flex-1" />

      <div className="flex items-center gap-1" style={NO_DRAG}>
        {actions}

        {actions ? <div className="mx-1 h-3.5 w-px bg-border" /> : null}

        <div className="@2xl/titlebar:block hidden">
          <ThemeSelector />
        </div>
        <div className="@2xl/titlebar:hidden">
          <ThemeSelectorCompact />
        </div>

        <div className="mx-1 h-3.5 w-px bg-border" />

        <WindowControls
          onClose={onClose}
          onMaximize={onMaximize}
          onMinimize={onMinimize}
        />
      </div>
    </div>
  );
}
