import { Action } from "~/components/ui/action";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";

export function WorkspaceHeader({
  workspace,
  preview,
  onHome,
}: {
  readonly workspace: string;
  readonly preview: boolean;
  readonly onHome: () => void;
}) {
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
      <text fg={theme.colors.mutedForeground}>
        {preview ? "preview" : "live"}
      </text>
    </box>
  );
}
