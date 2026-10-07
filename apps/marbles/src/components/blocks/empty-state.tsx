import { Action } from "~/components/ui/action";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";

export function EmptyState({
  title,
  description,
  onReset,
}: {
  readonly title: string;
  readonly description: string;
  readonly onReset?: () => void;
}) {
  return (
    <box flexDirection="column" paddingX={1}>
      <Text>
        <strong>◇ {title}</strong>
      </Text>
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
