import { Action } from "~/components/ui/action";
import { theme } from "~/components/ui/theme";

export function DashboardFooter({
  shortcuts,
  onWorkspaces,
  onDiagnostics,
  onSettings,
}: {
  readonly shortcuts: string;
  readonly onWorkspaces?: () => void;
  readonly onDiagnostics: () => void;
  readonly onSettings: () => void;
}) {
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      flexWrap="wrap"
      gap={2}
      justifyContent="space-between"
    >
      <box flexDirection="row" gap={2}>
        {onWorkspaces && (
          <Action
            label="w Workspaces"
            onAction={onWorkspaces}
            value="workspaces"
          />
        )}
        <Action
          id="view:logs"
          label="d Diagnostics"
          onAction={onDiagnostics}
          value="logs"
        />
      </box>
      <box flexDirection="row" gap={2}>
        <text fg={theme.colors.mutedForeground} wrapMode="none">
          {shortcuts}
        </text>
        <Action
          id="view:settings"
          label="S Settings"
          onAction={onSettings}
          value="settings"
        />
      </box>
    </box>
  );
}
