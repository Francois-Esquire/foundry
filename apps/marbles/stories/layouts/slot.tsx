import { theme } from "~/components/ui/theme";

export function Slot({
  detail,
  grow = true,
  label,
  tone = theme.colors.mutedForeground,
}: {
  readonly detail?: string;
  readonly grow?: boolean;
  readonly label: string;
  readonly tone?: string;
}) {
  return (
    <box
      border
      borderColor={tone}
      borderStyle="rounded"
      flexDirection="column"
      flexGrow={grow ? 1 : 0}
      flexShrink={grow ? 1 : 0}
      minHeight={3}
      minWidth={0}
      paddingX={1}
    >
      <text fg={tone} wrapMode="none">
        <strong>{label}</strong>
      </text>
      {detail && (
        <text fg={theme.colors.mutedForeground} wrapMode="word">
          {detail}
        </text>
      )}
    </box>
  );
}
