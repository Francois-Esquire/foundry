import type { ReactNode } from "react";
import { LayoutProvider, SubNavSlot } from "~/app/layout/context";
import { Sidebar } from "~/app/layout/sidebar";
import { TitleBar } from "~/app/layout/title-bar";
import { cn } from "~/app/lib/cn";

export interface MainLayoutProps {
  bottomNav: ReactNode;
  children: ReactNode;
  className?: string;
  logo: ReactNode;
  /** Module nav items, rendered in their own scrollable band. */
  moduleNav?: ReactNode;
  onClose: () => void;
  onMaximize?: () => void;
  onMinimize: () => void;
  titleBarActions?: ReactNode;
  topNav: ReactNode;
}

export function MainLayout({
  logo,
  titleBarActions,
  topNav,
  moduleNav,
  bottomNav,
  onMinimize,
  onClose,
  onMaximize,
  children,
  className,
}: MainLayoutProps) {
  return (
    <LayoutProvider>
      <div className="h-screen bg-background p-1">
        <div
          className={cn(
            "relative isolate flex h-full flex-col overflow-hidden rounded-xl",
            "border border-border/40 bg-background text-foreground",
            className
          )}
        >
          <TitleBar
            actions={titleBarActions}
            className="relative z-10"
            logo={logo}
            onClose={onClose}
            onMaximize={onMaximize}
            onMinimize={onMinimize}
          />

          <div className="flex min-h-0 min-w-0 flex-1">
            <Sidebar
              bottomNav={bottomNav}
              className="relative z-10"
              moduleNav={moduleNav}
              topNav={topNav}
            />

            <div className="relative z-0 flex min-h-0 min-w-0 flex-1 pb-1">
              <SubNavSlot className="relative z-10" />
              <div className="relative isolate z-0 min-w-0 flex-1">
                {children}
              </div>
            </div>
          </div>
        </div>
      </div>
    </LayoutProvider>
  );
}
