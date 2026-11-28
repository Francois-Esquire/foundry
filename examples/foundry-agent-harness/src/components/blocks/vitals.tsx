import { Gauge } from "@/components/blocks/gauge";
import type { Progress } from "@/game/progress";
import { hud } from "@/model/palette";
import { HEALTH, type Health } from "@/model/sprite";
import { compactCount, type Tokens } from "@/model/thread";

const CELLS = 30;

export function totalsLine({ input, output }: Tokens): string {
  return `${compactCount(input)} in · ${compactCount(output)} out`;
}

const XP_CELLS = 12;
const TONES = [hud.ok, hud.ok, hud.amber, hud.red, hud.red];

export function Vitals({
  health,
  limit,
  progress,
  tokens,
  used,
}: {
  readonly health: Health;
  readonly limit: number;
  readonly progress: Progress;
  readonly tokens: number;
  readonly used: number;
}) {
  const tone = TONES[HEALTH.indexOf(health)] ?? hud.amber;
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={hud.text}>Context left</text>
        <box flexGrow={1} />
        <text fg={tone}>
          <b>{`${compactCount(tokens)} / ${compactCount(limit)}`}</b>
        </text>
      </box>
      <Gauge cells={CELLS} level={1 - used} tone={tone} />
      <box flexDirection="row" gap={1} height={1}>
        <text fg={hud.bright} flexShrink={0} wrapMode="none">
          <b>{`LV ${progress.level}`}</b>
        </text>
        <Gauge
          cells={XP_CELLS}
          level={progress.into / progress.needed}
          tone={hud.amber}
        />
        <box flexGrow={1} />
        <text fg={hud.dim} flexShrink={0} wrapMode="none">
          {`${progress.into}/${progress.needed} xp`}
        </text>
      </box>
    </box>
  );
}
