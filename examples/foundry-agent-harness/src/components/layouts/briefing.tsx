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
const CARD_ROWS = 3;
const GAP = 1;
const HEADER = 4;
const HINTS = 1;
const MARGIN = 2;
const PLATE_ROWS = 3;
const SOLO_WIDTH = 56;
const WEAPON_ROWS = 5;
const WEAPON_WIDTH = 36;
const LOADOUT_MIN = 24;
const TIERS: readonly PortraitSize[] = ["grand", "large", "medium", "small"];
const TURNS = {
  avatar: "Character",
  effort: "Ammo",
  model: "Gun",
  slot: "Character",
} as const;

interface Shape {
  readonly lineup: boolean;
  readonly portrait: PortraitSize;
}

function cardWidth(portrait: PortraitSize): number {
  return Math.max(PORTRAIT_SIZES[portrait].columns + CARD_CHROME, CARD_MIN);
}

function blockWidth(
  { lineup, portrait }: Shape,
  width: number,
  avatars: number
) {
  const card = cardWidth(portrait);
  const wanted = lineup
    ? avatars * card + (avatars - 1) * GAP
    : Math.max(card, SOLO_WIDTH);
  return Math.min(wanted, Math.max(width - MARGIN, card));
}

function rowsFor(
  shape: Shape,
  { avatars, slots, width }: Room,
  { header, loadout }: { readonly header: boolean; readonly loadout: boolean }
): number {
  const stacked =
    blockWidth(shape, width, avatars) < WEAPON_WIDTH + GAP + LOADOUT_MIN;
  const listed = loadout ? PLATE_ROWS + slots : 0;
  const stackedRows = WEAPON_ROWS + (loadout ? GAP + listed : 0);
  return (
    (header ? HEADER + GAP : 0) +
    PORTRAIT_SIZES[shape.portrait].rows +
    CARD_ROWS +
    GAP +
    (stacked ? stackedRows : Math.max(WEAPON_ROWS, listed)) +
    HINTS
  );
}

interface Room {
  readonly avatars: number;
  readonly height: number;
  readonly slots: number;
  readonly width: number;
}

function fits(shape: Shape, room: Room): boolean {
  const card = cardWidth(shape.portrait);
  const across = shape.lineup
    ? room.avatars * card + (room.avatars - 1) * GAP
    : card;
  return (
    across + MARGIN <= room.width &&
    rowsFor(shape, room, { header: false, loadout: false }) <= room.height
  );
}

export function briefingGeometry(
  { height, width }: Size,
  avatars: number,
  slots = 0
) {
  const room = { avatars, height, slots, width };
  const shapes: Shape[] = [
    ...TIERS.map((portrait) => ({ lineup: true, portrait })),
    ...TIERS.map((portrait) => ({ lineup: false, portrait })),
  ];
  const shape = shapes.find((each) => fits(each, room)) ?? {
    lineup: false,
    portrait: "small" as const,
  };
  const block = blockWidth(shape, width, avatars);
  const loadout =
    rowsFor(shape, room, { header: false, loadout: true }) <= height;
  return {
    block,
    card: cardWidth(shape.portrait),
    header: rowsFor(shape, room, { header: true, loadout }) <= height,
    lineup: shape.lineup,
    loadout,
    portrait: shape.portrait,
    stacked: block < WEAPON_WIDTH + GAP + LOADOUT_MIN,
  };
}

function Character({
  avatar,
  count,
  focused,
  index,
  onPick,
  portrait,
  selected,
  width,
}: {
  readonly avatar: Avatar;
  readonly count: number;
  readonly focused: boolean;
  readonly index: number;
  readonly onPick: (avatar: number) => void;
  readonly portrait: ReactNode;
  readonly selected: boolean;
  readonly width: number;
}) {
  const chosen = focused ? `◂ ${index + 1}/${count} ▸` : "chosen";
  const choose = useCallback(() => onPick(index), [index, onPick]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Terminal card; Left and Right are the keyboard equivalent.
    <box flexShrink={0} onMouseDown={choose} width={width}>
      <Plate
        icon="☻"
        meta={selected ? chosen : undefined}
        title={avatar.name.toUpperCase()}
        tone={selected ? hud.amber : hud.bronze}
      >
        <box alignItems="center">{portrait}</box>
      </Plate>
    </box>
  );
}

export function BriefingLayout({
  avatars,
  context,
  onPick,
  onResize,
  portraits,
  rail,
  size,
}: {
  readonly avatars: readonly Avatar[];
  readonly context: Context;
  readonly onPick: (avatar: number) => void;
  readonly onResize: (size: Size) => void;
  readonly portraits: readonly ReactNode[];
  readonly rail: Rail;
  readonly size: Size;
}) {
  const slots = slotsOf(context);
  const geometry = briefingGeometry(size, avatars.length, slots.length);
  const focus = focusOn(rail, BRIEFING_STOPS);
  const aiming = focus === "model" || focus === "effort" ? focus : null;
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
      <box
        alignItems="center"
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        justifyContent="center"
      >
        <box flexDirection="column" gap={GAP} width={geometry.block}>
          {geometry.header ? (
            <Plate meta="new mission" title="GET STARTED">
              <text fg={hud.text} truncate wrapMode="none">
                Choose who goes in and what they carry for the whole mission.
              </text>
            </Plate>
          ) : null}
          <box
            flexDirection="row"
            flexShrink={0}
            gap={GAP}
            justifyContent="center"
          >
            {shown.map(({ avatar, index }) => (
              <Character
                avatar={avatar}
                count={avatars.length}
                focused={focus === "avatar"}
                index={index}
                key={avatar.name}
                onPick={onPick}
                portrait={portraits[index]}
                selected={index === rail.avatar}
                width={geometry.card}
              />
            ))}
          </box>
          <box
            flexDirection={geometry.stacked ? "column" : "row"}
            flexShrink={0}
            gap={GAP}
          >
            <box
              flexShrink={0}
              width={geometry.stacked ? geometry.block : WEAPON_WIDTH}
            >
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
            {geometry.loadout ? (
              <box flexGrow={1} flexShrink={1}>
                <Plate
                  icon="◧"
                  meta={`${slots.length} equipped`}
                  title="LOADOUT"
                >
                  <Loadout focused={false} selected={0} slots={slots} />
                </Plate>
              </box>
            ) : null}
          </box>
        </box>
      </box>
      <HintBar
        keys={[
          ["←/→", TURNS[focus]],
          ["↑/↓", "Move"],
          ["↵", "Start mission"],
          ["^C", "Quit"],
        ]}
      />
    </box>
  );
}
