import type { ChannelMessage } from "@foundry/workflows/channels";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { defineStories, story } from "textbook-sh";
import type {
  DashboardSnapshot,
  RunSnapshot,
} from "~/cli/state/dashboard-model";
import type { Launcher, RunActions } from "~/cli/state/run-actions";
import type { HostedWorkspace } from "~/cli/state/use-dashboard";
import type { AnswerHandler } from "~/cli/state/use-feed";
import { DashboardView } from "~/cli/views/dashboard";
import { Action } from "~/components/ui/action";
import { Text } from "~/components/ui/text";
import type { JsonValue } from "~/model/json";
import type { SettingsChange } from "~/model/settings";
import { type PreviewScenario, previewScenarios } from "../fixtures/scenarios";
import { dashboardSnapshot } from "../fixtures/snapshot";
import { ignore, renderFrame } from "../frame";
import { type Replay, ReplayKeys, type StoryKey } from "./replay-keys";

const WIDE = 120;
const NARROW = 70;
const HEIGHT = 34;
const PLAYBACK_INTERVAL = 1200;
const SUBMIT: StoryKey = { ctrl: true, name: "return", sequence: "\r" };

const done = () => Promise.resolve();

const actions: RunActions = {
  cancel: done,
  deleteTrigger: done,
  pause: done,
  resume: done,
  send: done,
  setTriggerEnabled: done,
  stopActivity: done,
};

const failingActions: RunActions = {
  ...actions,
  pause: () => Promise.reject(new Error("The step finished before it paused.")),
};

const streamed = [
  "Reading docs/cli.md\n",
  "Found 4 flags without descriptions.\n",
  "Writing the flags table",
];

const streamingActions: RunActions = {
  ...actions,
  stream: () =>
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
    }),
};

const pendingLaunch: Launcher = () => new Promise<string>(() => undefined);
const pendingRoll = () => new Promise<void>(() => undefined);

const answered: AnswerHandler = () => Promise.resolve();
const saveSettings = (_changes: SettingsChange) => Promise.resolve();

const hosted: HostedWorkspace = {
  state: "ready",
  workspaces: [
    {
      config: "/Users/someone/code/foundry/.foundry/marbles",
      id: "ws-foundry",
      root: "/Users/someone/code/foundry",
      state: "ready",
    },
    {
      config: "/Users/someone/code/handbook/.foundry/marbles",
      id: "ws-handbook",
      root: "/Users/someone/code/handbook",
      state: "ready",
    },
    {
      config: null,
      error: "A marble module could not load.",
      id: "ws-spyglass",
      root: "/Users/someone/code/spyglass",
      state: "failed",
    },
  ],
};

const reloading: HostedWorkspace = { ...hosted, state: "reloading" };

const withNotices: DashboardSnapshot = {
  ...dashboardSnapshot,
  notices: [
    "Settings could not be read; using the dark theme.",
    "2 runs from an earlier session were closed out.",
  ],
};

function scenario(id: string): PreviewScenario {
  const found = previewScenarios.find((item) => item.id === id);
  if (!found) {
    throw new Error(`There is no ${id} preview scenario.`);
  }
  return found;
}

function firstFrame(id: string): DashboardSnapshot {
  const [frame] = scenario(id).frames;
  if (!frame) {
    throw new Error(`The ${id} preview scenario has no frames.`);
  }
  return frame;
}

interface DashboardStoryProps {
  readonly actions?: RunActions;
  readonly hosted?: HostedWorkspace;
  readonly onAnswer?: AnswerHandler;
  readonly onLaunch?: Launcher;
  readonly onRollSchedule?: (key: string) => Promise<void>;
  readonly onSettings?: (changes: SettingsChange) => Promise<void>;
  readonly rail?: boolean;
  readonly snapshot?: DashboardSnapshot;
  readonly toolbar?: ReactNode;
  readonly width: number;
}

