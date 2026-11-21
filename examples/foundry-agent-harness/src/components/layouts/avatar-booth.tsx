import type { ReactNode } from "react";
import { Gauge } from "@/components/blocks/gauge";
import { Plate } from "@/components/blocks/plate";
import type { Avatar } from "@/model/avatars";
import { hud } from "@/model/palette";
import { HEALTH, type Health, PORTRAIT_COLUMNS } from "@/model/sprite";

const KEYS = [
  ["←/→", "Avatar"],
  ["↑/↓", "Health"],
  ["Space", "Hit"],
] as const;

export function AvatarBooth({
  avatars,
  health,
  portraits,
  selected,
}: {
  readonly avatars: readonly Avatar[];
  readonly health: Health;
  readonly portraits: readonly ReactNode[];
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
          <box flexShrink={0} key={avatar.name} width={PORTRAIT_COLUMNS + 4}>
            <Plate
              meta={index === selected ? "selected" : undefined}
              title={avatar.name.toUpperCase()}
              tone={index === selected ? hud.amber : hud.bronze}
            >
              {portraits[index]}
            </Plate>
          </box>
        ))}
      </box>
      <box flexDirection="row" flexShrink={0} gap={2}>
        <text fg={hud.text}>
          <b>{health.toUpperCase()}</b>
        </text>
        <Gauge
          cells={PORTRAIT_COLUMNS}
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
