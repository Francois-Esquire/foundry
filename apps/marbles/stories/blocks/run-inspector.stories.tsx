import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import { defineStories, story } from "textbook-sh";
import type { DashboardSelection } from "~/cli/state/dashboard-model";
import type { InspectorTab } from "~/cli/state/dashboard-state";
import { STREAM_TAIL_LINES } from "~/cli/state/run-stream";
import {
  RunInspector,
  type RunTabView,
} from "~/components/blocks/run-inspector";
import { RunStream, type RunStreamView } from "~/components/blocks/run-stream";
import { ignore, renderFrame } from "../frame";
import { inspectedTab, inspectRun } from "./fixtures-b";

const size = { height: 24, width: 72 };

const tabs: readonly InspectorTab[] = [
  "overview",
  "input",
  "output",
  "logs",
  "stream",
];

const docsRun: DashboardSelection = { id: "run-104", kind: "run" };
const writeStep: DashboardSelection = {
  id: "run-104",
  kind: "run",
  stepId: "write",
};
const apiRun: DashboardSelection = { id: "run-103", kind: "run" };
const reviewRun: DashboardSelection = { id: "run-102", kind: "run" };

const liveLines: RunStreamView = {
  lines: [
    "Reading docs/cli.md (412 lines)",
    "The CLI reference lists 14 commands; src/cli/args.ts defines 15.",
    "Missing: marbles relink",
    "Drafting a section for relink after resources.",
  ],
  live: true,
  received: true,
};

const partialOutput: RunTabView = {
  error: "Timed out after 120s while writing docs/logs.md",
  kind: "output",
  output: { pending: ["docs/logs.md"], written: ["README.md", "docs/feed.md"] },
};

function Stream({ view = liveLines }: { readonly view?: RunStreamView }) {
  return <RunStream stream={view} tail={STREAM_TAIL_LINES} />;
}

function Inspect({
  body,
  selection,
}: {
  readonly body: RunTabView;
  readonly selection: DashboardSelection;
}) {
  return (
    <RunInspector
      body={body}
      breadcrumbs={inspectRun(selection).breadcrumbs}
      focused
      onInspect={ignore}
      onTab={ignore}
      stream={<Stream />}
    />
  );
}

function tabStory(
  selection: DashboardSelection,
  tab: InspectorTab,
  frame: { readonly height: number; readonly width: number } = size
) {
  return (renderer: Parameters<typeof renderFrame>[0]) =>
    renderFrame(
      renderer,
      <Inspect body={inspectedTab(selection, tab)} selection={selection} />,
      frame
    );
}

function BrowseRun() {
  const [selection, setSelection] = useState<DashboardSelection>(writeStep);
  const [tab, setTab] = useState<InspectorTab>("overview");
  useKeyboard((key) => {
    if (key.name !== "left" && key.name !== "right") {
      return;
    }
    key.preventDefault();
    const step = key.name === "right" ? 1 : -1;
    setTab((current) => {
      const index = tabs.indexOf(current) + step;
      return tabs[(index + tabs.length) % tabs.length] ?? current;
    });
  });
  return (
    <RunInspector
      body={inspectedTab(selection, tab)}
      breadcrumbs={inspectRun(selection).breadcrumbs}
      focused
      onInspect={setSelection}
      onTab={setTab}
      stream={<Stream />}
    />
  );
}

export default defineStories({
  component: "RunInspector",
  description:
    "Details for a run or step: breadcrumbs back up the path, then Overview, Input, Output, Logs, and Stream tabs.",
  title: "Blocks/RunInspector",
});

export const Browse = story({
  description:
    "Click a tab or press Left and Right to switch; click a breadcrumb to inspect that run or step.",
  name: "Browse",
  render: (renderer) => renderFrame(renderer, <BrowseRun />, size),
});

export const RunOverview = story({
  description: "The Overview tab for a whole run.",
  name: "Overview, run",
  render: tabStory(docsRun, "overview"),
});

export const StepOverview = story({
  description:
    "The Overview tab for a nested step, with a breadcrumb for each parent.",
  name: "Overview, step",
  render: tabStory(writeStep, "overview"),
});

export const InputJson = story({
  description: "An object input as a JSON tree.",
  name: "Input, JSON",
  render: tabStory(docsRun, "input"),
});

export const InputText = story({
  description: "A step's text input.",
  name: "Input, text",
  render: tabStory(writeStep, "input"),
});

export const InputEmpty = story({
  description: "A run with no recorded input.",
  name: "Input, empty",
  render: tabStory(apiRun, "input"),
});

export const OutputText = story({
  description: "A complete run's text result.",
  name: "Output, result",
  render: tabStory(reviewRun, "output"),
});

export const OutputError = story({
  description: "A failed run's error and no result.",
  name: "Output, error",
  render: tabStory(apiRun, "output"),
});

export const OutputErrorWithValue = story({
  description: "An error shown above the partial output that was recorded.",
  name: "Output, error and value",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Inspect body={partialOutput} selection={docsRun} />,
      size
    ),
});

export const OutputEmpty = story({
  description: "A running run has no output yet.",
  name: "Output, empty",
  render: tabStory(docsRun, "output"),
});

export const InputUnfocused = story({
  description: "The Input tab while the inspector panel does not have focus.",
  name: "Input, unfocused",
  render: (renderer) =>
    renderFrame(
      renderer,
      <RunInspector
        body={inspectedTab(docsRun, "input")}
        breadcrumbs={inspectRun(docsRun).breadcrumbs}
        focused={false}
        onInspect={ignore}
        onTab={ignore}
        stream={<Stream />}
      />,
      size
    ),
});

export const Logs = story({
  description: "The run's log entries.",
  name: "Logs",
  render: tabStory(docsRun, "logs"),
});

export const StepLogs = story({
  description: "A step's Logs tab keeps only the entries of that step.",
  name: "Logs, step",
  render: tabStory(writeStep, "logs"),
});

export const LogsEmpty = story({
  description: "A run that wrote no logs.",
  name: "Logs, empty",
  render: tabStory(apiRun, "logs"),
});

export const StreamLive = story({
  description: "The Stream tab shows whatever stream node the host passes in.",
  name: "Stream",
  render: tabStory(docsRun, "stream"),
});

export const StreamNotLocal = story({
  description: "The Stream tab for a run hosted by another process.",
  name: "Stream, not local",
  render: (renderer) =>
    renderFrame(
      renderer,
      <RunInspector
        body={inspectedTab(reviewRun, "stream")}
        breadcrumbs={inspectRun(reviewRun).breadcrumbs}
        focused
        onInspect={ignore}
        onTab={ignore}
        stream={<Stream view={{ lines: [], live: false, received: false }} />}
      />,
      size
    ),
});

export const Narrow = story({
  description: "In a narrow panel the breadcrumbs and the tab row wrap.",
  name: "Narrow",
  render: tabStory(writeStep, "overview", { height: 26, width: 34 }),
});
