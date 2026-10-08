import { useQuery } from "@tanstack/react-query";
import { ArrowLeftIcon } from "lucide-react";
import { type MouseEvent, useCallback, useState } from "react";
import { Link, useParams } from "react-router";
import { worksApi } from "~/app/api/client";
import { Button } from "~/app/components/button";
import { SubNav } from "~/app/layout/context";
import { SidePanel, SidePanelHeader } from "~/app/layout/side-panel";
import { ModulePreviewPanel } from "./module-preview";

export function ModuleWorkspacePage() {
  const { moduleId = "" } = useParams<{ moduleId: string }>();
  const details = useQuery(
    worksApi().modules.details.queryOptions({ input: { id: moduleId } })
  );
  const [selected, setSelected] = useState<string>();
  const source = details.data?.source ?? {};
  const paths = Object.keys(source).sort();
  const path =
    selected && Object.hasOwn(source, selected) ? selected : paths[0];
  const selectFile = useCallback(
    (event: MouseEvent<HTMLButtonElement>) =>
      setSelected(event.currentTarget.dataset.file),
    []
  );
  const retryDetails = useCallback(() => {
    details.refetch().catch(() => undefined);
  }, [details.refetch]);
  return (
    <div className="flex h-full flex-col">
      <SubNav>
        <SidePanel>
          <SidePanelHeader title="Files" />
          <div className="space-y-1 px-2 py-3">
            {paths.map((file) => (
              <button
                aria-pressed={file === path}
                className="block w-full truncate rounded px-3 py-2 text-left text-xs hover:bg-muted aria-pressed:bg-muted"
                data-file={file}
                key={file}
                onClick={selectFile}
                type="button"
              >
                {file}
              </button>
            ))}
            {details.isPending && (
              <p className="px-3 text-muted-foreground text-xs">
                Loading files…
              </p>
            )}
            {details.data && paths.length === 0 && (
              <p className="px-3 text-muted-foreground text-xs">
                This release has no authored source.
              </p>
            )}
          </div>
        </SidePanel>
      </SubNav>
      <header className="flex shrink-0 items-center gap-4 px-6 py-3">
        <Link
          className="flex items-center gap-1.5 text-muted-foreground text-xs"
          to="/"
        >
          <ArrowLeftIcon className="size-3" />
          Modules
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold text-sm">
            {details.data?.name ?? moduleId}
          </h1>
          <p className="mt-1 text-muted-foreground text-xs">{moduleId}</p>
        </div>
        <span className="text-muted-foreground text-xs">Source overview</span>
      </header>
      {details.error && (
        <div className="mx-6 mb-3" role="alert">
          <p>{details.error.message}</p>
          <Button onClick={retryDetails} variant="outline">
            Try again
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 gap-2 px-2 pb-2">
        <section
          aria-label="Editor"
          className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-border/40"
        >
          <h2 className="border-border/40 border-b px-4 py-3 font-medium text-xs">
            {path ?? "Source"}
          </h2>
          <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed">
            {path ? source[path] : "No file selected"}
          </pre>
        </section>
        <ModulePreviewPanel
          id={moduleId}
          key={moduleId}
          releases={details.data?.releases ?? []}
        />
      </div>
    </div>
  );
}
