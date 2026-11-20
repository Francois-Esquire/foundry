import { Panel } from "~/components/ui/panel";
import { SelectableRow } from "~/components/ui/selectable-row";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import type { WorkspaceSummary } from "~/model/connection";

export interface WorkspaceRow extends WorkspaceSummary {
  readonly label: string;
  readonly qualified: boolean;
}

export function WorkspacesPanel({
  compact,
  current,
  onSelect,
  selected,
  workspaces,
}: {
  readonly compact?: boolean;
  readonly current?: string;
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
            flexDirection={compact && workspace.qualified ? "column" : "row"}
            minWidth={0}
          >
            <Text minWidth={0} truncate wrapMode="none">
              {workspace.label}
            </Text>
            <box
              flexDirection="row"
              flexShrink={0}
              gap={1}
              paddingLeft={compact && workspace.qualified ? 0 : 1}
            >
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
      {!compact &&
        workspaces
          .filter((item) => item.id === selected)
          .map((item) => (
            <box flexDirection="column" key={item.id} marginTop={1}>
              <Text>{item.root}</Text>
              {item.error && <text fg={theme.colors.error}>{item.error}</text>}
            </box>
          ))}
    </Panel>
  );
}
