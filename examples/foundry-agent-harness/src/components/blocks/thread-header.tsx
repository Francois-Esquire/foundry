import { Hint } from "@/components/blocks/hint";
import { useTheme } from "@/hooks/use-theme";

const NAME = "Foundry Agent Harness";
const CHROME = 8;

const SHORTEST_TITLE = 4;

function shortened(text: string, room: number): string {
  return text.length > room ? `${text.slice(0, room - 1)}…` : text;
}

function details(title: string, model: string, room: number): string {
  if (room >= SHORTEST_TITLE) {
    return `· ${shortened(title, room)} · ${model}`;
  }
  return room + SHORTEST_TITLE >= 0 ? `· ${model}` : "";
}

export function ThreadHeader({
  model,
  title,
  width,
}: {
  readonly model: string;
  readonly title: string;
  readonly width: number;
}) {
  const theme = useTheme();
  const room = width - NAME.length - model.length - CHROME;
  return (
    <box flexDirection="row" gap={1} height={1} paddingLeft={1}>
      <text fg={theme.colors.primary}>
        <b>{NAME}</b>
      </text>
      <Hint>{details(title, model, room)}</Hint>
    </box>
  );
}
