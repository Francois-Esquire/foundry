import { useCallback, useMemo, useState } from "react";
import { defineStories, story } from "textbook-sh";
import { type LogLine, LogsBlock } from "~/components/blocks/logs-panel";
import { Action } from "~/components/ui/action";
import { ignore, renderFrame } from "../frame";

const size = { height: 16, padded: false, width: 96 };

type Level = LogLine<string>["level"];

const LEVELS: readonly Level[] = ["debug", "info", "warn", "error"];

function line(
  id: string,
  level: Level,
  location: string,
  message: string,
  timestamp: string
): LogLine<string> {
  return { entry: id, id, level, location, message, timestamp };
}

const lines: readonly LogLine<string>[] = [
  line("host:1", "info", "marbles", "[source] .foundry/marbles", "14:31:40"),
  line(
    "log-1",
    "info",
    "run-104",
    "Run dispatched by update-docs.",
    "14:31:44"
  ),
  line("log-2", "info", "run-104 find", "Found src/cli.ts", "14:31:46"),
  line("log-3", "debug", "run-104 read", "Loaded cli.md", "14:31:50"),
  line(
    "host:2",
    "warn",
    "marbles",
    "[agents] no list price for openai/gpt-local",
    "14:31:58"
  ),
  line(
    "log-4",
    "info",
    "run-104 write",
    "Writing CLI reference changes.",
    "14:32:08"
  ),
  line(
    "log-error",
    "error",
    "run-104 write",
    "Write failed: permission denied",
    "14:32:09"
  ),
];

const filters = { follow: true, level: "debug", query: "", source: "all" };

const longLines = [
  ...lines,
  line(
    "log-long",
    "warn",
    "run-105 summarise",
    "The model returned a summary longer than the configured limit of 4000 characters, so the step truncated it and recorded the full text as a result attachment instead.",
    "14:33:12"
  ),
  ...Array.from({ length: 16 }, (_, index) =>
    line(
      `tick-${index}`,
      "debug",
      "marbles",
      `[schedule] daily-summary checked, next at 17:00 (${index + 1})`,
      `14:${String(34 + index).padStart(2, "0")}:00`
    )
  ),
];

function Interactive() {
  const [selected, setSelected] = useState<string>();
  const [minimum, setMinimum] = useState(0);
  const [follow, setFollow] = useState(true);
  const shown = useMemo(
    () => lines.filter((entry) => LEVELS.indexOf(entry.level) >= minimum),
    [minimum]
  );
  const cycleLevel = useCallback(
    () => setMinimum((previous) => (previous + 1) % LEVELS.length),
    []
  );
  const toggleFollow = useCallback(
    () => setFollow((previous) => !previous),
    []
  );
  return (
    <>
      <box flexDirection="row" flexShrink={0} gap={3} paddingX={1}>
        <Action
          id="logs-story:level"
          label={`[ v Level: ${LEVELS[minimum]}+ ]`}
          onAction={cycleLevel}
          value="level"
        />
        <Action
          id="logs-story:follow"
          label={`[ f ${follow ? "Pause" : "Follow"} ]`}
          onAction={toggleFollow}
          value="follow"
        />
      </box>
      <LogsBlock
        active
        filters={{
          ...filters,
          follow,
          level: LEVELS[minimum] ?? "debug",
        }}
        lines={shown}
        onSelect={setSelected}
        total={lines.length}
        {...(selected === undefined ? {} : { selectedId: selected })}
      />
    </>
  );
}

export default defineStories({
  component: "LogsBlock",
  description:
    "The diagnostics drawer's log: a filter summary above a panel of run and Marbles lines.",
  title: "Blocks/LogsBlock",
});

export const AllLevels = story({
  description:
    "Run and Marbles lines at every level, each coloured by level, with one selected.",
  name: "All levels",
  render: (renderer) =>
    renderFrame(
      renderer,
      <LogsBlock
        active
        filters={filters}
        lines={lines}
        onSelect={ignore}
        selectedId="log-error"
        total={lines.length}
      />,
      size
    ),
});

export const Filtered = story({
  description:
    "Warnings and up from runs matching a search; the summary counts hidden lines and offers x.",
  name: "Filtered",
  render: (renderer) =>
    renderFrame(
      renderer,
      <LogsBlock
        active
        filters={{ follow: true, level: "warn", query: "write", source: "run" }}
        lines={lines.filter((entry) => entry.id === "log-error")}
        onSelect={ignore}
        total={lines.length}
      />,
      size
    ),
});

export const Paused = story({
  description: "Follow is paused, so new lines do not scroll the panel.",
  name: "Paused",
  render: (renderer) =>
    renderFrame(
      renderer,
      <LogsBlock
        active
        filters={{ ...filters, follow: false }}
        lines={lines}
        onSelect={ignore}
        total={lines.length}
      />,
      size
    ),
});

export const Inactive = story({
  description: "The log while another panel has focus.",
  name: "Inactive",
  render: (renderer) =>
    renderFrame(
      renderer,
      <LogsBlock
        active={false}
        filters={filters}
        lines={lines}
        onSelect={ignore}
        total={lines.length}
      />,
      size
    ),
});

export const NoLogs = story({
  description: "Nothing logged yet, with a note on what appears here.",
  name: "No logs",
  render: (renderer) =>
    renderFrame(
      renderer,
      <LogsBlock
        active
        filters={filters}
        lines={[]}
        onSelect={ignore}
        total={0}
      />,
      size
    ),
});

export const NoMatches = story({
  description: "Filters that hide every line.",
  name: "No matches",
  render: (renderer) =>
    renderFrame(
      renderer,
      <LogsBlock
        active
        filters={{ ...filters, level: "error", query: "timeout" }}
        lines={[]}
        onSelect={ignore}
        total={lines.length}
      />,
      size
    ),
});

export const IsoTimestamp = story({
  description:
    "An ISO timestamp is shown as a local time; plain times are shown as given.",
  name: "ISO timestamp",
  render: (renderer) =>
    renderFrame(
      renderer,
      <LogsBlock
        active
        filters={filters}
        lines={[
          line(
            "iso",
            "info",
            "run-104",
            "Run dispatched by update-docs.",
            "2026-09-22T14:31:44.000Z"
          ),
          ...lines.slice(2, 4),
        ]}
        onSelect={ignore}
        total={3}
      />,
      { ...size, height: 8 }
    ),
});

export const LongAndMany = story({
  description:
    "A long message wraps and many lines overflow the panel, which scrolls.",
  name: "Long and many lines",
  render: (renderer) =>
    renderFrame(
      renderer,
      <LogsBlock
        active
        filters={filters}
        lines={longLines}
        onSelect={ignore}
        total={longLines.length}
      />,
      { ...size, width: 72 }
    ),
});

export const Clickable = story({
  description:
    "Click a line to select it; the Level and Follow actions change the filters.",
  name: "Clickable",
  render: (renderer) =>
    renderFrame(renderer, <Interactive />, { ...size, height: 18 }),
});
