import { Action } from "~/components/action";
import { useTheme } from "~/hooks/use-theme";

export function EmptyState({
  title,
  description,
  onReset,
}: {
  readonly title: string;
  readonly description: string;
  readonly onReset?: () => void;
}) {
  const theme = useTheme();
  return (
    <box flexDirection="column" paddingX={1}>
      <text fg={theme.colors.foreground}>
        <strong>◇ {title}</strong>
      </text>
      <text fg={theme.colors.mutedForeground}>{description}</text>
      {onReset && (
        <Action
          id="empty:reset"
          label="x Clear filters"
          onAction={onReset}
          value="reset"
        />
      )}
    </box>
  );
}
