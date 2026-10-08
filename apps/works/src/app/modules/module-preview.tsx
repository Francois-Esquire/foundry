import { useQuery } from "@tanstack/react-query";
import { type ChangeEvent, useCallback, useState } from "react";
import { worksApi } from "~/app/api/client";
import { Button } from "~/app/components/button";
import type { ModuleRelease } from "~/shared/modules";

function ModulePreviewSession({
  id,
  contentId,
}: {
  id: string;
  contentId: string;
}) {
  const [viewId, setViewId] = useState<string>();
  const preview = useQuery(
    worksApi().runtime.start.experimental_liveOptions({
      gcTime: 0,
      input: { contentId, id },
      retry: false,
    })
  );
  const changeView = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      setViewId(event.currentTarget.value),
    []
  );
  const view =
    preview.data?.views.find((candidate) => candidate.id === viewId) ??
    preview.data?.views[0];
  if (preview.error) {
    return (
      <p className="p-6 text-sm" role="alert">
        {preview.error.message}
      </p>
    );
  }
  if (!(preview.data && view)) {
    return (
      <p className="p-6 text-muted-foreground text-sm">Starting preview…</p>
    );
  }
  return (
    <>
      {preview.data.views.length > 1 && (
        <div className="px-4 py-2">
          <label className="sr-only" htmlFor="preview-view">
            View
          </label>
          <select
            className="rounded bg-background text-xs"
            id="preview-view"
            onChange={changeView}
            value={view.id}
          >
            {preview.data.views.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.title ?? candidate.id}
              </option>
            ))}
          </select>
        </div>
      )}
      <iframe
        className="min-h-0 w-full flex-1 rounded-b-xl bg-white"
        sandbox="allow-scripts allow-same-origin"
        src={`${preview.data.origin}${view.path}`}
        title={view.title ?? "Module preview"}
      />
    </>
  );
}

export function ModulePreviewPanel({
  id,
  releases,
  initialContentId,
}: {
  id: string;
  releases: ModuleRelease[];
  initialContentId?: string;
}) {
  const [selection, setSelection] = useState<string | undefined>(
    initialContentId
  );
  const [started, setStarted] = useState(!!initialContentId);
  const contentId = selection ?? releases[0]?.contentId ?? "";
  const release = releases.find(
    (candidate) => candidate.contentId === contentId
  );
  const changeRelease = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    setStarted(false);
    setSelection(event.currentTarget.value);
  }, []);
  const toggle = useCallback(() => setStarted((current) => !current), []);
  let notice = "This release has no views.";
  if (releases.length === 0) {
    notice =
      "Build a release to preview this module’s views. You can also import a released package.";
  } else if (release?.views.length) {
    notice =
      "Start a preview to open this release’s views. App data stays on this device.";
  }
  return (
    <section
      aria-label="Preview"
      className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-border/40"
    >
      <div className="flex flex-wrap items-center gap-3 border-border/40 border-b px-4 py-3">
        <h2 className="font-medium text-xs">Preview</h2>
        {releases.length > 0 && (
          <>
            <label className="sr-only" htmlFor="preview-release">
              Release
            </label>
            <select
              className="min-w-0 rounded bg-background text-xs"
              id="preview-release"
              onChange={changeRelease}
              value={contentId}
            >
              {releases.map((candidate) => (
                <option key={candidate.contentId} value={candidate.contentId}>
                  {candidate.tag}
                </option>
              ))}
            </select>
            <Button
              className="ml-auto"
              disabled={!release?.views.length}
              onClick={toggle}
              size="sm"
              variant="outline"
            >
              {started ? "Stop preview" : "Start preview"}
            </Button>
          </>
        )}
      </div>
      {started && release ? (
        <ModulePreviewSession contentId={contentId} id={id} key={contentId} />
      ) : (
        <p className="m-auto p-6 text-muted-foreground text-sm">{notice}</p>
      )}
    </section>
  );
}
