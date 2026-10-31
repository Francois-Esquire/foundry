import { useQuery } from "@tanstack/react-query";
import { type ChangeEvent, useCallback, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { worksApi } from "~/app/api/client";
import { boundViewUrl } from "~/app/artifacts/open-editor";
import { Button } from "~/app/components/button";
import type { ModuleAppEvent } from "~/shared/modules";

function statusOf(state: ModuleAppEvent | undefined): string {
  if (state?.phase === "building") {
    return `Preparing your module… ${state.step}`;
  }
  if (state?.phase === "restarting") {
    return "Restarting your module with its updated access…";
  }
  return "Opening your module…";
}

export function ModuleAppPage() {
  const { moduleId = "" } = useParams<{ moduleId: string }>();
  // An entry opened from Artifacts names its editor View and the binding
  // the View is opened with.
  const [search] = useSearchParams();
  const binding = search.get("binding");
  const details = useQuery(
    worksApi().modules.details.queryOptions({ input: { id: moduleId } })
  );
  const opened = useQuery(
    worksApi().runtime.open.experimental_liveOptions({
      gcTime: 0,
      input: { id: moduleId },
      retry: false,
    })
  );
  const retry = useCallback(() => opened.refetch(), [opened.refetch]);
  const state = opened.data;
  const error =
    opened.error?.message ??
    (state?.phase === "failed" ? state.message : undefined);
  const app = state?.phase === "ready" ? state.app : undefined;
  const [viewId, setViewId] = useState(search.get("view") ?? undefined);
  const changeView = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      setViewId(event.currentTarget.value),
    []
  );
  const view =
    app?.views.find((candidate) => candidate.id === viewId) ?? app?.views[0];
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
      {error ? (
        <div className="m-auto max-w-lg p-6 text-sm" role="alert">
          <p className="whitespace-pre-wrap">{error}</p>
          <Button className="mt-4" onClick={retry} variant="outline">
            Try again
          </Button>
        </div>
      ) : null}
      {!error && app && view && (
        <iframe
          className="min-h-0 w-full flex-1 bg-white"
          sandbox="allow-scripts allow-same-origin"
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
