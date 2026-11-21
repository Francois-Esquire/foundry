import { hud } from "@/model/palette";

const TICK_EVERY = 4;

export function Gauge({
  cells,
  level,
  ticks = false,
  tone,
}: {
  readonly cells: number;
  readonly level: number;
  readonly ticks?: boolean;
  readonly tone: string;
}) {
  const filled = Math.round(Math.min(Math.max(level, 0), 1) * cells);
  const scale = Array.from({ length: cells }, (_, cell) =>
    cell % TICK_EVERY === 0 ? "╵" : " "
  ).join("");
  return (
    <box flexDirection="column">
      <text wrapMode="none">
        <span fg={hud.bronze}>▕</span>
        <span fg={tone}>{"▰".repeat(filled)}</span>
        <span fg={hud.trough}>{"▱".repeat(cells - filled)}</span>
        <span fg={hud.bronze}>▏</span>
      </text>
      {ticks ? (
        <text fg={hud.faint} wrapMode="none">{` ${scale}╵`}</text>
      ) : null}
    </box>
  );
}
