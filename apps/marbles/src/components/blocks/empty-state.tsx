import { Action } from "~/components/ui/action";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import { Words } from "~/components/ui/words";

export function EmptyState({
  title,
  description,
  onReset,
  resetLabel = "Clear filters",
}: {
  readonly title: string;
  readonly description: string;
  readonly onReset?: () => void;
  readonly resetLabel?: string;
}) {
  return (
    <box flexDirection="column" flexShrink={0} paddingX={1}>
      <Text>
        <strong>◇ {title}</strong>
      </Text>
      <Words fg={theme.colors.mutedForeground}>{description}</Words>
      {onReset && (
        <Action
          id="empty:reset"
          label={`x ${resetLabel}`}
          onAction={onReset}
          value="reset"
        />
      )}
    </box>
  );
}
