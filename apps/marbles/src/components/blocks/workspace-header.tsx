import { Action } from "~/components/ui/action";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import type { WorkspaceState } from "~/model/connection";

function hostLabel(state?: WorkspaceState): string {
  return state !== undefined && state !== "ready" ? state : "";
}

export function WorkspaceHeader({
  workspace,
  state,
  onHome,
  onWorkspaces,
}: {
  readonly workspace: string;
  readonly state?: WorkspaceState;
  readonly onHome: () => void;
  readonly onWorkspaces?: () => void;
}) {
  const failed = state === "failed";
  return (
    <box flexDirection="row" flexShrink={0} gap={1} height={1}>
      <Action
        active
        id="nav:home"
        label="marbles"
        onAction={onHome}
        value="home"
      />
      <text fg={theme.colors.mutedForeground} flexShrink={0}>
        /
      </text>
      {onWorkspaces ? (
        <Action
          id="nav:workspaces"
          label={`${workspace} ▾`}
          onAction={onWorkspaces}
          truncate
          value="workspaces"
        />
      ) : (
        <Text minWidth={0} truncate wrapMode="none">
          <strong>{workspace}</strong>
        </Text>
      )}
      <box flexGrow={1} />
      <text
        fg={failed ? theme.colors.error : theme.colors.mutedForeground}
        flexShrink={0}
        wrapMode="none"
      >
        {hostLabel(state)}
      </text>
    </box>
  );
}
