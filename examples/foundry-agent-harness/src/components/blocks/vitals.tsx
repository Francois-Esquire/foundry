import { Gauge } from "@/components/blocks/gauge";
import { hud } from "@/model/palette";
import { HEALTH, type Health } from "@/model/sprite";
import { compactCount } from "@/model/thread";

const CELLS = 30;
const TONES = [hud.ok, hud.ok, hud.amber, hud.red, hud.red];

export function Vitals({
  health,
  input,
  output,
  tokens,
  used,
  limit,
}: {
  readonly health: Health;
  readonly input: number;
  readonly output: number;
  readonly tokens: number;
  readonly used: number;
  readonly limit: number;
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
      <text fg={hud.dim} wrapMode="none">
        {`${compactCount(input)} in · ${compactCount(output)} out`}
      </text>
    </box>
  );
}
