import { Panel } from "~/components/ui/panel";
import { SelectableRow } from "~/components/ui/selectable-row";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import type { LogEntry } from "~/model/log";

export interface LogLine<T> {
  readonly entry: T;
  readonly id: string;
  readonly level: LogEntry["level"];
  readonly location: string;
  readonly message: string;
  readonly timestamp: string;
}

interface LogFilterSummary {
  readonly follow: boolean;
  readonly level: string;
  readonly query: string;
  readonly source: string;
}

function shown(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  return timestamp.includes("T") && !Number.isNaN(parsed)
    ? new Date(parsed).toLocaleTimeString()
    : timestamp;
}

export function LogsBlock<T>({
  active,
  lines,
  total,
  filters,
  selectedId,
  onSelect,
}: {
  readonly active: boolean;
  readonly lines: readonly LogLine<T>[];
  readonly total: number;
  readonly filters: LogFilterSummary;
  readonly selectedId?: string;
  readonly onSelect: (entry: T) => void;
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
        selectedId={selectedId === undefined ? undefined : `log:${selectedId}`}
        title="Logs · runs and Marbles"
      >
        {lines.length === 0 && (
          <Text>
            {total === 0
              ? "No logs recorded yet. Runs' log() lines and Marbles' own status appear here."
              : "No lines match these filters."}
          </Text>
        )}
        {lines.map((line) => (
          <SelectableRow
            id={`log:${line.id}`}
            key={line.id}
            onSelect={onSelect}
            selected={selectedId === line.id}
            value={line.entry}
          >
            <text
              fg={theme.colors.mutedForeground}
              flexShrink={0}
              wrapMode="none"
            >
              {shown(line.timestamp)}
            </text>
            <text fg={colors[line.level]} flexShrink={0} wrapMode="none">
              [{line.level}]
            </text>
            <text
              fg={theme.colors.mutedForeground}
              flexShrink={0}
              wrapMode="none"
            >
              {line.location}
            </text>
            <Text>{line.message}</Text>
          </SelectableRow>
        ))}
      </Panel>
    </box>
  );
}
