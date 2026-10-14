import {
  type ChangeEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { AtlasState } from "./atlas-state";
import { ChartSettingsPanel } from "./chart-settings-panel";
import { MapKey } from "./map-key";
import type { useAtlasState } from "./use-atlas-state";

export interface AtlasShellHandle {
  openSettings: () => void;
}
type Sheet = "Atlas" | "Legend" | "Rendering";

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

export function AtlasShell({
  state,
  actions,
  children,
  ref,
}: {
  state: AtlasState;
  actions: Omit<ReturnType<typeof useAtlasState>, "state">;
  children: ReactNode;
  ref?: Ref<AtlasShellHandle>;
}) {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const dialog = useRef<HTMLDialogElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const renderingButton = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setSheet(null), []);
  const openSettings = useCallback(() => {
    trigger.current = renderingButton.current;
    setSheet("Rendering");
  }, []);
  useImperativeHandle(ref, () => ({ openSettings }), [openSettings]);
  useEffect(() => {
    if (sheet) {
      dialog.current?.showModal();
    } else {
      dialog.current?.close();
      trigger.current?.focus();
    }
  }, [sheet]);
  const choose = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const name = event.currentTarget.value;
    if (name === "Atlas" || name === "Legend" || name === "Rendering") {
      trigger.current = event.currentTarget;
      setSheet(name);
    }
  }, []);
  const cancel = useCallback(
    (event: SyntheticEvent<HTMLDialogElement>) => {
      event.preventDefault();
      close();
    },
    [close]
  );
  const keepFocus = useCallback((event: KeyboardEvent) => {
    if (event.key !== "Tab") {
      return;
    }
    const sheetElement = event.currentTarget;
    if (!(sheetElement instanceof HTMLDialogElement)) {
      return;
    }
    const elements = [
      ...sheetElement.querySelectorAll<HTMLElement>(
        "button, input, select, textarea, summary, a[href]"
      ),
    ].filter((element) => {
      const collapsed = element.closest("details:not([open])");
      return (
        !(element.matches(":disabled") || element.closest("[hidden]")) &&
        (!collapsed || collapsed.querySelector("summary") === element)
      );
    });
    const [first] = elements;
    const last = elements.at(-1);
    const atEdge = document.activeElement === (event.shiftKey ? first : last);
    if (atEdge) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    }
  }, []);
  useEffect(() => {
    const element = dialog.current;
    element?.addEventListener("keydown", keepFocus);
    return () => element?.removeEventListener("keydown", keepFocus);
  }, [keepFocus]);
  const zoomOut = useCallback(
    () => actions.scene.current?.zoom(1 / 1.35),
    [actions.scene]
  );
  const zoomIn = useCallback(
    () => actions.scene.current?.zoom(1.35),
    [actions.scene]
  );
  const whole = useCallback(
    () => actions.scene.current?.focus(null),
    [actions.scene]
  );
  const layer = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      actions.mapLayer(
        event.currentTarget.value === "files" ? "files" : "belonging"
      ),
    [actions.mapLayer]
  );
  return (
    <main className="atlas-shell">
      <div className="atlas-world">{children}</div>
      <nav aria-label="Atlas controls" className="atlas-bottom-bar">
        {(["Atlas", "Legend", "Rendering"] as const).map((name) => (
          <button
            aria-controls="atlas-sheet"
            aria-expanded={sheet === name}
            aria-haspopup="dialog"
            aria-label={name}
            className={name === "Atlas" ? "atlas-brand" : undefined}
            key={name}
            onClick={choose}
            ref={name === "Rendering" ? renderingButton : undefined}
            type="button"
            value={name}
          >
            {name === "Atlas" ? (
              name
            ) : (
              <>
                <BarIcon name={name} />
                {sheet === name && <span>{name}</span>}
              </>
            )}
          </button>
        ))}
      </nav>
      <dialog
        aria-labelledby="atlas-sheet-title"
        className="atlas-sheet"
        id="atlas-sheet"
        onCancel={cancel}
        ref={dialog}
      >
        <div aria-hidden="true" className="atlas-sheet-handle" />
        <header className="atlas-sheet-header">
          <h1 id="atlas-sheet-title">{sheet}</h1>
          <button aria-label="Close sheet" onClick={close} type="button">
            Close
          </button>
        </header>
        <div className="atlas-sheet-body">
          {sheet === "Atlas" && (
            <p className="atlas-sheet-intro">A map of your workspace.</p>
          )}
          {sheet === "Legend" && <MapKey settings={state.chartSettings} />}
          {sheet === "Rendering" && (
            <>
              <fieldset className="atlas-camera-controls">
                <legend>Map view</legend>
                <button onClick={zoomOut} type="button">
                  Zoom out
                </button>
                <button onClick={whole} type="button">
                  Whole atlas
                </button>
                <button onClick={zoomIn} type="button">
                  Zoom in
                </button>
                <label>
                  Map layer
                  <select onChange={layer} value={state.mapLayer}>
                    <option value="belonging">Belonging</option>
                    <option value="files">Files</option>
                  </select>
                </label>
              </fieldset>
              <ChartSettingsPanel
                developer
                layoutPending={
                  state.chartSettings.coastalBuffer !==
                    state.layoutSettings.coastalBuffer ||
                  state.chartSettings.islandClearance !==
                    state.layoutSettings.islandClearance
                }
                onChange={actions.settings}
                onReset={actions.reset}
                scene={actions.scene}
                settings={state.chartSettings}
              />
            </>
          )}
        </div>
      </dialog>
    </main>
  );
}
