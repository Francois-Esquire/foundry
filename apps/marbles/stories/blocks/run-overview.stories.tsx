import { defineStories, story } from "textbook-sh";
import {
  RunOverview,
  type RunOverviewView,
  StepOverview,
} from "~/components/blocks/run-overview";
import { renderFrame } from "../frame";
import { runOverviewView, stepOverviewView } from "./fixtures-b";

const size = { height: 18, width: 64 };

const running = runOverviewView("run-104");

const queued: RunOverviewView = {
  ...running,
  cost: "no usage recorded",
  currentStep: "None",
  elapsed: "0s",
  id: "run-105",
  observedSteps: 0,
  status: "queued",
  timing: { createdAt: Date.parse("2026-09-22T14:32:05.000Z") },
  tokens: "no usage recorded",
};

const untimed: RunOverviewView = {
  ...runOverviewView("run-102"),
  timing: undefined,
};

const longError: RunOverviewView = {
  ...runOverviewView("run-103"),
  error:
    "Request to https://api.internal.example/health failed after 3 attempts: connect ECONNREFUSED 10.0.4.12:443. The endpoint may be down or the VPN disconnected.",
};

export default defineStories({
  component: "RunOverview",
  description:
    "The Overview tab of the run inspector: a run's or a step's facts, and any error.",
  title: "Blocks/RunOverview",
});

export const Running = story({
  description:
    "A running run, queued and started but not ended. Times use the local time zone.",
  name: "Running run",
  render: (renderer) =>
    renderFrame(renderer, <RunOverview run={running} />, size),
});

export const Complete = story({
  description: "A complete run with its end time, cost, and tokens.",
  name: "Complete run",
  render: (renderer) =>
    renderFrame(
      renderer,
      <RunOverview run={runOverviewView("run-102")} />,
      size
    ),
});

export const Failed = story({
  description: "A failed run shows its error below the facts.",
  name: "Failed run",
  render: (renderer) =>
    renderFrame(
      renderer,
      <RunOverview run={runOverviewView("run-103")} />,
      size
    ),
});

export const Queued = story({
  description: "A queued run that has not started or ended yet.",
  name: "Queued run",
  render: (renderer) =>
    renderFrame(renderer, <RunOverview run={queued} />, size),
});

export const WithoutTiming = story({
  description:
    "A run without recorded timing shows the host's start time alone.",
  name: "Run without timing",
  render: (renderer) =>
    renderFrame(renderer, <RunOverview run={untimed} />, size),
});

export const Narrow = story({
  description: "A long error in a narrow panel wraps below the facts.",
  name: "Narrow, long error",
  render: (renderer) =>
    renderFrame(renderer, <RunOverview run={longError} />, {
      height: 28,
      width: 36,
    }),
});

export const RunningStep = story({
  description: "A running leaf step with the cost it has spent so far.",
  name: "Running step",
  render: (renderer) =>
    renderFrame(
      renderer,
      <StepOverview step={stepOverviewView("run-104", "write")} />,
      size
    ),
});

export const ParentStep = story({
  description: "A step with children, whose cost includes theirs.",
  name: "Step with children",
  render: (renderer) =>
    renderFrame(
      renderer,
      <StepOverview step={stepOverviewView("run-104", "update")} />,
      size
    ),
});

export const FailedStep = story({
  description: "A failed step shows its error below the facts.",
  name: "Failed step",
  render: (renderer) =>
    renderFrame(
      renderer,
      <StepOverview step={stepOverviewView("run-103", "request")} />,
      size
    ),
});
