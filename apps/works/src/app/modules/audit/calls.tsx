import { useMemo } from "react";
import { type AuditRun, type CallRow, callRows } from "~/shared/audit";
import {
  AuditRow,
  AuditTable,
  formatDuration,
  StatusText,
  Time,
} from "./audit-table";
import { ModuleLink, type Names, RunLink } from "./scope";

const CALL_KINDS: Readonly<Record<CallRow["kind"], string>> = {
  gateway: "Gateway",
  "model-turn": "Model turn",
  "tool-call": "Tool call",
};

function tokens(call: CallRow): string {
  if (call.kind !== "model-turn") {
    return "—";
  }
  const input = call.usage?.inputTokens;
  const output = call.usage?.outputTokens;
  if (input === undefined && output === undefined) {
    return "Unknown";
  }
  return `${input === undefined ? "?" : String(input)} in / ${output === undefined ? "?" : String(output)} out`;
}

export function Calls({
  names,
  runs,
}: {
  names: Names;
  runs: readonly AuditRun[];
}) {
  const rows = useMemo(() => callRows(runs), [runs]);
  return (
    <AuditTable
      caption="Calls"
      count={rows.length}
      empty="No calls recorded in this scope and time range."
      headers={[
        "Call",
        "Name",
        "Module",
        "Status",
        "Started",
        "Duration",
        "Tokens",
        "Run",
      ]}
    >
      {rows.map((row) => (
        <AuditRow key={row.id}>
          <td>{CALL_KINDS[row.kind]}</td>
          <td className="font-mono text-xs">
            {row.provider ? `${row.provider} · ${row.name}` : row.name}
          </td>
          <td>
            <ModuleLink id={row.moduleId} names={names} />
          </td>
          <td>
            <StatusText status={row.status} />
            {row.errorCode && (
              <span className="block text-muted-foreground text-xs">
                {row.errorCode}
              </span>
            )}
          </td>
          <td>
            <Time value={row.startedAt} />
          </td>
          <td>{formatDuration(row.durationMs)}</td>
          <td>{tokens(row)}</td>
          <td>
            <RunLink id={row.runId} />
          </td>
        </AuditRow>
      ))}
    </AuditTable>
  );
}
