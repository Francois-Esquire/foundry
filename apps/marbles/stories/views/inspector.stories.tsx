import type { ChannelMessage } from "@foundry/workflows/channels";
import { useCallback, useState } from "react";
import { defineStories, story } from "textbook-sh";
import type { HarnessActivitySnapshot } from "~/model/dashboard";
import {
  type DashboardSelection,
  type DashboardSnapshot,
  resolveSelection,
} from "~/tui/state/dashboard-model";
import type { InspectorTab } from "~/tui/state/dashboard-state";
import type { RunActions } from "~/tui/state/run-actions";
import { Inspector } from "~/tui/views/inspector";
import { dashboardSnapshot } from "../fixtures/snapshot";
import { ignore, renderFrame } from "../frame";

const size = { height: 30, width: 80 };

const activity: HarnessActivitySnapshot = {
  actions: ["stop"],
  agentId: "writer",
  harness: "claude",
  id: "activity-1",
  kind: "subagent",
  lifetime: "session",
  revision: 3,
  sessionId: "session-1",
  status: "running",
  stepId: "write",
  summary: "Rewriting the flags table in docs/cli.md.",
  title: "Update the CLI reference",
};

const withActivity: DashboardSnapshot = {
  ...dashboardSnapshot,
  runs: dashboardSnapshot.runs.map((run) =>
    run.id === "run-104" ? { ...run, activities: [activity] } : run
  ),
};

const streamed = [
  "Reading docs/cli.md\n",
  "Found 4 flags without descriptions.\n",
  "Writing the flags table",
];

const stream: RunActions["stream"] = () =>
  new ReadableStream<ChannelMessage>({
    start(controller) {
      for (const text of streamed) {
        controller.enqueue({
          _tag: "chunk",
          chunk: {
            at: "2026-09-22T14:32:09.000Z",
            path: ["update", "write"],
            payload: { kind: "text", text },
            stepId: "update.write",
          },
        });
      }
    },
  });

function InspectorStory({
  active = true,
  configuration = false,
  launch = false,
  roll = false,
  selection: initial,
  snapshot = dashboardSnapshot,
  source,
  tab: initialTab = "overview",
}: {
  readonly active?: boolean;
  readonly configuration?: boolean;
  readonly launch?: boolean;
  readonly roll?: boolean;
  readonly selection?: DashboardSelection;
  readonly snapshot?: DashboardSnapshot;
  readonly source?: RunActions["stream"];
  readonly tab?: InspectorTab;
}) {
  const [selection, setSelection] = useState(initial);
  const [tab, setTab] = useState(initialTab);
  const [shown, setShown] = useState(configuration);
  const toggle = useCallback(() => setShown((value) => !value), []);
  return (
    <Inspector
      active={active}
      configurationShown={shown}
      onFilter={ignore}
      onInspect={setSelection}
      onLaunch={launch ? ignore : undefined}
      onRollSchedule={roll ? ignore : undefined}
      onTab={setTab}
      onToggleConfiguration={toggle}
      resolved={resolveSelection(snapshot, selection)}
      selection={selection}
      snapshot={snapshot}
      stream={source}
      tab={tab}
    />
  );
}

function inspect(props: Parameters<typeof InspectorStory>[0]) {
  return (renderer: Parameters<typeof renderFrame>[0]) =>
    renderFrame(renderer, <InspectorStory {...props} />, size);
}

const running: DashboardSelection = { id: "run-104", kind: "run" };

export default defineStories({
  component: "Inspector",
  description:
    "The details panel: it shows the run, step, activity, trigger, or definition that is selected. Tabs and links work.",
  title: "Views/Inspector",
});

export const Run = story({
  description: "A running workflow run on its overview tab.",
  name: "Run · overview",
  render: inspect({ selection: running }),
});

export const RunInput = story({
  description: "The run's input as a JSON tree.",
  name: "Run · input",
  render: inspect({ selection: running, tab: "input" }),
});

export const RunOutput = story({
  description: "A finished run's result.",
  name: "Run · output",
  render: inspect({ selection: { id: "run-102", kind: "run" }, tab: "output" }),
});

export const RunLogs = story({
  description: "The run's log lines.",
  name: "Run · logs",
  render: inspect({ selection: running, tab: "logs" }),
});

export const RunStream = story({
  description: "The live stream tab, fed by a fake stream that stays open.",
  name: "Run · live stream",
  render: inspect({ selection: running, source: stream, tab: "stream" }),
});

export const RunNoStream = story({
  description: "The stream tab when the host offers no stream.",
  name: "Run · no stream",
  render: inspect({ selection: running, tab: "stream" }),
});

export const FailedRun = story({
  description: "A failed run with its error.",
  name: "Run · failed",
  render: inspect({ selection: { id: "run-103", kind: "run" } }),
});

export const Step = story({
  description: "A running step inside the run, with breadcrumbs back to it.",
  name: "Step",
  render: inspect({
    selection: { id: "run-104", kind: "run", stepId: "write" },
  }),
});

export const Activity = story({
  description: "A harness activity started by a step (story-only data).",
  name: "Activity",
  render: inspect({
    selection: {
      activityId: "activity-1",
      id: "run-104",
      kind: "run",
      sessionId: "session-1",
    },
    snapshot: withActivity,
  }),
});

export const Trigger = story({
  description: "A monitor with its configuration folded away.",
  name: "Trigger",
  render: inspect({ selection: { id: "docs-monitor", kind: "trigger" } }),
});

export const TriggerConfiguration = story({
  description: "The same monitor with its configuration shown.",
  name: "Trigger · configuration shown",
  render: inspect({
    configuration: true,
    selection: { id: "docs-monitor", kind: "trigger" },
  }),
});

export const Schedule = story({
  description: "A schedule the host can run now.",
  name: "Schedule · run now",
  render: inspect({ roll: true, selection: { id: "daily", kind: "trigger" } }),
});

export const Definition = story({
  description: "A workflow definition the host can launch.",
  name: "Definition",
  render: inspect({
    launch: true,
    selection: { id: "docs", kind: "definition" },
  }),
});

export const Inactive = story({
  description: "The panel without focus, as it looks beside a focused list.",
  name: "Inactive",
  render: inspect({ active: false, selection: running }),
});

export const Nothing = story({
  description: "Nothing selected.",
  name: "Nothing selected",
  render: inspect({}),
});

export const Gone = story({
  description: "A selection whose run no longer exists.",
  name: "Selection gone",
  render: inspect({ selection: { id: "run-090", kind: "run" } }),
});