function StoryDashboard({
  rail: initialRail,
  snapshot = dashboardSnapshot,
  width,
  ...options
}: DashboardStoryProps) {
  const [rail, setRail] = useState(initialRail ?? false);
  return (
    <DashboardView
      {...options}
      onClose={ignore}
      onSwitchWorkspace={ignore}
      onWorkspaceRail={initialRail === undefined ? undefined : setRail}
      snapshot={snapshot}
      viewportWidth={width}
      workspaceRail={initialRail === undefined ? undefined : rail}
    />
  );
}

function framed(node: ReactNode, width: number) {
  return (renderer: Parameters<typeof renderFrame>[0]) =>
    renderFrame(renderer, node, { height: HEIGHT, padded: false, width });
}

function dashboard(props: Partial<DashboardStoryProps> = {}, replay?: Replay) {
  const width = props.width ?? WIDE;
  return framed(
    <ReplayKeys replay={replay}>
      <StoryDashboard {...props} width={width} />
    </ReplayKeys>,
    width
  );
}

function Playback({
  frames,
}: {
  readonly frames: readonly DashboardSnapshot[];
}) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  useEffect(() => {
    if (!playing) {
      return;
    }
    const timer = setInterval(
      () => setIndex((previous) => (previous + 1) % frames.length),
      PLAYBACK_INTERVAL
    );
    return () => clearInterval(timer);
  }, [playing, frames.length]);
  const toggle = useCallback(() => setPlaying((value) => !value), []);
  const advance = useCallback(() => {
    setPlaying(false);
    setIndex((previous) => (previous + 1) % frames.length);
  }, [frames.length]);
  const snapshot = frames[index] ?? dashboardSnapshot;
  return (
    <StoryDashboard
      snapshot={snapshot}
      toolbar={
        <box flexDirection="row" flexShrink={0} gap={2}>
          <Text>
            Frame {index + 1}/{frames.length} · {snapshot.status}
          </Text>
          <Action
            label={playing ? "[ Pause ]" : "[ Play ]"}
            onAction={toggle}
            value="play"
          />
          <Action label="[ Next frame ]" onAction={advance} value="next" />
        </box>
      }
      width={WIDE}
    />
  );
}

function LaunchScenario({
  refuse,
  snapshot,
  width,
}: {
  readonly refuse: boolean;
  readonly snapshot: DashboardSnapshot;
  readonly width: number;
}) {
  const [runs, setRuns] = useState<readonly RunSnapshot[]>([]);
  const launch = useCallback<Launcher>(
    (name, input) => {
      if (refuse) {
        return Promise.reject(
          new Error("Executor unavailable. Your inputs are preserved.")
        );
      }
      const id = `story-run-${runs.length + 1}`;
      const run: RunSnapshot = {
        definitionId: name,
        elapsed: "0.1s",
        id,
        input: (input ?? {}) as JsonValue,
        name,
        result: { launched: true },
        started: "Just now",
        status: "complete",
        steps: [],
      };
      setRuns((previous) => [run, ...previous]);
      return Promise.resolve(id);
    },
    [refuse, runs.length]
  );
  return (
    <StoryDashboard
      onLaunch={launch}
      snapshot={{ ...snapshot, runs: [...runs, ...snapshot.runs] }}
      width={width}
    />
  );
}

function launchScenario(id: string, refuse: boolean, replay: Replay) {
  return framed(
    <ReplayKeys replay={replay}>
      <LaunchScenario refuse={refuse} snapshot={firstFrame(id)} width={WIDE} />
    </ReplayKeys>,
    WIDE
  );
}

export default defineStories({
  component: "DashboardView",
  description:
    "The whole dashboard, driven into each state with the keys a user would press. Stories run at 120 by 34 unless they say otherwise; a terminal narrower than the story shrinks it, and the arrangement changes with it.",
  title: "Views/Dashboard",
});

export const ScenarioRunning = story({
  description:
    "A run from queued to completed, one frame every 1.2 seconds; the toolbar pauses or steps it.",
  name: "Scenario · Running",
  render: framed(<Playback frames={scenario("running").frames} />, WIDE),
});

