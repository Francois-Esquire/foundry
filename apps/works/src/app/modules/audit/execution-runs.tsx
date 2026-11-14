import { type ChangeEvent, useMemo } from "react";
import {
  type AuditRun,
  failedSaveAttempt,
  runLabel,
  runModule,
} from "~/shared/audit";
import {
  AuditRow,
  AuditTable,
  Outcome,
  progressText,
  StatusText,
  Time,
} from "./audit-table";
import { ModuleLink, type Names, RunLink } from "./scope";

export function ExecutionRuns({
  attempts,
  highlighted,
  names,
  onAttempts,
  runs,
}: {
  attempts: boolean;
  highlighted: string | null;
  names: Names;
  onAttempts: (event: ChangeEvent<HTMLInputElement>) => void;
  runs: readonly AuditRun[];
}) {
  // Why each save run committed nothing, worked out once per run.
  const rows = useMemo(
    () =>
      runs
        .map((run) => ({ attempt: failedSaveAttempt(run), run }))
        .filter((row) => !attempts || row.attempt !== null),
    [attempts, runs]
  );
  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm">
        <input checked={attempts} onChange={onAttempts} type="checkbox" />
        Failed save attempts only
      </label>
      <AuditTable
        caption={attempts ? "Failed save attempts" : "Execution runs"}
        count={rows.length}
        empty={
          attempts
            ? "No failed save attempts in this scope and time range."
            : "No runs in this scope and time range."
        }
        headers={[
          "Run",
          "Module",
          "Queue",
          "Status",
          "Progress",
          "Queued",
          "Ended",
          "Outcome",
          "Related",
        ]}
      >
        {rows.map(({ attempt, run }) => (
          <ExecutionRow
            attempt={attempt}
            highlighted={run.id === highlighted}
            key={run.id}
            names={names}
            run={run}
          />
        ))}
      </AuditTable>
    </div>
  );
}

function ExecutionRow({
  attempt,
  highlighted,
  names,
  run,
}: {
  attempt: string | null;
  highlighted: boolean;
  names: Names;
  run: AuditRun;
}) {
  const { agentSessionId, parentRunId } = run.correlation;
  return (
    <AuditRow highlighted={highlighted}>
      <td>
        {runLabel(run)}
        <span className="block font-mono text-muted-foreground text-xs">
          {run.id}
        </span>
      </td>
      <td>
        <ModuleLink id={runModule(run)} names={names} />
      </td>
      <td className="font-mono text-xs">{run.queue}</td>
      <td>
        <StatusText status={run.status} />
        {attempt !== null && (
          <span className="block text-muted-foreground text-xs">
            Not saved: {attempt}
          </span>
        )}
      </td>
      <td>{progressText(run.progress)}</td>
      <td>
        <Time value={run.timestamps.queuedAt} />
      </td>
      <td>
        <Time value={run.timestamps.settledAt} />
      </td>
      <td>
        <Outcome run={run} />
      </td>
      <td className="text-xs">
        {agentSessionId !== undefined && (
          <span className="block">
            Agent Session {agentSessionId.slice(0, 8)}
          </span>
        )}
        {parentRunId !== undefined && (
          <span className="block">
            Started by <RunLink id={parentRunId} />
          </span>
        )}
      </td>
    </AuditRow>
  );
}
