import type { HostedWorkspace } from "~/cli/state/use-dashboard";
import { Action } from "~/components/ui/action";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";

function hostLabel(hosted?: HostedWorkspace): string {
  return hosted && hosted.state !== "ready" ? hosted.state : "";
}

export function WorkspaceHeader({
  workspace,
  hosted,
  onHome,
  onWorkspaces,
}: {
  readonly workspace: string;
  readonly hosted?: HostedWorkspace;
  readonly onHome: () => void;
  readonly onWorkspaces?: () => void;
}) {
  const failed = hosted?.state === "failed";
  return (
    <box flexDirection="row" flexShrink={0} gap={1} height={1}>
      <Action
        active
        id="nav:home"
        label="marbles"
        onAction={onHome}
        value="home"
      />
      <text fg={theme.colors.mutedForeground}>/</text>
      {onWorkspaces ? (
        <Action
          id="nav:workspaces"
          label={`${workspace} ▾`}
          onAction={onWorkspaces}
          value="workspaces"
        />
      ) : (
        <Text wrapMode="none">
          <strong>{workspace}</strong>
        </Text>
      )}
      <box flexGrow={1} />
      <text fg={failed ? theme.colors.error : theme.colors.mutedForeground}>
        {hostLabel(hosted)}
      </text>
    </box>
  );
}
