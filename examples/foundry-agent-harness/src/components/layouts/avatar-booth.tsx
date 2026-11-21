import { Gauge } from "@/components/blocks/gauge";
import { Plate } from "@/components/blocks/plate";
import { Portrait } from "@/components/blocks/portrait";
import type { Avatar } from "@/model/avatars";
import { hud } from "@/model/palette";
import { HEALTH, type Health, SPRITE_SIZE } from "@/model/sprite";

const KEYS = [
  ["←/→", "Avatar"],
  ["↑/↓", "Health"],
  ["Space", "Hit"],
] as const;

export function AvatarBooth({
  avatars,
  frame,
  health,
  hurtAt,
  selected,
}: {
  readonly avatars: readonly Avatar[];
  readonly frame: number;
  readonly health: Health;
  readonly hurtAt: number | null;
  readonly selected: number;
}) {
  const remaining = 1 - HEALTH.indexOf(health) / (HEALTH.length - 1);
  return (
    <box
      backgroundColor={hud.ink}
      flexDirection="column"
      gap={1}
      height="100%"
      paddingX={1}
      width="100%"
    >
      <box flexDirection="row" flexShrink={0} gap={1}>
        {avatars.map((avatar, index) => (
          <box flexShrink={0} key={avatar.name} width={SPRITE_SIZE + 4}>
            <Plate
              meta={index === selected ? "selected" : undefined}
              title={avatar.name.toUpperCase()}
              tone={index === selected ? hud.amber : hud.bronze}
            >
              <Portrait
                avatar={avatar}
                frame={frame}
                health={health}
                hurtAt={hurtAt}
                seed={index + 1}
              />
            </Plate>
          </box>
        ))}
      </box>
      <box flexDirection="row" flexShrink={0} gap={2}>
        <text fg={hud.text}>
          <b>{health.toUpperCase()}</b>
        </text>
        <Gauge
          cells={SPRITE_SIZE}
          level={remaining}
          tone={remaining > 0.5 ? hud.ok : hud.red}
        />
      </box>
      <text fg={hud.dim} wrapMode="none">
        {KEYS.map(([key, action]) => (
          <span key={key}>
            <span bg={hud.tint} fg={hud.amber}>{` ${key} `}</span>
            {` ${action}   `}
          </span>
        ))}
      </text>
    </box>
  );
}
