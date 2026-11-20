import { Panel } from "~/components/ui/panel";
import { SelectableRow } from "~/components/ui/selectable-row";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import type { WorkspaceSummary } from "~/model/connection";

export interface WorkspaceRow extends WorkspaceSummary {
  readonly label: string;
  readonly qualified: boolean;
}

export interface WorkspaceDetails {
  readonly error?: string;
  readonly root: string;
}

function Details({ details }: { readonly details: WorkspaceDetails }) {
  return (
    <box flexDirection="column" marginTop={1}>
      <Text>{details.root}</Text>
      {details.error && <text fg={theme.colors.error}>{details.error}</text>}
    </box>
  );
}

export function WorkspacesPanel({
  compact,
  current,
  details,
  onSelect,
  selected,
  workspaces,
}: {
  readonly compact?: boolean;
  readonly current?: string;
  readonly details?: WorkspaceDetails;
  readonly onSelect: (id: string) => void;
  readonly selected: string;
  readonly workspaces: readonly WorkspaceRow[];
}) {
  const prefix = compact ? "workspace-rail" : "workspace";
  return (
    <Panel
      active={!compact}
      id={`panel:${prefix}`}
      selectedId={`${prefix}:${selected}`}
      title="Workspaces"
    >
      {workspaces.map((workspace) => (
        <SelectableRow
          id={`${prefix}:${workspace.id}`}
          key={workspace.id}
          onSelect={onSelect}
          selected={workspace.id === selected}
          value={workspace.id}
        >
          <box
            columnGap={1}
            flexDirection={compact && workspace.qualified ? "column" : "row"}
            flexWrap={compact ? "wrap" : "no-wrap"}
            minWidth={0}
          >
            <Text minWidth={0} truncate wrapMode="none">
              {workspace.label}
            </Text>
            <box flexDirection="row" flexShrink={0} gap={1}>
              {workspace.id === current && <Text wrapMode="none">current</Text>}
              <text
                fg={
                  workspace.state === "failed"
                    ? theme.colors.error
                    : theme.colors.mutedForeground
                }
                wrapMode="none"
              >
                {workspace.state}
              </text>
            </box>
          </box>
        </SelectableRow>
      ))}
      {details && <Details details={details} />}
    </Panel>
  );
}