export const ScenarioIdle = story({
  description: "Triggers are waiting and nothing has run yet.",
  name: "Scenario · Idle",
  render: dashboard({ snapshot: firstFrame("idle") }),
});

export const ScenarioFailed = story({
  description: "The latest run failed while writing its output.",
  name: "Scenario · Failed",
  render: dashboard({ snapshot: firstFrame("failed") }),
});

export const ScenarioCompleted = story({
  description: "The latest run finished, including its check step.",
  name: "Scenario · Completed",
  render: dashboard({ snapshot: firstFrame("completed") }),
});

export const ScenarioHistory = story({
  description: "Forty finished runs fill the run list, which scrolls.",
  name: "Scenario · Long history",
  render: dashboard({ snapshot: firstFrame("history") }),
});

export const ScenarioOutput = story({
  description:
    "A run with sixty lines of result and forty log lines, opened on its output tab.",
  name: "Scenario · Long output",
  render: dashboard(
    { snapshot: firstFrame("output") },
    {
      keys: ["return", "right", "right"],
      shows: "Line 1: validated documentation section",
    }
  ),
});

export const ScenarioDeep = story({
  description: "A run whose steps nest nine levels deep.",
  name: "Scenario · Deep steps",
  render: dashboard({ snapshot: firstFrame("deep") }),
});

export const ScenarioNarrow = story({
  description: "The overview in a 70-column terminal.",
  name: "Scenario · Narrow terminal",
  render: dashboard({
    snapshot: firstFrame("narrow"),
    width: scenario("narrow").width ?? NARROW,
  }),
});

export const ScenarioEmptyConfig = story({
  description: "A config that declares nothing at all.",
  name: "Scenario · Empty config",
  render: dashboard({ snapshot: firstFrame("empty-config") }),
});

export const ScenarioStepsOnly = story({
  description: "Definitions without any trigger, ready to launch by hand.",
  name: "Scenario · Steps without triggers",
  render: dashboard({ snapshot: firstFrame("steps-only") }),
});

export const ScenarioNoRuns = story({
  description: "Triggers are watching but none has fired yet.",
  name: "Scenario · Triggers awaiting first run",
  render: dashboard({ snapshot: firstFrame("no-runs") }),
});

export const ScenarioLaunchForm = story({
  description:
    "The Prototype workflow's launch form, opened from the catalog with l. Submitting adds a finished run.",
  name: "Scenario · Launch arguments",
  render: launchScenario("launch-form", false, {
    keys: ["down", "l"],
    shows: "marbles · Launch Prototype",
  }),
});

export const ScenarioLaunchError = story({
  description:
    "A launch the executor refuses: the form keeps the typed task and shows the error.",
  name: "Scenario · Launch failure",
  render: launchScenario("launch-error", true, {
    keys: ["l", "d", "o", "c", "s", SUBMIT],
    shows: "Executor unavailable. Your inputs are preserved.",
  }),
});

export const Overview = story({
  description: "The overview: metrics, rankings, up next, runs, and latest.",
  name: "Overview",
  render: dashboard(),
});

export const OverviewMedium = story({
  description:
    "The overview at 100 columns, below the 112 columns where main counts as wide.",
  name: "Overview · 100 columns",
  render: dashboard({ width: 100 }),
});

export const Notices = story({
  description: "Host notices sit above the body.",
  name: "Overview · notices",
  render: dashboard({ snapshot: withNotices }),
});

export const RunDetails = story({
  description:
    "Enter on the running run opens its details in place of the overview.",
  name: "Run details",
  render: dashboard(
    { actions },
    { keys: ["return"], shows: "Run / update-documentation" }
  ),
});

export const RunDetailsNarrow = story({
  description: "Run details at 70 columns.",
  name: "Run details · narrow",
  render: dashboard(
    { actions, width: NARROW },
    { keys: ["return"], shows: "Run / update-documentation" }
  ),
});

export const StepDetails = story({
  description: "A step picked in the run tree, with its breadcrumbs.",
  name: "Step details",
  render: dashboard(
    { actions },
    { keys: ["down", "return"], shows: "Step / Find changed files" }
  ),
});

