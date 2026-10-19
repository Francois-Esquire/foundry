import { type MouseEventHandler, type RefObject, Suspense } from "react";
import { ChartAppBar } from "./chart-app-bar";
import {
  type ChromeContext,
  type ChromeEntry,
  chromeEntries,
} from "./chrome-entries";
import { useSheet } from "./use-sheet";

function SidebarSection({
  entry,
  context,
}: {
  entry: ChromeEntry;
  context: ChromeContext;
}) {
  const Content = entry.component;
  return (
    <section
      aria-labelledby={`spyglass-section-${entry.id}`}
      className="spyglass-sidebar-section"
    >
      <header className="spyglass-sidebar-section-heading">
        <h2 id={`spyglass-section-${entry.id}`}>{entry.title}</h2>
        <p>{entry.description}</p>
      </header>
      <div className="spyglass-sidebar-section-body">
        <Suspense fallback={<p role="status">Opening tools…</p>}>
          <Content {...context} />
        </Suspense>
      </div>
    </section>
  );
}

/** One declarative registry supplies both reader and development sections. */
export function CompassSidebar({
  context,
  entries = chromeEntries,
  open,
  onOpen,
  onClose,
  opener,
}: {
  context: ChromeContext;
  entries?: readonly ChromeEntry[];
  open: boolean;
  onOpen: MouseEventHandler<HTMLButtonElement>;
  opener: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const dialog = useSheet(open, onClose, opener, "modeless");
  return (
    <>
      <ChartAppBar context={{ ...context, onOpen }} open={open} />
      <dialog
        aria-labelledby="spyglass-sidebar-title"
        className="spyglass-sidebar"
        id="spyglass-sidebar"
        ref={dialog}
      >
        <header className="spyglass-sidebar-header">
          <div>
            <p className="spyglass-chrome-eyebrow">The chart table</p>
            <h1 id="spyglass-sidebar-title">Chart controls</h1>
          </div>
          <button
            aria-label="Close chart controls"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </header>
        <div className="spyglass-sidebar-body">
          {open &&
            entries.map((entry) => (
              <SidebarSection context={context} entry={entry} key={entry.id} />
            ))}
        </div>
        <footer className="spyglass-sidebar-footer">
          Distance expresses relationship
        </footer>
      </dialog>
    </>
  );
}
