import { defineStories, story } from "textbook-sh";
import { StartupSummary } from "~/components/blocks/startup-summary";
import type { StartupCounts } from "~/model/splash";
import { summarizeConfig } from "~/tui/state/splash-model";
import { dashboardSnapshot } from "../fixtures/snapshot";
import { renderFrame } from "../frame";

const size = { height: 10, width: 44 };

const loaded = summarizeConfig(dashboardSnapshot);

const single: StartupCounts = {
  monitors: 1,
  runs: 1,
  schedules: 1,
  steps: 1,
  workflows: 1,
};

const none: StartupCounts = {
  monitors: 0,
  runs: 0,
  schedules: 0,
  steps: 0,
  workflows: 0,
};

export default defineStories({
  component: "StartupSummary",
  description:
    "The splash card's counts of triggers, marbles, and runs, or placeholders while loading.",
  title: "Blocks/StartupSummary",
});

export const Loading = story({
  description: "No counts yet: dashes and what is being read.",
  name: "Loading",
  render: (renderer) =>
    renderFrame(renderer, <StartupSummary compact={false} />, size),
});

export const Loaded = story({
  description: "Counts from the sample workspace.",
  name: "Loaded",
  render: (renderer) =>
    renderFrame(
      renderer,
      <StartupSummary compact={false} counts={loaded} />,
      size
    ),
});

export const Singular = story({
  description: "One of each uses the singular words.",
  name: "One of each",
  render: (renderer) =>
    renderFrame(
      renderer,
      <StartupSummary compact={false} counts={single} />,
      size
    ),
});

export const EmptyWorkspace = story({
  description: "A workspace with nothing defined shows zero counts.",
  name: "Empty workspace",
  render: (renderer) =>
    renderFrame(
      renderer,
      <StartupSummary compact={false} counts={none} />,
      size
    ),
});

export const Compact = story({
  description: "Compact drops the gap between the trigger and marble groups.",
  name: "Compact",
  render: (renderer) =>
    renderFrame(renderer, <StartupSummary compact counts={loaded} />, size),
});
