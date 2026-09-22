import type {
  DashboardSnapshot,
  RunSnapshot,
  StepSnapshot,
} from "../src/views/dashboard-model";
import { dashboardSnapshot } from "./snapshot";

export interface PreviewScenario {
  readonly frames: readonly DashboardSnapshot[];
  readonly id: string;
  readonly label: string;
  readonly width?: number;
}

function exampleRun(): RunSnapshot {
  const [run] = dashboardSnapshot.runs;
  if (!run) {
    throw new Error("The dashboard preview needs a sample run.");
  }
  return run;
}
const sample = exampleRun();

function frame(run: RunSnapshot, status: string): DashboardSnapshot {
  return {
    ...dashboardSnapshot,
    runs: [run, ...dashboardSnapshot.runs.slice(1)],
    status,
    triggers: dashboardSnapshot.triggers.map((trigger) =>
      trigger.id === run.triggerId
        ? {
            ...trigger,
            status: run.status === "running" ? "running" : "watching",
          }
        : trigger
    ),
  };
}

function finish(step: StepSnapshot): StepSnapshot {
  return { ...step, children: step.children.map(finish), status: "complete" };
}

const completed: RunSnapshot = {
  ...sample,
  elapsed: "30s",
  logs: [
    ...(sample.logs ?? []),
    {
      id: "log-5",
      level: "info",
      message: "Documentation checks passed.",
      stepId: "check",
      timestamp: "14:32:14",
    },
  ],
  result: { checks: { passed: true, warnings: [] }, files: ["docs/cli.md"] },
  status: "complete",
  steps: [
    ...sample.steps.map(finish),
    {
      children: [],
      elapsed: "6s",
      id: "check",
      name: "Check result",
      result: { passed: true },
      status: "complete",
    },
  ],
};

const playback = [
  frame(
    { ...sample, elapsed: "0s", logs: [], status: "queued", steps: [] },
    "Queued"
  ),
  frame(
    {
      ...sample,
      elapsed: "1s",
      logs: (sample.logs ?? []).slice(0, 1),
      steps: [
        {
          children: [],
          elapsed: "1s",
          id: "find",
          name: "Find changed files",
          status: "running",
        },
      ],
    },
    "Finding changes"
  ),
  dashboardSnapshot,
  frame(completed, "Completed"),
];

function fail(step: StepSnapshot): StepSnapshot {
  return {
    ...step,
    children: step.children.map(fail),
    error:
      step.status === "running"
        ? "Documentation output could not be written."
        : undefined,
    status: step.status === "running" ? "failed" : step.status,
  };
}
const failed = frame(
  {
    ...sample,
    elapsed: "25s",
    error: "Documentation output could not be written.",
    logs: [
      ...(sample.logs ?? []),
      {
        id: "log-error",
        level: "error",
        message: "Write failed: permission denied",
        stepId: "write",
        timestamp: "14:32:09",
      },
    ],
    status: "failed",
    steps: sample.steps.map(fail),
  },
  "Failed"
);

let deep: StepSnapshot = {
  children: [],
  elapsed: "3s",
  id: "deep-leaf",
  name: "Validate generated output",
  status: "running",
};
for (let depth = 8; depth >= 1; depth -= 1) {
  deep = {
    children: [deep],
    elapsed: "12s",
    id: `deep-${depth}`,
    name: `Nested operation ${depth}`,
    status: "running",
  };
}

export const previewScenarios: readonly PreviewScenario[] = [
  { frames: playback, id: "running", label: "Running" },
  {
    frames: [
      {
        ...dashboardSnapshot,
        runs: [],
        status: "Waiting for a trigger",
        triggers: dashboardSnapshot.triggers.map((trigger) => ({
          ...trigger,
          status: trigger.kind === "monitor" ? "watching" : "waiting",
        })),
      },
    ],
    id: "idle",
    label: "Idle",
  },
  { frames: [failed], id: "failed", label: "Failed" },
  {
    frames: [frame(completed, "Completed")],
    id: "completed",
    label: "Completed",
  },
  {
    frames: [
      {
        ...dashboardSnapshot,
        runs: Array.from(
          { length: 40 },
          (_, index): RunSnapshot => ({
            ...completed,
            id: `history-${index}`,
            name: `Documentation pass ${index + 1}`,
          })
        ),
        status: "Run history",
      },
    ],
    id: "history",
    label: "Long history",
  },
  {
    frames: [
      frame(
        {
          ...completed,
          input: {
            "a.b": { note: "A dotted key is a single path segment." },
            batches: [
              { paths: ["a.ts", "b.ts"] },
              { options: { check: true }, paths: ["c.ts"] },
            ],
          },
          logs: Array.from({ length: 40 }, (_, index) => ({
            id: `long-log-${index}`,
            level: index % 8 === 0 ? "warn" : "info",
            message: `Validated section ${index + 1}`,
            timestamp: `14:32:${String(index).padStart(2, "0")}`,
          })),
          result: Array.from(
            { length: 60 },
            (_, index) => `Line ${index + 1}: validated documentation section`
          ).join("\n"),
        },
        "Long output"
      ),
    ],
    id: "output",
    label: "Long output",
  },
  {
    frames: [frame({ ...sample, steps: [deep] }, "Nested execution")],
    id: "deep",
    label: "Deep steps",
  },
  {
    frames: [dashboardSnapshot],
    id: "narrow",
    label: "Narrow terminal",
    width: 70,
  },
];
