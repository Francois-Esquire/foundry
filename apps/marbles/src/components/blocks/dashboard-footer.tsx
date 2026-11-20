import { Action } from "~/components/ui/action";
import { theme } from "~/components/ui/theme";

const SEPARATOR = "·";

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
  const entries = shortcuts.split(` ${SEPARATOR} `);
  return (
    <box
      columnGap={2}
      flexDirection="row"
      flexShrink={0}
      flexWrap="wrap"
      justifyContent="space-between"
    >
      <box flexDirection="row" flexShrink={0} gap={2}>
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
      <box flexDirection="row" flexShrink={1} gap={2} minWidth={0}>
        <box
          columnGap={1}
          flexDirection="row"
          flexShrink={1}
          flexWrap="wrap"
          minWidth={0}
        >
          {entries.map((entry, index) => (
            <text
              fg={theme.colors.mutedForeground}
              flexShrink={0}
              key={`${index}:${entry}`}
              wrapMode="none"
            >
              {index < entries.length - 1 ? `${entry} ${SEPARATOR}` : entry}
            </text>
          ))}
        </box>
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
