import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { worksApi } from "~/app/api/client";
import { Button } from "~/app/components/button";
import {
  type ModuleAccessRequestView,
  type ModuleAccessView,
  SCOPE_AREAS,
} from "~/shared/module-access";

const STATUS: Record<
  NonNullable<ModuleAccessView["installation"]>["status"],
  string
> = {
  active: "Running",
  disabled: "Stopped",
  failed: "Last start failed",
  starting: "Starting",
  stopping: "Stopping",
};

const NETWORK_NOTE =
  "Only HTTPS to these destinations is allowed. Approving or revoking network access stops and restarts the app if it is open.";

/** What happens to the app's own files when it stops. */
const PRIVATE_FILES = {
  installation: "Kept on this device between runs",
  none: "Discarded whenever the app stops. To keep it, set persistence.files to installation in foundry.module.json.",
} as const;

const BINDING_ONLY = "Only files opened for or created by this Module";

function requestName(request: ModuleAccessRequestView) {
  return request.kind === "network"
    ? "Network access"
    : (request.alias ?? request.capability);
}

function requestState(request: ModuleAccessRequestView) {
  if (request.approved) {
    return "Approved";
  }
  if (request.availability === "unknown") {
    return "Not available on this host";
  }
  if (request.availability === "denied") {
    return "Refused by this host";
  }
  return request.required ? "Needs approval to start" : "Not approved";
}

