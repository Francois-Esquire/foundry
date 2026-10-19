import "./chrome.css";
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from "react";
import { MapMode } from "./chrome-entries";
import { CompassSidebar } from "./compass-sidebar";
import { MapKey } from "./map-key";
import { SheetHandle } from "./sheet-handle";
import type { SpyglassState } from "./spyglass-state";
import { useSheet } from "./use-sheet";
import type { useSpyglassState } from "./use-spyglass-state";

type Sheet = "Spyglass" | "Legend";

function LegendIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
      width="20"
    >
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4" cy="6" r="1" />
      <path d="M3 11h2v2H3zM3 18h2" />
    </svg>
  );
}

export function SpyglassShell({
  state,
  actions,
  children,
}: {
  state: SpyglassState;
  actions: Omit<ReturnType<typeof useSpyglassState>, "state">;
  children: ReactNode;
}) {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarTrigger = useRef<HTMLButtonElement>(null);
  const openSidebar = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    sidebarTrigger.current = event.currentTarget;
    setSidebarOpen(true);
  }, []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const close = useCallback(() => setSheet(null), []);
  const dialog = useSheet(sheet !== null, close, trigger);
  const choose = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const name = event.currentTarget.value;
    if (name === "Spyglass" || name === "Legend") {
      trigger.current = event.currentTarget;
      setSheet(name);
    }
  }, []);
  return (
    <main className="spyglass-shell">
      <div className="spyglass-world">{children}</div>
      <CompassSidebar
        context={{ actions, state }}
        onClose={closeSidebar}
        onOpen={openSidebar}
        open={sidebarOpen}
        opener={sidebarTrigger}
      />
      <nav aria-label="Spyglass controls" className="spyglass-bottom-bar">
        <button
          aria-controls="spyglass-sheet"
          aria-expanded={sheet === "Spyglass"}
          aria-haspopup="dialog"
          aria-label="Spyglass"
          className="spyglass-brand"
          onClick={choose}
          type="button"
          value="Spyglass"
        >
          Spyglass
        </button>
        <MapMode actions={actions} state={state} />
        <button
          aria-controls="spyglass-sheet"
          aria-expanded={sheet === "Legend"}
          aria-haspopup="dialog"
          aria-label="Legend"
          onClick={choose}
          type="button"
          value="Legend"
        >
          <LegendIcon />
          <span>Legend</span>
        </button>
      </nav>
      <dialog
        aria-labelledby="spyglass-sheet-title"
        className="spyglass-sheet"
        id="spyglass-sheet"
        ref={dialog}
      >
        <SheetHandle onClose={close} />
        <header className="spyglass-sheet-header">
          <h1 id="spyglass-sheet-title">{sheet}</h1>
          <button aria-label="Close sheet" onClick={close} type="button">
            Close
          </button>
        </header>
        <div className="spyglass-sheet-body">
          {sheet === "Spyglass" && (
            <div className="spyglass-sheet-intro">
              <p className="spyglass-chrome-eyebrow">
                A field guide to your code
              </p>
              <p>A map of your workspace.</p>
            </div>
          )}
          {sheet === "Legend" && <MapKey state={state} />}
        </div>
      </dialog>
    </main>
  );
}
