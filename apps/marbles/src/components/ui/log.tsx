// Adapted from termcn's OpenTUI Log.
import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import { Text } from "~/components/ui/text";
import { useTheme } from "~/hooks/use-theme";

export interface LogEntry {
  readonly id: string;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly stepId?: string;
  readonly timestamp: string;
}

export function Log({
  entries,
  focused,
  height = 6,
}: {
  readonly entries: readonly LogEntry[];
  readonly focused: boolean;
  readonly height?: number;
}) {
  const theme = useTheme();
  const [offset, setOffset] = useState(0);
  const [follow, setFollow] = useState(false);
  const max = Math.max(0, entries.length - height);
  const start = follow ? max : Math.min(offset, max);
  useKeyboard((key) => {
    if (!focused) {
      return;
    }
    if (key.name === "f") {
      setOffset(start);
      setFollow((value) => !value);
    }
    if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      setOffset(
        Math.max(0, Math.min(max, start + (key.name === "down" ? 1 : -1)))
      );
      setFollow(false);
    }
  });
  const colors = {
    debug: theme.colors.mutedForeground,
    error: theme.colors.error,
    info: theme.colors.info,
    warn: theme.colors.warning,
  };
  return (
    <box flexDirection="column" flexShrink={0}>
      {entries.length === 0 && <Text>No logs recorded.</Text>}
      {entries.slice(start, start + height).map((entry) => (
        <text fg={colors[entry.level]} key={entry.id}>
          {entry.timestamp} [{entry.level}] {entry.message}
        </text>
      ))}
      <text fg={theme.colors.mutedForeground}>
        {entries.length ? start + 1 : 0}–
        {Math.min(start + height, entries.length)}/{entries.length} ·{" "}
        {follow ? "Following" : "Paused"} · f follow · ↑↓ scroll
      </text>
    </box>
  );
}
