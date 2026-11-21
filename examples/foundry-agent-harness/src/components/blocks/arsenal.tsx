import { hud } from "@/model/palette";
import type { Tally } from "@/model/thread";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PIPS = 8;

function mark(tally: Tally, frame: number) {
  if (tally.running) {
    return { icon: SPINNER[frame % SPINNER.length] ?? "⠋", tone: hud.amber };
  }
  return tally.failed > 0
    ? { icon: "✗", tone: hud.red }
    : { icon: "●", tone: hud.ok };
}

export function Arsenal({
  frame,
  tallies,
}: {
  readonly frame: number;
  readonly tallies: readonly Tally[];
}) {
  if (tallies.length === 0) {
    return <text fg={hud.dim}>No tools fired yet.</text>;
  }
  return (
    <box flexDirection="column">
      {tallies.map((tally) => {
        const { icon, tone } = mark(tally, frame);
        return (
          <box flexDirection="row" gap={1} height={1} key={tally.name}>
            <text fg={tone}>{icon}</text>
            <text fg={hud.text} flexShrink={1} truncate wrapMode="none">
              {tally.name}
            </text>
            <box flexGrow={1} />
            <text fg={hud.bronze} flexShrink={0} wrapMode="none">
              {"▮".repeat(Math.min(tally.count, PIPS))}
            </text>
            <text fg={hud.dim} flexShrink={0}>{`×${tally.count}`}</text>
          </box>
        );
      })}
    </box>
  );
}
