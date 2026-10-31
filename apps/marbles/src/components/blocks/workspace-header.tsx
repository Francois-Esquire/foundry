import { Action } from "~/components/ui/action";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import type { HostedWorkspace } from "~/views/use-dashboard";

/** How the header names where the workspace runs and how it is doing. */
function hostLabel(preview: boolean, hosted?: HostedWorkspace): string {
  if (preview) {
    return "preview";
  }
  if (!hosted) {
    return "live";
  }
  const position =
    hosted.count > 1 ? `${hosted.position}/${hosted.count} · ` : "";
  return `${position}${hosted.state}`;
}

export function WorkspaceHeader({
  workspace,
  preview,
  hosted,
  onHome,
}: {
  readonly workspace: string;
  readonly preview: boolean;
  readonly hosted?: HostedWorkspace;
  readonly onHome: () => void;
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
      <Text flexGrow={1} wrapMode="none">
        <strong>{workspace}</strong>
      </Text>
      <text fg={failed ? theme.colors.error : theme.colors.mutedForeground}>
        {hostLabel(preview, hosted)}
      </text>
    </box>
  );
}
