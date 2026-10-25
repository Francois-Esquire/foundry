import {
  type KeyboardEvent,
  type MouseEvent,
  type MouseEventHandler,
  type RefObject,
  Suspense,
  useCallback,
  useState,
} from "react";
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
  active,
}: {
  entry: ChromeEntry;
  context: ChromeContext;
  active: boolean;
}) {
  const Content = entry.component;
  return (
    <section
      aria-labelledby={`spyglass-tab-${entry.id}`}
      className="spyglass-sidebar-section"
      hidden={!active}
      id={`spyglass-panel-${entry.id}`}
      role="tabpanel"
    >
      <header className="spyglass-sidebar-section-heading">
        <h2 id={`spyglass-section-${entry.id}`}>{entry.title}</h2>
        <p>{entry.description}</p>
      </header>
      <div className="spyglass-sidebar-section-body">
        <Suspense fallback={<p role="status">Opening tools…</p>}>
          {active && <Content {...context} />}
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
  const [selected, setSelected] = useState(entries[0]?.id);
  const active = entries.find((entry) => entry.id === selected) ?? entries[0];
  const select = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    setSelected(event.currentTarget.value);
  }, []);
  const navigate = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      const index = entries.findIndex(
        (entry) => entry.id === event.currentTarget.value
      );
      let next = index;
      if (event.key === "ArrowRight") {
        next = (index + 1) % entries.length;
      } else if (event.key === "ArrowLeft") {
        next = (index + entries.length - 1) % entries.length;
      } else if (event.key === "Home") {
        next = 0;
      } else if (event.key === "End") {
        next = entries.length - 1;
      } else {
        return;
      }
      event.preventDefault();
      const target = entries[next];
      if (target) {
        setSelected(target.id);
        document.getElementById(`spyglass-tab-${target.id}`)?.focus();
      }
    },
    [entries]
  );
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
        <fieldset
          aria-label="Chart actions"
          className="spyglass-sidebar-actions"
        >
          <button
            className="spyglass-settings-reset"
            onClick={context.actions.reset}
            type="button"
          >
            Reset visualization
          </button>
        </fieldset>
        <div
          aria-label="Chart control categories"
          className="spyglass-sidebar-tabs"
          role="tablist"
        >
          {entries.map((entry) => (
            <button
              aria-controls={`spyglass-panel-${entry.id}`}
              aria-selected={active?.id === entry.id}
              id={`spyglass-tab-${entry.id}`}
              key={entry.id}
              onClick={select}
              onKeyDown={navigate}
              role="tab"
              tabIndex={active?.id === entry.id ? 0 : -1}
              type="button"
              value={entry.id}
            >
              {entry.title}
            </button>
          ))}
        </div>
        <div className="spyglass-sidebar-body" key={active?.id}>
          {open &&
            entries.map((entry) => (
              <SidebarSection
                active={entry.id === active?.id}
                context={context}
                entry={entry}
                key={entry.id}
              />
            ))}
        </div>
        <footer className="spyglass-sidebar-footer">
          Distance expresses relationship
        </footer>
      </dialog>
    </>
  );
}
