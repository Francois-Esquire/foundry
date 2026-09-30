import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef } from "react";

export type PanelSection = "place" | "find" | "chart" | "wrecks";

export interface PanelTab {
  content: ReactNode;
  id: PanelSection;
  label: string;
  /** Stay mounted while hidden so loaded evidence and layout survive. */
  persistent?: boolean;
}

/** The single side panel: one section at a time, chosen from a tab strip. */
export function AtlasPanel({
  tabs,
  section,
  open,
  focusToken,
  onSection,
  onClose,
}: {
  tabs: PanelTab[];
  section: PanelSection;
  open: boolean;
  focusToken: number;
  onSection: (section: PanelSection) => void;
  onClose: () => void;
}) {
  const active = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Find focuses its own input; every other section lands on its tab.
    if (focusToken && section !== "find") {
      active.current?.focus();
    }
  }, [focusToken, section]);
  const handleKey = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const index = tabs.findIndex((tab) => tab.id === section);
      const step = keyStep(event.key, index, tabs.length);
      if (step === null) {
        return;
      }
      event.preventDefault();
      const next = tabs[step];
      if (next) {
        onSection(next.id);
      }
    },
    [tabs, section, onSection]
  );
  const handleTab = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const next = tabs.find((tab) => tab.id === event.currentTarget.value);
      if (next) {
        onSection(next.id);
      }
    },
    [tabs, onSection]
  );
  return (
    <aside
      aria-label="Atlas panel"
      className="atlas-panel"
      hidden={!open}
      id="atlas-panel"
    >
      <div className="atlas-panel-bar">
        <div
          aria-label="Panel sections"
          className="atlas-panel-tabs"
          onKeyDown={handleKey}
          role="tablist"
        >
          {tabs.map((tab) => (
            <button
              aria-controls={`atlas-section-${tab.id}`}
              aria-selected={tab.id === section}
              id={`atlas-tab-${tab.id}`}
              key={tab.id}
              onClick={handleTab}
              ref={tab.id === section ? active : undefined}
              role="tab"
              tabIndex={tab.id === section ? 0 : -1}
              type="button"
              value={tab.id}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <button
          aria-label="Close panel"
          className="atlas-panel-close"
          onClick={onClose}
          type="button"
        >
          Close
        </button>
      </div>
      {tabs.map((tab) =>
        tab.persistent || (open && tab.id === section) ? (
          <div
            aria-labelledby={`atlas-tab-${tab.id}`}
            className="atlas-panel-body"
            hidden={tab.id !== section}
            id={`atlas-section-${tab.id}`}
            key={tab.id}
            role="tabpanel"
          >
            {tab.content}
          </div>
        ) : null
      )}
    </aside>
  );
}

function keyStep(key: string, index: number, count: number): number | null {
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