function RequestItem({
  request,
  busy,
  approve,
}: {
  request: ModuleAccessRequestView;
  busy: boolean;
  approve: (capability: string) => void;
}) {
  const name = requestName(request);
  const onApprove = useCallback(
    () => approve(request.capability),
    [approve, request.capability]
  );
  return (
    <li className="rounded-xl border border-border/40 p-3">
      <div className="flex items-center gap-2">
        <span className="mr-auto font-medium text-xs">{name}</span>
        <span className="text-muted-foreground text-xs">
          {request.required ? "Required" : "Optional"}
        </span>
      </div>
      <p className="mt-1 font-mono text-muted-foreground text-xs">
        {request.capability}@{request.version}
      </p>
      <p className="mt-1 text-xs">{request.reason}</p>
      {request.destinations && (
        <p className="mt-1 text-xs">
          Destinations: {request.destinations.join(", ")}
        </p>
      )}
      {request.scope && (
        <p className="mt-1 text-xs">
          {SCOPE_AREAS[request.scope.area]}: {request.scope.reaches.join(", ")}
        </p>
      )}
      {request.kind === "network" && (
        <p className="mt-1 text-muted-foreground text-xs">{NETWORK_NOTE}</p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <span className="mr-auto text-xs">{requestState(request)}</span>
        {!request.approved && request.availability === "available" && (
          <Button
            aria-label={`Approve ${name}`}
            disabled={busy}
            onClick={onApprove}
            size="xs"
          >
            Approve
          </Button>
        )}
      </div>
    </li>
  );
}

function GrantItem({
  grant,
  busy,
  revoke,
}: {
  grant: ModuleAccessView["grants"][number];
  busy: boolean;
  revoke: (capability: string) => void;
}) {
  const onRevoke = useCallback(
    () => revoke(grant.capability),
    [revoke, grant.capability]
  );
  return (
    <li className="flex items-center gap-2 py-1">
      <span className="mr-auto font-mono text-xs">
        {grant.capability}@{grant.version}
        {grant.current ? "" : " (not requested by this version)"}
      </span>
      {grant.kind === "network" && (
        <span className="text-muted-foreground text-xs">
          Revoking stops and restarts the app
        </span>
      )}
      <Button
        aria-label={`Revoke ${grant.capability}`}
        disabled={busy}
        onClick={onRevoke}
        size="xs"
        variant="destructive"
      >
        Revoke
      </Button>
    </li>
  );
}

/**
 * The Module's Access: what its Version requests, the Grants approved on its
 * Installation, and the scope they leave it. Approval and revocation happen
 * only here; a request in the Manifest grants nothing.
 */
export function ModuleAccessPanel({ moduleId }: { moduleId: string }) {
  const api = worksApi();
  const queryClient = useQueryClient();
  const queryKey = api.access.get.queryKey({ input: { id: moduleId } });
  const view = useQuery(
    api.access.get.queryOptions({ input: { id: moduleId } })
  );
  const update = {
    onSuccess: async (updated: ModuleAccessView) => {
      queryClient.setQueryData(queryKey, updated);
      // A network change restarts the app, which on/off shows.
      await queryClient.invalidateQueries({
        queryKey: api.power.get.queryKey({ input: { id: moduleId } }),
      });
    },
  };
  const approve = useMutation(api.access.approve.mutationOptions(update));
  const revoke = useMutation(api.access.revoke.mutationOptions(update));
  const busy = approve.isPending || revoke.isPending;
  const onApprove = useCallback(
    (capability: string) => approve.mutate({ capability, id: moduleId }),
    [approve.mutate, moduleId]
  );
  const onRevoke = useCallback(
    (capability: string) => revoke.mutate({ capability, id: moduleId }),
    [revoke.mutate, moduleId]
  );
  const retry = useCallback(() => {
    view.refetch().catch(() => undefined);
  }, [view.refetch]);
  const { data } = view;
  const error = approve.error ?? revoke.error;
  return (
    <section aria-labelledby="module-access-heading" className="min-w-0">
      <h2 className="font-medium text-sm" id="module-access-heading">
        Access
      </h2>
      <p className="mt-1 text-muted-foreground text-xs">
        A Module's requests grant nothing until you approve them here. Module
        settings never approve access.
      </p>
      {view.error && (
        <div className="mt-3 text-xs" role="alert">
          <p>{view.error.message}</p>
          <Button onClick={retry} size="xs" variant="outline">
            Try again
          </Button>
        </div>
      )}
      {view.isPending && (
        <p className="mt-3 text-muted-foreground text-xs">Loading access…</p>
      )}
      {data && (
        <>
          <p className="mt-3 text-xs">
            {data.version
              ? `Requests of version ${data.version.tag}`
              : "Build a release to review what it requests."}
            {data.installation ? ` · ${STATUS[data.installation.status]}` : ""}
          </p>
          <h3 className="mt-4 font-medium text-xs">Access scope</h3>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Files</dt>
            <dd>
              {data.scope.artifacts.length > 0
                ? `${BINDING_ONLY}, and every ${data.scope.artifacts.join(", ")} Artifact`
                : BINDING_ONLY}
            </dd>
            <dt className="text-muted-foreground">Workflows</dt>
            <dd>
              {data.scope.workflows.length > 0
                ? data.scope.workflows.join(", ")
                : "No workflows"}
            </dd>
            <dt className="text-muted-foreground">Network</dt>
            <dd>
              {data.scope.network.length > 0
                ? data.scope.network.join(", ")
                : "None"}
            </dd>
            {data.privateFiles && (
              <>
                <dt className="text-muted-foreground">App data</dt>
                <dd>{PRIVATE_FILES[data.privateFiles]}</dd>
              </>
            )}
          </dl>
          <h3 className="mt-4 font-medium text-xs">Requests</h3>
          {data.requests.length === 0 ? (
            <p className="mt-1 text-muted-foreground text-xs">
              This version requests no access.
            </p>
          ) : (
            <ul aria-label="Requests" className="mt-2 flex flex-col gap-2">
              {data.requests.map((request) => (
                <RequestItem
                  approve={onApprove}
                  busy={busy}
                  key={request.capability}
                  request={request}
                />
              ))}
            </ul>
          )}
          <h3 className="mt-4 font-medium text-xs">Grants</h3>
          {data.grants.length === 0 ? (
            <p className="mt-1 text-muted-foreground text-xs">
              Nothing is approved.
            </p>
          ) : (
            <ul aria-label="Grants" className="mt-1">
              {data.grants.map((grant) => (
                <GrantItem
                  busy={busy}
                  grant={grant}
                  key={grant.capability}
                  revoke={onRevoke}
                />
              ))}
            </ul>
          )}
        </>
      )}
      {error && (
        <p className="mt-3 text-destructive text-xs" role="alert">
          {error.message}
        </p>
      )}
    </section>
  );
}
