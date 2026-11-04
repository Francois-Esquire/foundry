import { type ChangeEvent, useCallback, useMemo } from "react";
import { Button } from "~/app/components/button";
import {
  type AuditFilter,
  type AuditState,
  runModule,
  scopedGaps,
  scopedRuns,
} from "~/shared/audit";
import { ArtifactSaves } from "./artifact-saves";
import { Calls } from "./calls";
import { Dashboard } from "./dashboard";
import { ExecutionRuns } from "./execution-runs";
import {
  RetentionNotice,
  ScopeControls,
  useAuditParams,
  useNames,
} from "./scope";
import { useExecutionAudit } from "./use-execution-audit";
import { WorkflowRuns } from "./workflow-runs";

export type AuditTab =
  | "calls"
  | "dashboard"
  | "executions"
  | "saves"
  | "workflows";

function moduleIdsOf(state: AuditState): string[] {
  const ids = new Set<string>();
  for (const run of state.runs.values()) {
    const id = runModule(run);
    if (id !== undefined) {
      ids.add(id);
    }
  }
  return [...ids];
}

/**
 * The Modules audit tabs: one live view of the engine run store, scoped by
 * Module and time range, read-only. Access changes stay in Catalog detail.
 */
export function ModulesAudit({ tab }: { tab: AuditTab }) {
  const { connection, error, retry, state } = useExecutionAudit();
  const { attempts, highlighted, moduleId, range, set, since } =
    useAuditParams();
  const names = useNames();
  const filter = useMemo<AuditFilter>(
    () => ({
      ...(moduleId === undefined ? {} : { moduleId }),
      ...(since === undefined ? {} : { since }),
    }),
    [moduleId, since]
  );
  // Scoped and sorted once per change, not on every render.
  const runs = useMemo(
    () => (state ? scopedRuns(state, filter) : []),
    [state, filter]
  );
  const moduleIds = useMemo(() => (state ? moduleIdsOf(state) : []), [state]);
  const changeModule = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      set("module", event.target.value === "" ? null : event.target.value),
    [set]
  );
  const changeRange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      set("range", event.target.value === "all" ? null : event.target.value),
    [set]
  );
  const changeAttempts = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      set("attempts", event.target.checked ? "1" : null),
    [set]
  );

  if (state === null) {
    if (connection === "failed" || connection === "reconnecting") {
      return (
        <div role="alert">
          <p className="text-sm">Activity could not be loaded. {error}</p>
          <Button className="mt-3" onClick={retry} variant="outline">
            Try again
          </Button>
        </div>
      );
    }
    return <p className="text-muted-foreground text-sm">Loading activity…</p>;
  }
  return (
    <div className="space-y-6">
      <ScopeControls
        moduleId={moduleId}
        moduleIds={moduleIds}
        names={names}
        onModule={changeModule}
        onRange={changeRange}
        range={range}
      />
      {connection === "reconnecting" && (
        <p className="text-muted-foreground text-sm" role="status">
          Reconnecting to the run store… The last activity received stays shown.
        </p>
      )}
      <RetentionNotice gaps={scopedGaps(state, filter)} names={names} />
      {tab === "dashboard" && <Dashboard names={names} runs={runs} />}
      {tab === "calls" && <Calls names={names} runs={runs} />}
      {tab === "workflows" && <WorkflowRuns names={names} runs={runs} />}
      {tab === "executions" && (
        <ExecutionRuns
          attempts={attempts}
          highlighted={highlighted}
          names={names}
          onAttempts={changeAttempts}
          runs={runs}
        />
      )}
      {tab === "saves" && <ArtifactSaves names={names} runs={runs} />}
    </div>
  );
}
