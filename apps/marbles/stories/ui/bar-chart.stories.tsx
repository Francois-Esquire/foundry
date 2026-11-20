import { defineStories, story } from "textbook-sh";
import { BarChart } from "~/components/ui/bar-chart";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import { renderFrame } from "./frame";

interface Ranking {
  readonly label: string;
  readonly timing: string;
  readonly value: number;
}

function chartRows(rankings: readonly Ranking[]) {
  return rankings.map(({ label, timing, value }) => ({
    id: label,
    label,
    value,
    valueLabel: (
      <Text fg={theme.colors.info} flexShrink={0} wrapMode="none">
        {timing}
      </Text>
    ),
    valueWidth: timing.length,
  }));
}

const workflows: readonly Ranking[] = [
  { label: "nightly-digest", timing: "12m 4s", value: 724 },
  { label: "triage-issues", timing: "6m 30s", value: 390 },
  { label: "summarise-prs", timing: "2m 12s", value: 132 },
  { label: "tidy-branches", timing: "18s", value: 18 },
];

const longNames: readonly Ranking[] = [
  { label: "refresh-dependency-lockfiles", timing: "9m 2s", value: 542 },
  { label: "regenerate-api-reference-docs", timing: "3m 40s", value: 220 },
];

const idle: readonly Ranking[] = [
  { label: "nightly-digest", timing: "0s", value: 0 },
  { label: "triage-issues", timing: "0s", value: 0 },
];

export default defineStories({
  component: "BarChart",
  description:
    "Ranked rows with a label, a proportional bar, and a right-aligned value.",
  title: "UI/BarChart",
});

export const Bars = story({
  description: "Several rows with room for bars, scaled to the largest value.",
  name: "Bars",
  render: (renderer) =>
    renderFrame(
      renderer,
      <box flexDirection="column">
        <BarChart
          availableWidth={44}
          color={theme.colors.accent}
          data={chartRows(workflows)}
        />
      </box>,
      { height: 6, width: 46 }
    ),
});

export const Narrow = story({
  description:
    "Too narrow for bars: only labels and values, long labels truncated.",
  name: "Narrow",
  render: (renderer) =>
    renderFrame(
      renderer,
      <box flexDirection="column">
        <BarChart
          availableWidth={24}
          color={theme.colors.accent}
          data={chartRows(longNames)}
        />
      </box>,
      { height: 4, width: 26 }
    ),
});

export const SingleRow = story({
  description: "One row has nothing to compare against, so no bar is drawn.",
  name: "Single row",
  render: (renderer) =>
    renderFrame(
      renderer,
      <box flexDirection="column">
        <BarChart
          availableWidth={44}
          color={theme.colors.info}
          data={chartRows(workflows.slice(0, 1))}
        />
      </box>,
      { height: 3, width: 46 }
    ),
});

export const AllZero = story({
  description: "Every value is zero, so the bars are hidden.",
  name: "All zero",
  render: (renderer) =>
    renderFrame(
      renderer,
      <box flexDirection="column">
        <BarChart
          availableWidth={44}
          color={theme.colors.info}
          data={chartRows(idle)}
        />
      </box>,
      { height: 4, width: 46 }
    ),
});