export const RunLogs = story({
  description: "The run's logs tab.",
  name: "Run details · logs",
  render: dashboard(
    { actions },
    {
      keys: ["return", "right", "right", "right"],
      shows: "[info] Run dispatched by update-docs.",
    }
  ),
});

export const RunStream = story({
  description: "The live stream tab, fed by a fake stream.",
  name: "Run details · live stream",
  render: dashboard(
    { actions: streamingActions },
    {
      keys: ["return", "right", "right", "right", "right"],
      shows: "Found 4 flags without descriptions.",
    }
  ),
});

export const Usage = story({
  description: "u on the run list opens every workflow's and agent's usage.",
  name: "Usage breakdown",
  render: dashboard(
    {},
    { keys: ["u"], shows: "Usage · every workflow and agent" }
  ),
});

export const Search = story({
  description: "/ searches the focused run list; here for “rev”.",
  name: "Search runs",
  render: dashboard(
    {},
    { keys: ["/", "r", "e", "v"], shows: "Search run: rev" }
  ),
});

export const RunFilter = story({
  description:
    "f on a catalog trigger filters the runs to it; the overview shows the filter.",
  name: "Run filter",
  render: dashboard(
    {},
    { keys: ["C", "f", "D"], shows: "Run filter: trigger: update-docs" }
  ),
});

export const Steer = story({
  description: "s opens the prompt for live agent work in the selected run.",
  name: "Steer prompt",
  render: dashboard(
    { actions },
    { keys: ["s"], shows: "steer write · #work-w" }
  ),
});

export const ActionFailed = story({
  description: "p asks to pause, the fake host refuses, and the error shows.",
  name: "Action failed",
  render: dashboard(
    { actions: failingActions },
    { keys: ["p"], shows: "The step finished before it paused." }
  ),
});

export const Help = story({
  description: "? replaces the body with keyboard help.",
  name: "Keyboard help",
  render: dashboard(
    {},
    { keys: ["?"], shows: "Keyboard help · Esc or ? closes" }
  ),
});

export const Quit = story({
  description: "q asks before quitting.",
  name: "Quit dialog",
  render: dashboard(
    {},
    {
      keys: ["q"],
      shows: "Quitting stops schedules and monitoring for this session.",
    }
  ),
});

export const QuitHosted = story({
  description: "The quit dialog when Marbles hosts the workspace.",
  name: "Quit dialog · hosted",
  render: dashboard(
    { hosted },
    { keys: ["q"], shows: "Quitting closes this dashboard." }
  ),
});

export const Launching = story({
  description:
    "l on a step without arguments launches it at once; the launch has not come back yet.",
  name: "Launching",
  render: dashboard(
    { onLaunch: pendingLaunch, snapshot: firstFrame("launch-form") },
    { keys: ["l"], shows: "Launching..." }
  ),
});

export const WaitingForSchedule = story({
  description:
    "r on a schedule's details runs it now; the run has not started yet.",
  name: "Waiting for a schedule run",
  render: dashboard(
    { onRollSchedule: pendingRoll },
    {
      keys: ["C", "down", "down", "return", "r"],
      shows: "Waiting for schedule run…",
    }
  ),
});

export const Catalog = story({
  description: "The catalog: triggers above the marbles that can run.",
  name: "Catalog",
  render: dashboard({}, { keys: ["C"], shows: "1 Triggers" }),
});

export const CatalogNarrow = story({
  description: "The catalog at 70 columns, with compact definitions.",
  name: "Catalog · narrow",
  render: dashboard({ width: NARROW }, { keys: ["C"], shows: "1 Triggers" }),
});

export const CatalogDetails = story({
  description: "With main wide, details open beside the catalog.",
  name: "Catalog · details beside",
  render: dashboard(
    {},
    { keys: ["C", "return"], shows: "Monitor / update-docs" }
  ),
});

export const CatalogDetailsNarrow = story({
  description: "At 70 columns details replace the catalog.",
  name: "Catalog · details narrow",
  render: dashboard(
    { width: NARROW },
    { keys: ["C", "return"], shows: "Monitor / update-docs" }
  ),
});

