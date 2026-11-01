import type { ReactNode } from "react";
import { Panel } from "~/components/ui/panel";
import { SelectableRow } from "~/components/ui/selectable-row";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import type { UsageGroup, WorkspaceUsage } from "~/model/usage";
import type { DashboardSelection } from "~/views/dashboard-model";
import {
  duration,
  type LatestItem,
  type OperatingStats,
} from "~/views/operating-model";
import { costCell, costLabel, tokensLabel } from "~/views/usage-format";

/** Two lines over the runs: what is happening now, and what it has cost. */
export function OperatingSummary({
  stats,
  usage,
}: {
  readonly stats: OperatingStats;
  readonly usage?: WorkspaceUsage;
}) {
  const { counts } = stats;
  const timings = [
    stats.successRate === undefined
      ? undefined
      : `${Math.round(stats.successRate * 100)}% succeeded`,
    stats.medianRunMs === undefined
      ? undefined
      : `median run ${duration(stats.medianRunMs)}`,
    stats.medianQueueMs === undefined
      ? undefined
      : `median wait ${duration(stats.medianQueueMs)}`,
  ].filter(Boolean);
  const notes = [
    ...(usage && usage.unreadable > 0
      ? [`${usage.unreadable} usage records unreadable, totals partial`]
      : []),
    ...(usage && usage.recovered > 0
      ? [`${usage.recovered} unrecorded turns found in transcripts`]
      : []),
    ...(usage && usage.unattributed > 0
      ? [`${usage.unattributed} of them with no known run`]
      : []),
    ...(usage && usage.unsaved > 0
      ? [`${usage.unsaved} turns not saved anywhere yet`]
      : []),
  ];
  const partial = notes.map((note) => ` · ${note}`).join("");
  return (
    <box flexDirection="column" flexShrink={0} id="overview:summary">
      <box flexDirection="row" gap={2} height={1}>
        <text fg={theme.colors.info} flexShrink={0} wrapMode="none">
          Running {counts.running}
        </text>
        <text fg={theme.colors.mutedForeground} flexShrink={0} wrapMode="none">
          Queued {counts.queued}
        </text>
        <text
          fg={
            counts.waiting > 0
              ? theme.colors.warning
              : theme.colors.mutedForeground
          }
          flexShrink={0}
          wrapMode="none"
        >
          Waiting {counts.waiting}
        </text>
        <text
          fg={
            counts.failed > 0
              ? theme.colors.error
              : theme.colors.mutedForeground
          }
          flexShrink={0}
          wrapMode="none"
        >
          Failed {counts.failed}
        </text>
        <text fg={theme.colors.success} flexShrink={0} wrapMode="none">
          Completed {counts.complete}
        </text>
        <text fg={theme.colors.mutedForeground} flexShrink={0} wrapMode="none">
          Cancelled {counts.cancelled}
        </text>
        <text
          fg={theme.colors.mutedForeground}
          flexGrow={1}
          minWidth={0}
          wrapMode="none"
        >
          {timings.join(" · ")}
        </text>
      </box>
      <text fg={theme.colors.mutedForeground} wrapMode="none">
        Usage: {costLabel(usage?.total)} · {tokensLabel(usage?.total)}
        {partial}
      </text>
    </box>
  );
}

/** Newest run starts, endings, and feed entries in this workspace. */
export function LatestBlock({
  items,
  onSelect,
}: {
  readonly items: readonly LatestItem[];
  readonly onSelect: (selection: DashboardSelection) => void;
}) {
  return (
    <Panel id="panel:latest" title="Latest">
      {items.length === 0 && <Text>Nothing has happened yet.</Text>}
      {items.map((item) =>
        item.runId === undefined ? (
          <Text key={item.id}>{item.text}</Text>
        ) : (
          <SelectableRow
            id={`latest:${item.id}`}
            key={item.id}
            onSelect={onSelect}
            selected={false}
            value={{ id: item.runId, kind: "run" } as DashboardSelection}
          >
            <text
              fg={theme.colors.mutedForeground}
              flexShrink={0}
              wrapMode="none"
            >
              {new Date(item.at).toLocaleTimeString()}
            </text>
            <Text wrapMode="none">{item.text}</Text>
          </SelectableRow>
        )
      )}
    </Panel>
  );
}

const TOP_GROUPS = 5;

function Groups({
  title,
  groups,
}: {
  readonly title: string;
  readonly groups: readonly UsageGroup[];
}) {
  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={theme.colors.mutedForeground}>{title}</text>
      {groups.length === 0 && <Text>None recorded.</Text>}
      {groups.slice(0, TOP_GROUPS).map((group) => (
        <box flexDirection="row" gap={1} height={1} key={group.id}>
          <Text wrapMode="none">{group.id}</Text>
          <text fg={theme.colors.mutedForeground} wrapMode="none">
            {costCell(group.total)} · {group.total.turns}{" "}
            {group.total.turns === 1 ? "turn" : "turns"}
          </text>
        </box>
      ))}
      {groups.length > TOP_GROUPS && (
        <text fg={theme.colors.mutedForeground} wrapMode="none">
          +{groups.length - TOP_GROUPS} more · u shows all
        </text>
      )}
    </box>
  );
}

