import { useState } from "react";
import { defineStories, story } from "textbook-sh";
import type { DashboardSelection } from "~/cli/state/dashboard-model";
import { latestRows } from "~/cli/state/dashboard-rows";
import { latestActivity } from "~/cli/state/operating-model";
import { usageBreakdown } from "~/cli/state/usage-format";
import {
  LatestBlock,
  type LatestRow,
  OverviewPanels,
  UsageBreakdown,
  type UsageBreakdownView,
} from "~/components/blocks/operating-overview";
import { Panel } from "~/components/ui/panel";
import { Text } from "~/components/ui/text";
import { dashboardSnapshot } from "../fixtures/snapshot";
import { ignore, renderFrame } from "../frame";

const latest = latestRows(latestActivity(dashboardSnapshot, 8));

const usage = dashboardSnapshot.usage
  ? usageBreakdown(dashboardSnapshot.usage)
  : undefined;

const partialUsage: UsageBreakdownView | undefined = usage && {
  ...usage,
  outsideRuns: "~$0.0094",
  recovered: 4,
  unattributed: 2,
  unreadable: 3,
  unsaved: 1,
};

const hostLines: readonly LatestRow<DashboardSelection>[] = [
  {
    at: latest[0]?.at ?? 0,
    id: "host:reload",
    text: "Reloaded .foundry/marbles",
  },
  ...latest.slice(0, 3),
  { at: 0, id: "host:start", text: "Marbles started in foundry" },
];

function RunsPlaceholder() {
  return (
    <Panel title="3 Runs">
      <Text>run-104 update-documentation · running</Text>
      <Text>run-103 check-api · failed</Text>
      <Text>run-102 review-changes · complete</Text>
    </Panel>
  );
}

function ClickableLatest() {
  const [opened, setOpened] = useState<DashboardSelection>();
  return (
    <>
      <LatestBlock items={latest} onSelect={setOpened} />
      <Text>
        Opened: {opened ? `${opened.kind} ${opened.id}` : "nothing yet"}
      </Text>
    </>
  );
}

export default defineStories({
  component: "LatestBlock, UsageBreakdown, OverviewPanels",
  description:
    "The overview's Latest activity panel, the usage breakdown, and the arrangement of runs beside Latest.",
  title: "Blocks/OperatingOverview",
});

export const Latest = story({
  description:
    "Recent run starts, endings, and feed posts, newest first, each with its local time.",
  name: "Latest",
  render: (renderer) =>
    renderFrame(renderer, <LatestBlock items={latest} onSelect={ignore} />, {
      height: 12,
      width: 60,
    }),
});

export const LatestWithoutLinks = story({
  description:
    "Lines with no run to open are plain text, without a time or a row highlight.",
  name: "Latest without links",
  render: (renderer) =>
    renderFrame(renderer, <LatestBlock items={hostLines} onSelect={ignore} />, {
      height: 9,
      width: 60,
    }),
});

export const LatestEmpty = story({
  description: "Nothing has happened in the workspace yet.",
  name: "Latest empty",
  render: (renderer) =>
    renderFrame(renderer, <LatestBlock items={[]} onSelect={ignore} />, {
      height: 5,
      width: 60,
    }),
});

export const LatestNarrow = story({
  description: "A narrow panel truncates long lines to one row each.",
  name: "Latest narrow",
  render: (renderer) =>
    renderFrame(renderer, <LatestBlock items={latest} onSelect={ignore} />, {
      height: 12,
      width: 30,
    }),
});

export const ClickLatest = story({
  description: "Click a line to see the run it opens.",
  name: "Click latest",
  render: (renderer) =>
    renderFrame(renderer, <ClickableLatest />, { height: 14, width: 60 }),
});

export const Usage = story({
  description:
    "The workspace total, then cost and tokens by workflow and by agent.",
  name: "Usage",
  render: (renderer) =>
    renderFrame(renderer, <UsageBreakdown active usage={usage} />, {
      height: 20,
      width: 64,
    }),
});

export const UsagePartial = story({
  description:
    "Usage outside runs and all four warnings: unreadable, recovered, unattributed, and unsaved turns.",
  name: "Usage partial",
  render: (renderer) =>
    renderFrame(renderer, <UsageBreakdown active usage={partialUsage} />, {
      height: 30,
      width: 64,
    }),
});

export const UsageEmptyGroups = story({
  description: "A total with no workflow or agent breakdown recorded.",
  name: "Usage empty groups",
  render: (renderer) =>
    renderFrame(
      renderer,
      <UsageBreakdown
        active
        usage={{
          byAgent: [],
          byWorkflow: [],
          recovered: 0,
          total: { cost: "no usage recorded", tokens: "0 tokens" },
          unattributed: 0,
          unreadable: 0,
          unsaved: 0,
        }}
      />,
      { height: 12, width: 64 }
    ),
});

export const UsageNotRecorded = story({
  description: "A host that does not record usage.",
  name: "Usage not recorded",
  render: (renderer) =>
    renderFrame(renderer, <UsageBreakdown active={false} />, {
      height: 5,
      width: 64,
    }),
});

export const UsageInactive = story({
  description:
    "The breakdown while another panel has focus; it does not scroll.",
  name: "Usage inactive",
  render: (renderer) =>
    renderFrame(renderer, <UsageBreakdown active={false} usage={usage} />, {
      height: 20,
      width: 64,
    }),
});

export const PanelsWide = story({
  description:
    "A wide main area puts runs and Latest side by side, three to two.",
  name: "Panels wide",
  render: (renderer) =>
    renderFrame(
      renderer,
      <OverviewPanels
        latest={<LatestBlock items={latest} onSelect={ignore} />}
        runs={<RunsPlaceholder />}
        wide
      />,
      { height: 14, padded: false, width: 110 }
    ),
});

export const PanelsNarrow = story({
  description: "A narrow main area stacks runs above Latest, three to one.",
  name: "Panels narrow",
  render: (renderer) =>
    renderFrame(
      renderer,
      <OverviewPanels
        latest={<LatestBlock items={latest} onSelect={ignore} />}
        runs={<RunsPlaceholder />}
        wide={false}
      />,
      { height: 24, padded: false, width: 60 }
    ),
});
