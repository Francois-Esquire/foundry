import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";

export interface RunStreamView {
  readonly lines: readonly string[];
  readonly live: boolean;
  readonly received: boolean;
}

export function RunStream({
  stream,
  tail,
}: {
  readonly stream: RunStreamView;
  readonly tail: number;
}) {
  const { lines, live, received } = stream;
  if (!(live || received)) {
    return <Text>No output to show for this run.</Text>;
  }
  return (
    <box flexDirection="column" flexShrink={0}>
      {!received && <Text>Waiting for output…</Text>}
      {lines.map((line, index) => (
        <Text height={1} key={`${String(index)}:${line}`} wrapMode="none">
          {line}
        </Text>
      ))}
      <text fg={theme.colors.mutedForeground}>
        {live ? "Live" : "Ended"} · last {String(tail)} lines · leaving this tab
        does not stop the work
      </text>
    </box>
  );
}
