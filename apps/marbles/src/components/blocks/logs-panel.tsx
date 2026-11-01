import { Panel } from "~/components/ui/panel";
import { SelectableRow } from "~/components/ui/selectable-row";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import type { LogsState } from "~/views/dashboard-state";
import type { OperatingLogEntry } from "~/views/operating-model";

/** Local time for an ISO timestamp; anything else as it was recorded. */
function shown(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  return timestamp.includes("T") && !Number.isNaN(parsed)
    ? new Date(parsed).toLocaleTimeString()
    : timestamp;
}

function where(entry: OperatingLogEntry): string {
  if (entry.source === "host") {
    return "marbles";
  }
  if (entry.setup) {
    return `${entry.runId ?? ""} setup`;
  }
  return entry.stepId ? `${entry.runId} ${entry.stepId}` : (entry.runId ?? "");
}

/**
 * Every run's log lines and Marbles' own, oldest first, filtered by level,
 * source and search. The selected line can open its run.
 */
export function LogsBlock({
  active,
  lines,
  total,
  filters,
  selected,
  onSelect,
}: {
  readonly active: boolean;
  readonly lines: readonly OperatingLogEntry[];
  /** Lines before filtering, to say how many the filters hide. */
  readonly total: number;
  readonly filters: LogsState;
  readonly selected?: OperatingLogEntry;
  readonly onSelect: (entry: OperatingLogEntry) => void;
}) {
  const colors = {
    debug: theme.colors.mutedForeground,
    error: theme.colors.error,
    info: theme.colors.info,
    warn: theme.colors.warning,
  };
  const hidden = total - lines.length;
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <text fg={theme.colors.mutedForeground} wrapMode="none">
        {lines.length} of {total} lines · level {filters.level}+ · source{" "}
        {filters.source}
        {filters.query ? ` · search "${filters.query}"` : ""}
        {hidden > 0 ? " · x shows all" : ""} ·{" "}
        {filters.follow ? "Following" : "Paused"}
      </text>
      <Panel
        active={active}
        id="panel:logs"
        selectedId={selected && `log:${selected.id}`}
        title="Logs · runs and Marbles"
      >
        {lines.length === 0 && (
          <Text>
            {total === 0
              ? "No logs recorded yet. Runs' log() lines and Marbles' own status appear here."
              : "No lines match these filters."}
          </Text>
        )}
        {lines.map((entry) => (
          <SelectableRow
            id={`log:${entry.id}`}
            key={entry.id}
            onSelect={onSelect}
            selected={selected?.id === entry.id}
            value={entry}
          >
            <text
              fg={theme.colors.mutedForeground}
              flexShrink={0}
              wrapMode="none"
            >
              {shown(entry.timestamp)}
            </text>
            <text fg={colors[entry.level]} flexShrink={0} wrapMode="none">
              [{entry.level}]
            </text>
            <text
              fg={theme.colors.mutedForeground}
              flexShrink={0}
              wrapMode="none"
            >
              {where(entry)}
            </text>
            <Text>{entry.message}</Text>
          </SelectableRow>
        ))}
      </Panel>
    </box>
  );
}
