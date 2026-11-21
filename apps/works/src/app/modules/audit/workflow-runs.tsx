import { useMemo } from "react";
import { type AuditRun, isWorkflowRun, runModule } from "~/shared/audit";
import {
  AuditRow,
  AuditTable,
  Outcome,
  progressText,
  StatusText,
  Time,
} from "./audit-table";
import { ModuleLink, type Names, RunLink } from "./scope";

export function WorkflowRuns({
  names,
  runs,
}: {
  names: Names;
  runs: readonly AuditRun[];
}) {
  const rows = useMemo(() => runs.filter(isWorkflowRun), [runs]);
  return (
    <AuditTable
      caption="Workflow runs"
      count={rows.length}
      empty="No workflow runs in this scope and time range."
      headers={[
        "Workflow",
        "Module",
        "Status",
        "Progress",
        "Queued",
        "Ended",
        "Outcome",
        "Run",
      ]}
    >
      {rows.map((row) => (
        <AuditRow key={row.id}>
          <td className="font-mono text-xs">{row.name}</td>
          <td>
            <ModuleLink id={runModule(row)} names={names} />
          </td>
          <td>
            <StatusText status={row.status} />
          </td>
          <td>{progressText(row.progress)}</td>
          <td>
            <Time value={row.timestamps.queuedAt} />
          </td>
          <td>
            <Time value={row.timestamps.settledAt} />
          </td>
          <td>
            <Outcome run={row} />
          </td>
          <td>
            <RunLink id={row.id} />
          </td>
        </AuditRow>
      ))}
    </AuditTable>
  );
}
