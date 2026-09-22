import { Action } from "~/components/action";
import { useTheme } from "~/hooks/use-theme";

export function WorkspaceHeader({
  workspace,
  preview,
  onHome,
}: {
  readonly workspace: string;
  readonly preview: boolean;
  readonly onHome: () => void;
}) {
  const theme = useTheme();
  return (
    <box flexDirection="row" flexShrink={0} gap={1} height={1}>
      <Action
        active
        id="nav:home"
        label="quirks"
        onAction={onHome}
        value="home"
      />
      <text fg={theme.colors.mutedForeground}>/</text>
      <text fg={theme.colors.foreground} flexGrow={1} wrapMode="none">
        <strong>{workspace}</strong>
      </text>
      <text fg={theme.colors.mutedForeground}>
        {preview ? "preview" : "live"}
      </text>
    </box>
  );
}
