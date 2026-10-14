import { useMemo } from "react";
import {
  type AuditRun,
  auditDashboard,
  runModule,
  type UsageTotal,
} from "~/shared/audit";
import { AuditRow, AuditTable, StatusText } from "./audit-table";
import type { Names } from "./scope";

function usageText(total: UsageTotal, turnCount: number): string {
  if (turnCount === 0) {
    return "No model turns";
  }
  if (total.unknownTurns === 0) {
    return total.known.toLocaleString();
  }
  if (total.known === 0) {
    return "Unknown";
  }
  const turns = total.unknownTurns === 1 ? "turn" : "turns";
  return `${total.known.toLocaleString()} known, unknown for ${String(total.unknownTurns)} ${turns}`;
}

export function Dashboard({
  names,
  runs,
}: {
  names: Names;
  runs: readonly AuditRun[];
}) {
  const dashboard = useMemo(() => auditDashboard(runs), [runs]);
  const gateway =
    dashboard.unrecordedGatewayCalls > 0
      ? `${dashboard.calls.gateway.toLocaleString()} listed, ${dashboard.unrecordedGatewayCalls.toLocaleString()} more counted`
      : dashboard.calls.gateway.toLocaleString();
  const stats: [string, string][] = [
    ["Runs", dashboard.runs.toLocaleString()],
    ["Model turns", dashboard.calls["model-turn"].toLocaleString()],
    ["Tool calls", dashboard.calls["tool-call"].toLocaleString()],
    ["Gateway calls", gateway],
    [
      "Input tokens",
      usageText(dashboard.usage.inputTokens, dashboard.coverage.turns),
    ],
    [
      "Output tokens",
      usageText(dashboard.usage.outputTokens, dashboard.coverage.turns),
    ],
    [
      "Total tokens",
      usageText(dashboard.usage.totalTokens, dashboard.coverage.turns),
    ],
    ["Cost", "Unknown — no provider reported cost"],
  ];
  const scope = [...new Set(runs.map(runModule))]
    .map((id) => names.module(id))
    .sort();
  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map(([label, value]) => (
          <div className="rounded-lg border border-border/60 p-3" key={label}>
            <dt className="text-muted-foreground text-xs">{label}</dt>
            <dd className="mt-1 font-medium text-sm">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-muted-foreground text-sm">
        Measurement coverage: {dashboard.coverage.measured} of{" "}
        {dashboard.coverage.turns} model{" "}
        {dashboard.coverage.turns === 1 ? "turn" : "turns"} reported token
        usage. Token counts come only from provider responses; missing counts
        stay unknown, never zero.
      </p>
      <AuditTable
        caption="Runs by kind"
        count={dashboard.byKind.length}
        empty="No runs in this scope and time range."
        headers={["Kind", "Runs"]}
      >
        {dashboard.byKind.map((row) => (
          <AuditRow key={row.label}>
            <td>{row.label}</td>
            <td>{row.count.toLocaleString()}</td>
          </AuditRow>
        ))}
      </AuditTable>
      <AuditTable
        caption="Runs by status"
        count={dashboard.byStatus.length}
        empty=""
        headers={["Status", "Runs"]}
      >
        {dashboard.byStatus.map((row) => (
          <AuditRow key={row.status}>
            <td>
              <StatusText status={row.status} />
            </td>
            <td>{row.count.toLocaleString()}</td>
          </AuditRow>
        ))}
      </AuditTable>
      {scope.length > 0 && (
        <p className="text-muted-foreground text-xs">
          Scope: {scope.join(", ")}
        </p>
      )}
    </div>
  );
}
