import { useQuery } from "@tanstack/react-query";
import { ArrowLeftIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { worksApi } from "~/app/api/client";
import { Button } from "~/app/components/button";
import { ModuleWorkspace } from "~/app/modules/module-workspace";

export function ModuleManagementPage() {
  const { moduleId = "" } = useParams<{ moduleId: string }>();
  const details = useQuery(
    worksApi().modules.details.queryOptions({
      input: { id: moduleId },
      refetchOnMount: "always",
    })
  );
  const [loadedId, setLoadedId] = useState<string>();
  useEffect(() => {
    if (details.data && !details.isFetching) {
      setLoadedId(moduleId);
    }
  }, [details.data, details.isFetching, moduleId]);
  const refresh = useCallback(async () => {
    const result = await details.refetch();
    if (!result.data || result.error) {
      throw result.error ?? new Error("Module could not be refreshed");
    }
    return result.data;
  }, [details.refetch]);
  const retry = useCallback(() => details.refetch(), [details.refetch]);
  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-4 px-6 py-3">
        <Link
          className="flex items-center gap-1.5 text-muted-foreground text-xs"
          to="/modules"
        >
          <ArrowLeftIcon className="size-3" />
          Modules
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold text-sm">
            {details.data?.name ?? moduleId}
          </h1>
        </div>
        <Link
          className="text-muted-foreground text-xs hover:text-foreground"
          to={`/m/${encodeURIComponent(moduleId)}`}
        >
          Open app
        </Link>
      </header>
      {details.error && (
        <div className="mx-6 mb-3" role="alert">
          <p>{details.error.message}</p>
          <Button onClick={retry} variant="outline">
            Try again
          </Button>
        </div>
      )}
      {!details.error && loadedId !== moduleId && (
        <p className="px-6 text-muted-foreground text-sm">Loading source…</p>
      )}
      {details.data && loadedId === moduleId && (
        <ModuleWorkspace
          details={details.data}
          key={moduleId}
          refresh={refresh}
        />
      )}
    </div>
  );
}
