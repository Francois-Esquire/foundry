import { Hint } from "@/components/blocks/hint";
import { useTheme } from "@/hooks/use-theme";

function compact(count: number): string {
  return count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`;
}

export function StatusLine({
  input,
  output,
  panel,
}: {
  readonly input: number;
  readonly output: number;
  readonly panel: boolean;
}) {
  const theme = useTheme();
  return (
    <box flexDirection="row" gap={1} height={1} paddingLeft={1}>
      <box flexShrink={0}>
        <Hint>{`${compact(input)} in · ${compact(output)} out`}</Hint>
      </box>
      <text fg={theme.colors.mutedForeground} flexShrink={1} wrapMode="none">
        {`· Enter run${panel ? " · Tab panel" : ""} · PgUp/PgDn scroll · Ctrl+C quit`}
      </text>
    </box>
  );
}
