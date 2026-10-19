import "./chrome.css";
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from "react";
import { CompassSidebar } from "./compass-sidebar";
import { MapKey } from "./map-key";
import { SheetHandle } from "./sheet-handle";
import type { SpyglassState } from "./spyglass-state";
import { useSheet } from "./use-sheet";
import type { useSpyglassState } from "./use-spyglass-state";

type Sheet = "Spyglass" | "Legend";

function BarIcon({ name }: { name: "Legend" | "Rendering" }) {
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
      {name === "Legend" ? (
        <>
          <path d="M9 6h11M9 12h11M9 18h11" />
          <circle cx="4" cy="6" r="1" />
          <path d="M3 11h2v2H3zM3 18h2" />
        </>
      ) : (
        <>
          <path d="M4 7h4m4 0h8M4 17h10m4 0h2" />
          <circle cx="10" cy="7" r="2" />
          <circle cx="16" cy="17" r="2" />
        </>
      )}
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
  const choose = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const name = event.currentTarget.value;
      if (name === "Rendering") {
        openSidebar(event);
      } else if (name === "Spyglass" || name === "Legend") {
        trigger.current = event.currentTarget;
        setSheet(name);
      }
    },
    [openSidebar]
  );
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
        {(["Spyglass", "Legend", "Rendering"] as const).map((name) => (
          <button
            aria-controls={
              name === "Rendering" ? "spyglass-sidebar" : "spyglass-sheet"
            }
            aria-expanded={name === "Rendering" ? sidebarOpen : sheet === name}
            aria-haspopup="dialog"
            aria-label={name}
            className={name === "Spyglass" ? "spyglass-brand" : undefined}
            key={name}
            onClick={choose}
            type="button"
            value={name}
          >
            {name === "Spyglass" ? (
              name
            ) : (
              <>
                <BarIcon name={name} />
                <span>{name}</span>
              </>
            )}
          </button>
        ))}
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
          {sheet === "Legend" && <MapKey settings={state.chartSettings} />}
        </div>
      </dialog>
    </main>
  );
}
