import { useQuery } from "@tanstack/react-query";
import { type ChangeEvent, useCallback, useEffect, useState } from "react";
import {
  type BlockerFunction,
  Link,
  useBlocker,
  useParams,
  useSearchParams,
} from "react-router";
import { worksApi } from "~/app/api/client";
import { boundViewUrl } from "~/app/artifacts/open-editor";
import { Button } from "~/app/components/button";
import {
  guardsEditorFrame,
  useEditorFrameState,
} from "~/app/modules/editor-frame-state";
import type { ModuleAppEvent, ModuleSession } from "~/shared/modules";

function statusOf(state: ModuleAppEvent | undefined): string {
  if (state?.phase === "building") {
    return `Preparing your module… ${state.step}`;
  }
  if (state?.phase === "restarting") {
    return "Restarting your module with its updated access…";
  }
  return "Opening your module…";
}

function readyApp(
  state: ModuleAppEvent | undefined
): ModuleSession | undefined {
  return state?.phase === "ready" ? state.app : undefined;
}

/** Only an unguarded editor may automatically adopt a different runtime. */
function nextDisplayedApp(
  current: ModuleSession | undefined,
  displayed: ModuleSession | undefined,
  guarded: boolean
): ModuleSession | undefined {
  if (!current) {
    return undefined;
  }
  if (!displayed) {
    return current;
  }
  if (!guarded && current.origin !== displayed.origin) {
    return current;
  }
  return undefined;
}

function lostDisplayedRuntime(
  displayed: ModuleSession | undefined,
  current: ModuleSession | undefined
): boolean {
  return !!displayed && displayed.origin !== current?.origin;
}

export function ModuleAppPage() {
  const { moduleId = "" } = useParams<{ moduleId: string }>();
  const [search] = useSearchParams();
  // An approved route change is a new editor, not the retained old frame.
  return <ModuleAppSession key={`${moduleId}?${search.toString()}`} />;
}

function ModuleAppSession() {
  const { moduleId = "" } = useParams<{ moduleId: string }>();
  // An entry opened from Artifacts names its editor View and the binding
  // the View is opened with.
  const [search] = useSearchParams();
  const binding = search.get("binding");
  // The release an opened entry's binding is for; otherwise the newest.
  const release = search.get("release");
  const details = useQuery(
    worksApi().modules.details.queryOptions({ input: { id: moduleId } })
  );
  const opening = worksApi().runtime.open.experimental_liveOptions({
    gcTime: 0,
    input: release ? { id: moduleId, release } : { id: moduleId },
    retry: false,
  });
  // A new binding must not display a cached endpoint whose old watcher is
  // stopping. The approved route owns a fresh live-query lifetime.
  const opened = useQuery({
    ...opening,
    queryKey: [...opening.queryKey, { binding, view: search.get("view") }],
  });
  const retry = useCallback(() => opened.refetch(), [opened.refetch]);
  const state = opened.data;
  const error =
    opened.error?.message ??
    (state?.phase === "failed" ? state.message : undefined);
  const currentApp = readyApp(state);
  // Runtime revocation stops the Program immediately. Keep its already-loaded
  // View in memory until unsaved work is resolved; this retains no authority.
  const [displayedApp, setDisplayedApp] = useState<ModuleSession>();
  const app = displayedApp ?? currentApp;
  const [viewId, setViewId] = useState(search.get("view") ?? undefined);
  const view =
    app?.views.find((candidate) => candidate.id === viewId) ?? app?.views[0];
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const editorState = useEditorFrameState(frame, {
    binding,
    origin: app?.origin ?? "",
    view: view?.id ?? "",
  });
  const guarded = guardsEditorFrame(editorState);
  const replacement = nextDisplayedApp(currentApp, displayedApp, guarded);
  if (replacement) {
    setDisplayedApp(replacement);
  }
  const runtimeChanged = lostDisplayedRuntime(displayedApp, currentApp);
  // Leaving the View unmounts its frame and whatever it has not saved.
  const leaves = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) =>
      guarded &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
    [guarded]
  );
  const blocker = useBlocker(leaves);
  useEffect(() => {
    if (!guarded) {
      return;
    }
    // Closing or quitting asks main first, before anything shuts down.
    const warn = (unload: BeforeUnloadEvent) => unload.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [guarded]);
  const [pendingView, setPendingView] = useState<string>();
  const changeView = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const next = event.currentTarget.value;
      if (guarded) {
        setPendingView(next);
      } else {
        setViewId(next);
      }
    },
    [guarded]
  );
  const asking = blocker.state === "blocked" || pendingView !== undefined;
  const stay = useCallback(() => {
    setPendingView(undefined);
    blocker.reset?.();
  }, [blocker]);
  const leave = useCallback(() => {
    if (pendingView !== undefined) {
      setViewId(pendingView);
      setPendingView(undefined);
    }
    blocker.proceed?.();
  }, [blocker, pendingView]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 px-6 py-3">
        <h1 className="min-w-0 flex-1 truncate font-semibold text-sm">
          {details.data?.name ?? "Opening module…"}
        </h1>
        {app && app.views.length > 1 && (
          <>
            <label className="sr-only" htmlFor="module-app-view">
              View
            </label>
            <select
              className="rounded bg-background text-xs"
              id="module-app-view"
              onChange={changeView}
              value={view?.id}
            >
              {app.views.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.title ?? candidate.id}
                </option>
              ))}
            </select>
          </>
        )}
        <Link
          className="text-muted-foreground text-xs hover:text-foreground"
          to={`/modules/${encodeURIComponent(moduleId)}`}
        >
          Manage module
        </Link>
      </header>
      {asking && (
        <div
          aria-label="Unsaved changes"
          className="mx-6 mb-3 flex items-center gap-3 rounded-lg border border-border/60 px-4 py-3 text-xs"
          role="alertdialog"
        >
          <p className="mr-auto">
            {editorState === "dirty"
              ? "This editor has unsaved changes. Leaving closes it."
              : "This editor may have unsaved changes. Leaving closes it."}
          </p>
          <Button onClick={stay} size="sm" variant="outline">
            Stay
          </Button>
          <Button onClick={leave} size="sm" variant="ghost">
            Leave anyway
          </Button>
        </div>
      )}
      {runtimeChanged && (
        <p className="mx-6 mb-3 text-sm" role="status">
          This editor's runtime stopped or changed access. Your open edits are
          kept here, but this view cannot save through the stopped runtime. Keep
          or copy your work before leaving, then reopen the file from Artifacts
          to reconnect.
        </p>
      )}
      {error ? (
        <div className="m-auto max-w-lg p-6 text-sm" role="alert">
          <p className="whitespace-pre-wrap">{error}</p>
          <Button className="mt-4" onClick={retry} variant="outline">
            Try again
          </Button>
        </div>
      ) : null}
      {app && view && (
        <iframe
          className="min-h-0 w-full flex-1 bg-white"
          ref={setFrame}
          // Client-side submit handlers need forms enabled. The proxy's
          // form-action 'none' still forbids native form navigation.
          sandbox="allow-scripts allow-same-origin allow-forms"
          src={boundViewUrl(app.origin, view.path, binding)}
          title={view.title ?? details.data?.name ?? "Module app"}
        />
      )}
      {!(error || app) && (
        <p className="m-auto p-6 text-muted-foreground text-sm" role="status">
          {statusOf(state)}
        </p>
      )}
    </div>
  );
}
