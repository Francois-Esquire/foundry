import {
  LayoutDashboardIcon,
  PanelsTopLeftIcon,
  SettingsIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Emblem } from "~/app/components/emblem";
import { MainLayout } from "~/app/layout/main-layout";
import { ModuleNav } from "~/app/layout/module-nav";
import { NavItem, type NavItemConfig } from "~/app/layout/nav-item";

const topNavItems: NavItemConfig[] = [
  { end: true, icon: LayoutDashboardIcon, label: "Home", to: "/" },
  { icon: PanelsTopLeftIcon, label: "Manage modules", to: "/modules" },
];

const bottomNavItems: NavItemConfig[] = [
  { end: true, icon: SettingsIcon, label: "Settings", to: "/settings" },
];

/** The preload bridge, or null when rendered outside Electron. */
function windowBridge() {
  return "worksWindow" in window ? window.worksWindow : null;
}

function closeWindow(): void {
  windowBridge()
    ?.close()
    .catch(() => undefined);
}

function minimizeWindow(): void {
  windowBridge()
    ?.minimize()
    .catch(() => undefined);
}

async function setFullscreenFromMode(): Promise<void> {
  const bridge = windowBridge();
  if (bridge === null) {
    return;
  }
  // Set, never toggle, on the wire: read the observed mode and say what
  // should be true, so an OS shortcut that already left fullscreen can't
  // leave this out of step.
  const mode = await bridge.mode();
  await bridge.setFullscreen(mode !== "fullscreen");
}

function toggleFullscreen(): void {
  setFullscreenFromMode().catch(() => undefined);
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <MainLayout
      bottomNav={bottomNavItems.map((item) => (
        <NavItem key={item.to} {...item} />
      ))}
      logo={
        <>
          <Emblem className="h-3.5 w-auto text-foreground/60" />
          <span className="font-semibold text-[0.6875rem] text-muted-foreground/60 uppercase tracking-[0.2em]">
            Works
          </span>
        </>
      }
      moduleNav={<ModuleNav />}
      onClose={closeWindow}
      onMaximize={toggleFullscreen}
      onMinimize={minimizeWindow}
      topNav={topNavItems.map((item) => <NavItem key={item.to} {...item} />)}
    >
      {children}
    </MainLayout>
  );
}
