import type { BoxRenderable } from "@opentui/core";
import { type ReactNode, useCallback } from "react";
import { HintBar } from "@/components/blocks/hint-bar";
import { Loadout } from "@/components/blocks/loadout";
import { Plate } from "@/components/blocks/plate";
import { Toolkit } from "@/components/blocks/toolkit";
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
const LOADOUT_ROWS = 5;
const LOADOUT_WIDTH = 36;
const TOOLKIT_MIN = 24;
const TIERS: readonly PortraitSize[] = ["grand", "large", "medium", "small"];
const TURNS = {
  avatar: "Character",
  effort: "Effort",
  model: "Model",
  slot: "Character",
} as const;

const LINEUP = 3;

interface Shape {
  readonly portrait: PortraitSize;
  readonly visible: number;
}

interface Room {
  readonly avatars: number;
  readonly height: number;
  readonly slots: number;
  readonly width: number;
}

function cardWidth(portrait: PortraitSize): number {
  return Math.max(PORTRAIT_SIZES[portrait].columns + CARD_CHROME, CARD_MIN);
}

function across(portrait: PortraitSize, { avatars, width }: Room): number {
  const card = cardWidth(portrait);
  return Math.min(avatars, Math.floor((width - MARGIN + GAP) / (card + GAP)));
}

function blockWidth({ portrait, visible }: Shape, width: number): number {
  const card = cardWidth(portrait);
  const wanted =
    visible > 1
      ? visible * card + (visible - 1) * GAP
      : Math.max(card, SOLO_WIDTH);
  return Math.min(wanted, Math.max(width - MARGIN, card));
}

function rowsFor(
  shape: Shape,
  { slots, width }: Room,
  { header, toolkit }: { readonly header: boolean; readonly toolkit: boolean }
): number {
  const stacked = blockWidth(shape, width) < LOADOUT_WIDTH + GAP + TOOLKIT_MIN;
  const listed = toolkit ? PLATE_ROWS + slots : 0;
  const stackedRows = LOADOUT_ROWS + (toolkit ? GAP + listed : 0);
  return (
    (header ? HEADER + GAP : 0) +
    PORTRAIT_SIZES[shape.portrait].rows +
    CARD_ROWS +
    GAP +
    (stacked ? stackedRows : Math.max(LOADOUT_ROWS, listed)) +
    HINTS
  );
}

function fits(shape: Shape, room: Room): boolean {
  return (
    shape.visible >= 1 &&
    rowsFor(shape, room, { header: false, toolkit: false }) <= room.height
  );
}

export function briefingGeometry(
  { height, width }: Size,
  avatars: number,
  slots = 0
) {
  const room = { avatars, height, slots, width };
  const shapes = TIERS.map((portrait) => ({
    portrait,
    visible: across(portrait, room),
  })).filter((each) => fits(each, room));
  const shape = shapes.find(
    ({ visible }) => visible >= Math.min(avatars, LINEUP)
  ) ??
    shapes[0] ?? { portrait: "small" as const, visible: 1 };
  const block = blockWidth(shape, width);
  const toolkit =
    rowsFor(shape, room, { header: false, toolkit: true }) <= height;
  return {
    block,
    card: cardWidth(shape.portrait),
    header: rowsFor(shape, room, { header: true, toolkit }) <= height,
    portrait: shape.portrait,
    stacked: block < LOADOUT_WIDTH + GAP + TOOLKIT_MIN,
    toolkit,
    visible: shape.visible,
  };
}

export function lineupFrom(
  selected: number,
  visible: number,
  avatars: number
): number {
  const centred = selected - Math.floor(visible / 2);
  return Math.min(Math.max(centred, 0), Math.max(avatars - visible, 0));
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
  const from = lineupFrom(rail.avatar, geometry.visible, avatars.length);
  const shown = avatars
    .map((avatar, index) => ({ avatar, index }))
    .slice(from, from + geometry.visible);
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
              width={geometry.stacked ? geometry.block : LOADOUT_WIDTH}
            >
              <Plate
                icon="⌖"
                meta={context.provider}
                title="LOADOUT"
                tone={aiming ? hud.amber : hud.bronze}
              >
                <Loadout
                  effort={rail.effort}
                  focus={aiming}
                  model={rail.model}
                  models={context.models}
                />
              </Plate>
            </box>
            {geometry.toolkit ? (
              <box flexGrow={1} flexShrink={1}>
                <Plate icon="◧" meta={`${slots.length} equipped`} title="TOOLS">
                  <Toolkit focused={false} selected={0} slots={slots} />
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
