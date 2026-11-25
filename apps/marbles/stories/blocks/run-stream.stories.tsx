import { useEffect, useState } from "react";
import { defineStories, story } from "textbook-sh";
import { STREAM_TAIL_LINES, streamTail } from "~/cli/state/run-stream";
import { RunStream, type RunStreamView } from "~/components/blocks/run-stream";
import { renderFrame } from "../frame";

const size = { height: 18, width: 70 };

const transcript = [
  "Reading docs/cli.md (412 lines)",
  "The CLI reference lists 14 commands; src/cli/args.ts defines 15.",
  "Missing: marbles artifacts relink",
  "Drafting a section for relink after resources.",
  "## marbles artifacts relink",
  "",
  "Rebuilds each workspace's links under <root>/.marbles/ from the database.",
  "Checking the options table against parseArgs…",
  "Adding --workspace and --dry-run rows.",
  "Updating the table of contents.",
  "Writing docs/cli.md",
  "Done: 1 file changed, 18 insertions.",
  "Running the docs link check…",
  "All 63 links resolve.",
];

const ended: RunStreamView = {
  lines: streamTail(transcript.join("\n")),
  live: false,
  received: true,
};

const wide: RunStreamView = {
  lines: [
    'tool_use: read_file {"path":"src/cli/state/dashboard-commands.ts","offset":0,"limit":400}',
    'tool_result: 312 lines · export const DASHBOARD_COMMANDS: readonly DashboardCommand[] = [ { key: "shift+d" …',
    "Comparing the command table with the README navigation table.",
  ],
  live: true,
  received: true,
};

const carriageReturns: RunStreamView = {
  lines: streamTail(
    [
      "Running the docs build on Windows\r",
      "Building 42 pages\r",
      "\r",
      "Done in 3.1s\r",
      "",
    ].join("\n")
  ),
  live: false,
  received: true,
};

function LiveTranscript() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (count >= transcript.length) {
      return;
    }
    const timer = setTimeout(() => setCount((value) => value + 1), 700);
    return () => clearTimeout(timer);
  }, [count]);
  const done = count >= transcript.length;
  const stream: RunStreamView = {
    lines: streamTail(transcript.slice(0, count).join("\n")),
    live: !done,
    received: count > 0,
  };
  return <RunStream stream={stream} tail={STREAM_TAIL_LINES} />;
}

export default defineStories({
  component: "RunStream",
  description:
    "The Stream tab: the last lines a running step printed, with the steer and pause keys.",
  title: "Blocks/RunStream",
});

export const NotLocal = story({
  description: "A run hosted by another process has no stream to show.",
  name: "Not in this process",
  render: (renderer) =>
    renderFrame(
      renderer,
      <RunStream
        stream={{ lines: [], live: false, received: false }}
        tail={STREAM_TAIL_LINES}
      />,
      size
    ),
});

export const Waiting = story({
  description: "Connected and live, but nothing printed yet.",
  name: "Waiting for output",
  render: (renderer) =>
    renderFrame(
      renderer,
      <RunStream
        stream={{ lines: [], live: true, received: false }}
        tail={STREAM_TAIL_LINES}
      />,
      size
    ),
});

export const Live = story({
  description:
    "Lines arrive one at a time and only the last twelve stay; the footer says Ended once it stops.",
  name: "Live",
  render: (renderer) => renderFrame(renderer, <LiveTranscript />, size),
});

export const Ended = story({
  description: "A finished stream keeps its last lines and says Ended.",
  name: "Ended",
  render: (renderer) =>
    renderFrame(
      renderer,
      <RunStream stream={ended} tail={STREAM_TAIL_LINES} />,
      size
    ),
});

export const LongLines = story({
  description:
    "Lines longer than the panel do not wrap; they are cut at the edge.",
  name: "Long lines",
  render: (renderer) =>
    renderFrame(
      renderer,
      <RunStream stream={wide} tail={STREAM_TAIL_LINES} />,
      { height: 8, width: 50 }
    ),
});

export const CarriageReturns = story({
  description:
    "Output with Windows line endings and a trailing newline: every line, blank or not, takes exactly one row.",
  name: "Carriage returns",
  render: (renderer) =>
    renderFrame(
      renderer,
      <RunStream stream={carriageReturns} tail={STREAM_TAIL_LINES} />,
      { height: 10, width: 50 }
    ),
});
