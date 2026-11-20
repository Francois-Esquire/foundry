import { basename, dirname, join, sep } from "node:path";
import { Panel } from "~/components/ui/panel";
import { SelectableRow } from "~/components/ui/selectable-row";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import type { WorkspaceSummary } from "~/model/connection";

function workspaceLabel(
  root: string,
  workspaces: readonly WorkspaceSummary[]
): string {
  let label = basename(root);
  let parent = dirname(root);
  while (
    workspaces.some(
      (other) => other.root !== root && other.root.endsWith(sep + label)
    )
  ) {
    if (parent === dirname(parent)) {
      return root;
    }
    label = join(basename(parent), label);
    parent = dirname(parent);
  }
  return label;
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
  readonly workspaces: readonly WorkspaceSummary[];
}) {
  const prefix = compact ? "workspace-rail" : "workspace";
  return (
    <Panel
      active={!compact}
      id={`panel:${prefix}`}
      selectedId={`${prefix}:${selected}`}
      title="Workspaces"
    >
      {workspaces.map((workspace) => {
        const label = workspaceLabel(workspace.root, workspaces);
        return (
          <SelectableRow
            id={`${prefix}:${workspace.id}`}
            key={workspace.id}
            onSelect={onSelect}
            selected={workspace.id === selected}
            value={workspace.id}
          >
            <box
              flexDirection={
                compact && label !== basename(workspace.root) ? "column" : "row"
              }
              minWidth={0}
            >
              <Text minWidth={0} truncate wrapMode="none">
                {label}
              </Text>
              <box
                flexDirection="row"
                flexShrink={0}
                gap={1}
                paddingLeft={
                  compact && label !== basename(workspace.root) ? 0 : 1
                }
              >
                {workspace.id === current && (
                  <Text wrapMode="none">current</Text>
                )}
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
        );
      })}
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
