import type { ReactNode } from "react";
import { Panel } from "~/components/ui/panel";
import { SelectableRow } from "~/components/ui/selectable-row";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import { Words } from "~/components/ui/words";

export interface LatestRow<S> {
  readonly at: number;
  readonly id: string;
  readonly selection?: S;
  readonly text: string;
}

export interface UsageLine {
  readonly cost: string;
  readonly tokens: string;
}

export interface UsageGroupLine extends UsageLine {
  readonly id: string;
}

export interface UsageBreakdownView {
  readonly byAgent: readonly UsageGroupLine[];
  readonly byWorkflow: readonly UsageGroupLine[];
  readonly outsideRuns?: string;
  readonly recovered: number;
  readonly total: UsageLine;
  readonly unattributed: number;
  readonly unreadable: number;
  readonly unsaved: number;
}

export function LatestBlock<S>({
  items,
  onSelect,
}: {
  readonly items: readonly LatestRow<S>[];
  readonly onSelect: (selection: S) => void;
}) {
  return (
    <Panel id="panel:latest" title="Latest">
      {items.length === 0 && <Text>Nothing has happened yet.</Text>}
      {items.map((item) =>
        item.selection === undefined ? (
          <Text key={item.id}>{item.text}</Text>
        ) : (
          <SelectableRow
            id={`latest:${item.id}`}
            key={item.id}
            onSelect={onSelect}
            selected={false}
            value={item.selection}
          >
            <text
              fg={theme.colors.mutedForeground}
              flexShrink={0}
              wrapMode="none"
            >
              {new Date(item.at).toLocaleTimeString(undefined, {
                hour: "2-digit",
                hourCycle: "h23",
                minute: "2-digit",
              })}
            </text>
            <Text minWidth={0} truncate wrapMode="none">
              {item.text}
            </Text>
          </SelectableRow>
        )
      )}
    </Panel>
  );
}

function BreakdownRows({
  title,
  groups,
}: {
  readonly title: string;
  readonly groups: readonly UsageGroupLine[];
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
            {group.id}: {group.cost}
          </Text>
          <Words fg={theme.colors.mutedForeground} indent={2}>
            {group.tokens}
          </Words>
        </box>
      ))}
    </box>
  );
}

function usageWarnings(usage: UsageBreakdownView): readonly string[] {
  const { recovered, unattributed, unreadable, unsaved } = usage;
  const warnings: string[] = [];
  if (unreadable > 0) {
    warnings.push(
      unreadable === 1
        ? "1 usage record could not be read; every total is partial."
        : `${String(unreadable)} usage records could not be read; every total is partial.`
    );
  }
  if (recovered > 0) {
    warnings.push(
      recovered === 1
        ? "1 turn had no saved usage; its tokens come from the session transcripts, and its cost is unknown."
        : `${String(recovered)} turns had no saved usage; their tokens come from the session transcripts, and their cost is unknown.`
    );
  }
  if (unattributed > 0) {
    warnings.push(
      unattributed === 1
        ? "1 of those turns is in a session no record ties to a run or to work outside runs; every total it may belong to says so."
        : `${String(unattributed)} of those turns are in sessions no record ties to a run or to work outside runs; every total they may belong to says so.`
    );
  }
  if (unsaved > 0) {
    warnings.push(
      unsaved === 1
        ? "1 turn's usage could not be saved and no transcript accounts for it yet; it is counted until Marbles stops."
        : `${String(unsaved)} turns' usage could not be saved and no transcript accounts for them yet; they are counted until Marbles stops.`
    );
  }
  return warnings;
}

export function UsageBreakdown({
  active,
  usage,
}: {
  readonly active: boolean;
  readonly usage?: UsageBreakdownView;
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
            <Text>Workspace: {usage.total.cost}</Text>
            <Words fg={theme.colors.mutedForeground} indent={2}>
              {usage.total.tokens}
            </Words>
            {usage.outsideRuns !== undefined && (
              <Text>Outside runs: {usage.outsideRuns}</Text>
            )}
            {usageWarnings(usage).map((warning) => (
              <text fg={theme.colors.warning} key={warning}>
                {warning}
              </text>
            ))}
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

export function OverviewPanels({
  runs,
  latest,
  wide,
}: {
  readonly runs: ReactNode;
  readonly latest: ReactNode;
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
        {latest}
      </box>
    </box>
  );
}
