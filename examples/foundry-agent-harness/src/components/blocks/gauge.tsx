import { hud } from "@/model/palette";

export function Gauge({
  cells,
  level,
  tone,
}: {
  readonly cells: number;
  readonly level: number;
  readonly tone: string;
}) {
  const filled = Math.round(Math.min(Math.max(level, 0), 1) * cells);
  return (
    <text fg={tone} wrapMode="none">
      {"█".repeat(filled)}
      <span fg={hud.trough}>{"█".repeat(cells - filled)}</span>
    </text>
  );
}
