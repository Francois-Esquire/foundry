import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { EditorSession } from "./session";
import { SheetEditor } from "./sheet-editor";

/**
 * The Sheets editor. It renders the session's snapshots and forwards the
 * user's choices; the session owns the workbook and every host request.
 * Whoever constructs the session starts and closes it.
 */
export function SheetsApp({ session }: { session: EditorSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const create = useCallback(() => session.create(), [session]);
  const loadNewer = useCallback(() => session.loadNewer(), [session]);
  const keepLocal = useCallback(() => session.keepLocal(), [session]);
  const takeSaved = useCallback(() => session.takeSaved(), [session]);

  useEffect(() => {
    if (!state.dirty) {
      return;
    }
    const prevent = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [state.dirty]);
  useEffect(() => {
    if (state.binding) {
      history.replaceState(
        null,
        "",
        `?binding=${encodeURIComponent(state.binding)}`
      );
    }
  }, [state.binding]);

  return (
    <main
      data-conflict={String(state.conflict)}
      data-dirty={String(state.dirty)}
      data-newer={String(state.newer)}
      data-ready={String(state.ready)}
      id="root-content"
    >
      <header>
        <h1>{state.name}</h1>
        <p id="status" role="status">
          {state.message}
        </p>
      </header>
      {!(state.workbook || state.binding) && (
        <section className="notice">
          <p>Open a workbook from Artifacts, or start a new one.</p>
          <button
            disabled={!state.ready || state.creating}
            onClick={create}
            type="button"
          >
            {state.creating ? "Creating…" : "New workbook"}
          </button>
        </section>
      )}
      {state.newer && (
        <section className="notice">
          <p>A newer version was saved elsewhere. Your edits are kept.</p>
          <button disabled={state.saving} onClick={loadNewer} type="button">
            Discard my edits and load it
          </button>
        </section>
      )}
      {state.conflict && (
        <section className="notice">
          <p>This workbook was saved elsewhere while you edited.</p>
          <button disabled={state.saving} onClick={keepLocal} type="button">
            Keep my version
          </button>
          <button disabled={state.saving} onClick={takeSaved} type="button">
            Use the saved version
          </button>
        </section>
      )}
      {state.workbook && (
        <SheetEditor
          dirty={state.dirty}
          saving={state.saving}
          session={session}
          view={state.workbook}
          writable={state.writable}
        />
      )}
    </main>
  );
}