export const TriggerConfiguration = story({
  description: "v shows the selected trigger's configuration.",
  name: "Catalog · trigger configuration",
  render: dashboard(
    {},
    { keys: ["C", "return", "v"], shows: '"glob": "src/**/*.ts"' }
  ),
});

export const Definitions = story({
  description: "2 focuses the marbles; with a launcher, l launches.",
  name: "Catalog · marbles focused",
  render: dashboard(
    { onLaunch: () => Promise.resolve("story-run") },
    { keys: ["C", "2"], shows: "› [workflow] update-documentation" }
  ),
});

export const CatalogSearch = story({
  description: "/ searches the focused triggers; here for “doc”.",
  name: "Catalog · search",
  render: dashboard(
    {},
    { keys: ["C", "/", "d", "o", "c"], shows: "Search trigger: doc" }
  ),
});

export const Feed = story({
  description: "The feed of every workspace.",
  name: "Feed",
  render: dashboard(
    { onAnswer: answered },
    { keys: ["F"], shows: "Feed · All workspaces" }
  ),
});

export const FeedReader = story({
  description: "Enter reads the open question; its choices can be picked.",
  name: "Feed · reader",
  render: dashboard(
    { onAnswer: answered },
    { keys: ["F", "return"], shows: "Entry · ↑↓ scroll · Esc entries" }
  ),
});

export const FeedNarrow = story({
  description: "The feed at 70 columns, the list above the reader.",
  name: "Feed · narrow",
  render: dashboard(
    { onAnswer: answered, width: NARROW },
    { keys: ["F"], shows: "Feed · All workspaces" }
  ),
});

export const Diagnostics = story({
  description: "The diagnostics drawer of host and run logs covers the body.",
  name: "Diagnostics",
  render: dashboard({}, { keys: ["L"], shows: "Logs · runs and Marbles" }),
});

export const DiagnosticsSearch = story({
  description: "/ in diagnostics searches the logs; here for “wr”.",
  name: "Diagnostics · search",
  render: dashboard({}, { keys: ["L", "/", "w", "r"], shows: 'search "wr"' }),
});

export const Settings = story({
  description:
    "The settings drawer docked on the right; arrows change the theme.",
  name: "Settings · docked",
  render: dashboard(
    { onSettings: saveSettings },
    { keys: ["S"], shows: "Theme: Dark" }
  ),
});

export const SettingsReadOnly = story({
  description: "Settings when the host cannot save them.",
  name: "Settings · read-only",
  render: dashboard({}, { keys: ["S"], shows: "Theme: Dark read-only here" }),
});

export const SettingsNarrow = story({
  description:
    "At 70 columns there is no room to dock, so settings cover the body.",
  name: "Settings · overlaid",
  render: dashboard(
    { onSettings: saveSettings, width: NARROW },
    { keys: ["S"], shows: "Theme: Dark" }
  ),
});

export const Rail = story({
  description:
    "The workspace rail beside the overview, for a host with three workspaces.",
  name: "Workspace rail",
  render: dashboard({ hosted, rail: true }),
});

export const RailNarrow = story({
  description: "The rail is asked for, but 70 columns leave no room for it.",
  name: "Workspace rail · hidden when narrow",
  render: dashboard({ hosted, rail: true, width: NARROW }),
});

export const Picker = story({
  description: "w opens the workspace picker, docked on the left.",
  name: "Workspace picker · docked",
  render: dashboard({ hosted }, { keys: ["w"], shows: "spyglass failed" }),
});

export const PickerNarrow = story({
  description: "At 70 columns the picker covers the body.",
  name: "Workspace picker · overlaid",
  render: dashboard(
    { hosted, width: NARROW },
    { keys: ["w"], shows: "spyglass failed" }
  ),
});

export const Reloading = story({
  description: "A hosted workspace that is reloading its source.",
  name: "Workspace reloading",
  render: dashboard({ hosted: reloading }),
});
