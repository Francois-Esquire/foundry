import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import type { LogEntry } from "~/model/log";
import { Text } from "./text";
import { theme } from "./theme";

export function Log({
  entries,
  focused,
  height = 6,
}: {
  readonly entries: readonly LogEntry[];
  readonly focused: boolean;
  readonly height?: number;
}) {
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
  if (entries.length === 0) {
    return <Text>No logs recorded.</Text>;
  }
  return (
    <box flexDirection="column" flexShrink={0}>
      {entries.slice(start, start + height).map((entry) => (
        <text fg={colors[entry.level]} key={entry.id}>
          {entry.timestamp} [{entry.level}] {entry.message}
        </text>
      ))}
      <box
        columnGap={1}
        flexDirection="row"
        flexShrink={0}
        flexWrap="wrap"
        height={1}
        overflow="hidden"
      >
        {[
          `${start + 1}–${Math.min(start + height, entries.length)}/${entries.length}`,
          `· ${follow ? "Following" : "Paused"}`,
          "· f follow",
          "· ↑↓ scroll",
        ].map((part) => (
          <text
            fg={theme.colors.mutedForeground}
            flexShrink={0}
            key={part}
            wrapMode="none"
          >
            {part}
          </text>
        ))}
      </box>
    </box>
  );
}
