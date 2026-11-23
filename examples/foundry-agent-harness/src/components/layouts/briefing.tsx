import type { BoxRenderable } from "@opentui/core";
import { type ReactNode, useCallback } from "react";
import { HintBar } from "@/components/blocks/hint-bar";
import { Loadout } from "@/components/blocks/loadout";
import { Plate } from "@/components/blocks/plate";
import { Weapon } from "@/components/blocks/weapon";
import type { Avatar } from "@/model/avatars";
import { type Context, slotsOf } from "@/model/context";
import { hud } from "@/model/palette";
import { BRIEFING_STOPS, focusOn, type Rail } from "@/model/rail";
import type { Size } from "@/model/screen";
import { PORTRAIT_SIZES, type PortraitSize } from "@/model/sprite";

const CARD_CHROME = 4;
const CARD_MIN = 24;
const GAP = 1;
const WEAPON_WIDTH = 36;
const TALL = 36;
const TURNS = {
  avatar: "Character",
  effort: "Ammo",
  model: "Gun",
  slot: "Character",
} as const;

export function briefingGeometry({ height, width }: Size, avatars: number) {
  const portrait: PortraitSize = height >= TALL ? "large" : "small";
  const card = Math.max(
    PORTRAIT_SIZES[portrait].columns + CARD_CHROME,
    CARD_MIN
  );
  return {
    card,
    lineup: width >= avatars * card + (avatars - 1) * GAP + 2,
    portrait,
  };
}

function Character({
  avatar,
  count,
  focused,
  index,
  portrait,
  selected,
  width,
}: {
  readonly avatar: Avatar;
  readonly count: number;
  readonly focused: boolean;
  readonly index: number;
  readonly portrait: ReactNode;
  readonly selected: boolean;
  readonly width: number;
}) {
  const chosen = focused ? `◂ ${index + 1}/${count} ▸` : "chosen";
  return (
    <box flexShrink={0} width={width}>
      <Plate
        icon="☻"
        meta={selected ? chosen : undefined}
        title={avatar.name.toUpperCase()}
        tone={selected ? hud.amber : hud.bronze}
      >
        {portrait}
      </Plate>
    </box>
  );
}

export function BriefingLayout({
  avatars,
  context,
  onResize,
  portraits,
  rail,
  size,
}: {
  readonly avatars: readonly Avatar[];
  readonly context: Context;
  readonly onResize: (size: Size) => void;
  readonly portraits: readonly ReactNode[];
  readonly rail: Rail;
  readonly size: Size;
}) {
  const geometry = briefingGeometry(size, avatars.length);
  const focus = focusOn(rail, BRIEFING_STOPS);
  const aiming = focus === "model" || focus === "effort" ? focus : null;
  const slots = slotsOf(context);
  const shown = avatars
    .map((avatar, index) => ({ avatar, index }))
    .filter(({ index }) => geometry.lineup || index === rail.avatar);
  const measure = useCallback(
    function measureBriefing(this: BoxRenderable) {
      onResize({ height: this.height, width: this.width });
    },
    [onResize]
  );
  return (
    <box
      backgroundColor={hud.ink}
      flexDirection="column"
      height="100%"
      onSizeChange={measure}
      width="100%"
    >
      <box flexDirection="column" flexGrow={1} flexShrink={1} gap={GAP}>
        <Plate meta="new mission" title="GET STARTED">
          <text fg={hud.text} wrapMode="word">
            Pick who goes in and what they carry. The gun and ammo stay for the
            whole mission, and your first goal names it.
          </text>
        </Plate>
        <box flexDirection="row" flexShrink={0} gap={GAP}>
          {shown.map(({ avatar, index }) => (
            <Character
              avatar={avatar}
              count={avatars.length}
              focused={focus === "avatar"}
              index={index}
              key={avatar.name}
              portrait={portraits[index]}
              selected={index === rail.avatar}
              width={geometry.card}
            />
          ))}
        </box>
        <box flexDirection="row" flexShrink={0} gap={GAP}>
          <box flexShrink={0} width={WEAPON_WIDTH}>
            <Plate
              icon="⌖"
              meta={context.provider}
              title="WEAPON"
              tone={aiming ? hud.amber : hud.bronze}
            >
              <Weapon
                effort={rail.effort}
                focus={aiming}
                model={rail.model}
                models={context.models}
              />
            </Plate>
          </box>
          <box flexGrow={1} flexShrink={1}>
            <Plate icon="◧" meta={`${slots.length} equipped`} title="LOADOUT">
              <Loadout focused={false} selected={0} slots={slots} />
            </Plate>
          </box>
        </box>
      </box>
      <HintBar
        keys={[
          ["Tab", "Next"],
          ["↑/↓", TURNS[focus]],
          ["↵", "Start mission"],
          ["^C", "Quit"],
        ]}
      />
    </box>
  );
}