function BreakdownRows({
  title,
  groups,
}: {
  readonly title: string;
  readonly groups: readonly UsageGroup[];
}) {
  return (
    <box flexDirection="column" flexShrink={0}>
      <Text>
        <strong>{title}</strong>
      </Text>
      {groups.length === 0 && <Text>None recorded.</Text>}
      {groups.map((group) => (
        <box flexDirection="column" flexShrink={0} key={group.id}>
          <Text>
            {group.id}: {costLabel(group.total)}
          </Text>
          <text fg={theme.colors.mutedForeground}>
            {"  "}
            {tokensLabel(group.total)}
          </text>
        </box>
      ))}
    </box>
  );
}

/**
 * Every workflow's and agent's usage, at any width: what the Usage panel
 * shortens or, in narrow terminals, leaves out. Scrolls with the keyboard.
 */
export function UsageBreakdown({
  active,
  usage,
}: {
  readonly active: boolean;
  readonly usage?: WorkspaceUsage;
}) {
  return (
    <Panel
      active={active}
      id="panel:usage-breakdown"
      scrollable={active}
      title="Usage · every workflow and agent · ~ estimate"
    >
      {usage ? (
        <box flexDirection="column" gap={1}>
          <box flexDirection="column" flexShrink={0}>
            <Text>Workspace: {costLabel(usage.total)}</Text>
            <text fg={theme.colors.mutedForeground}>
              {"  "}
              {tokensLabel(usage.total)}
            </text>
            {costLabel(usage.outsideRuns) !== "no usage recorded" && (
              <Text>Outside runs: {costLabel(usage.outsideRuns)}</Text>
            )}
            {usage.unreadable > 0 && (
              <text fg={theme.colors.warning}>
                {usage.unreadable} usage records could not be read; every total
                is partial.
              </text>
            )}
            {usage.recovered > 0 && (
              <text fg={theme.colors.warning}>
                {usage.recovered} turns had no saved usage; their tokens come
                from the session transcripts, and their cost is unknown.
              </text>
            )}
            {usage.unattributed > 0 && (
              <text fg={theme.colors.warning}>
                {usage.unattributed} of those turns are in sessions no record
                ties to a run or to work outside runs; every total they may
                belong to says so.
              </text>
            )}
            {usage.unsaved > 0 && (
              <text fg={theme.colors.warning}>
                {usage.unsaved} turns' usage could not be saved and no
                transcript accounts for them yet; they are counted until Marbles
                stops.
              </text>
            )}
          </box>
          <BreakdownRows groups={usage.byWorkflow} title="By workflow" />
          <BreakdownRows groups={usage.byAgent} title="By agent" />
        </box>
      ) : (
        <Text>Usage is not recorded by this host.</Text>
      )}
    </Panel>
  );
}

/** Agent consumption by workflow and by agent; `~` marks an estimate. */
export function UsageBlock({ usage }: { readonly usage?: WorkspaceUsage }) {
  return (
    <Panel id="panel:usage" title="Usage · ~ estimate · ? unpriced">
      {usage ? (
        <box flexDirection="column" gap={1}>
          <Groups groups={usage.byWorkflow} title="By workflow" />
          <Groups groups={usage.byAgent} title="By agent" />
        </box>
      ) : (
        <Text>Usage is not recorded by this host.</Text>
      )}
    </Panel>
  );
}

/** Runs beside Latest and Usage when there is room, stacked when there is not. */
export function OverviewPanels({
  runs,
  latest,
  usage,
  wide,
}: {
  readonly runs: ReactNode;
  readonly latest: ReactNode;
  readonly usage: ReactNode;
  readonly wide: boolean;
}) {
  if (!wide) {
    return (
      <box flexDirection="column" flexGrow={1} minHeight={0}>
        <box flexDirection="column" flexGrow={3} minHeight={3}>
          {runs}
        </box>
        <box flexDirection="column" flexGrow={1} minHeight={3}>
          {latest}
        </box>
      </box>
    );
  }
  return (
    <box flexDirection="row" flexGrow={1} gap={1} minHeight={0}>
      <box flexBasis={0} flexDirection="column" flexGrow={3} minWidth={0}>
        {runs}
      </box>
      <box flexBasis={0} flexDirection="column" flexGrow={2} minWidth={0}>
        <box flexDirection="column" flexGrow={1} minHeight={3}>
          {latest}
        </box>
        <box flexDirection="column" flexGrow={1} minHeight={3}>
          {usage}
        </box>
      </box>
    </box>
  );
}
