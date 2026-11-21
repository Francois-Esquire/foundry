import type { Avatar, Wound } from "@/model/avatars";
import {
  HEALTH,
  type Health,
  type Pose,
  type SpriteSheet,
} from "@/model/sprite";

const GRID = 32;
const CENTRE = GRID / 2;
const RED: Rgb = [214, 36, 28];
const DARK_RED: Rgb = [122, 16, 20];
const WHITE: Rgb = [255, 244, 200];
const YELLOW: Rgb = [255, 196, 60];

const IDLE_TICKS = 22;
const BLINK_TICKS = 2;
const SECOND_BLINK = 4;
const GLANCE_TICKS = 9;
const FLICKER_TICKS = 12;
const FLICKER_ODDS = 0.6;
const SINGLE_BLINK = 0.3;
const DOUBLE_BLINK = 0.45;
const GLANCE_LEFT = 0.6;
const GLANCE_RIGHT = 0.75;
const FLICKER = 0.95;

export const HURT_TICKS = 10;
const SHAKE_TICKS = 4;
const SHAKE = 0.75;
const FLASH: Rgb = [70, 58, 44];
const SHADOW = 24;
const DOT = 0.6;

const AMBIENT_TICKS = 9;
const AMBIENT_FROM = 3;
const AMBIENT_ODDS = [0.3, 0.55];
const DRIP_TICKS = 8;
const DRIP_FADE = 5;
const SPARK_TICKS = 3;

type Rgb = readonly [number, number, number];

export interface PortraitMoment {
  readonly avatar: Avatar;
  readonly frame: number;
  readonly health: Health;
  readonly hurtAt: number | null;
  readonly seed: number;
}

interface Dot {
  readonly clings: boolean;
  readonly colour: Rgb;
  readonly x: number;
  readonly y: number;
}

export interface PortraitScene {
  readonly dots: readonly Dot[];
  readonly flash: boolean;
  readonly health: Health;
  readonly poses: readonly Pose[];
  readonly shake: number;
}

function chance(a: number, b: number, salt: number): number {
  const wave = Math.sin(a * 127.1 + b * 311.7 + salt * 74.7) * 43_758.5453;
  return wave - Math.floor(wave);
}

function glance(avatar: Avatar, health: Health, pose: Pose, at: number) {
  if (avatar.sheet.still[pose]?.includes(health)) {
    return at < BLINK_TICKS ? "blink" : null;
  }
  return at < GLANCE_TICKS ? pose : null;
}

function idlePose({
  avatar,
  frame,
  health,
  seed,
}: PortraitMoment): Pose | null {
  const at = frame % IDLE_TICKS;
  const roll = chance(seed, Math.floor(frame / IDLE_TICKS), 1);
  if (roll < SINGLE_BLINK) {
    return at < BLINK_TICKS ? "blink" : null;
  }
  if (roll < DOUBLE_BLINK) {
    const second = at >= SECOND_BLINK && at < SECOND_BLINK + BLINK_TICKS;
    return at < BLINK_TICKS || second ? "blink" : null;
  }
  if (roll < GLANCE_LEFT) {
    return glance(avatar, health, "left", at);
  }
  if (roll < GLANCE_RIGHT) {
    return glance(avatar, health, "right", at);
  }
  if (avatar.flicker && roll < FLICKER) {
    const lit = chance(seed, Math.floor(frame / 2), 2) < FLICKER_ODDS;
    return at < FLICKER_TICKS && lit ? avatar.flicker : null;
  }
  return null;
}

function splatter(
  wound: Wound,
  seed: number,
  since: number,
  severity: number
): Dot[] {
  const dots: Dot[] = [];
  const count = 6 + severity * 2;
  for (let index = 0; index < count; index += 1) {
    const life = 4 + Math.floor(chance(seed, index, 7) * 5);
    if (since >= life) {
      continue;
    }
    const angle = chance(seed, index, 3) * Math.PI * 2;
    const speed = 0.8 + chance(seed, index, 4) * 1.6;
    const x = CENTRE + (chance(seed, index, 5) - 0.5) * wound.spread;
    const pick = chance(seed, index, 6);
    const travelX = Math.cos(angle) * speed * since;
    const travelY = Math.sin(angle) * speed * since;
    if (wound.style === "sparks") {
      const row = wound.rows[Math.floor(pick * wound.rows.length)] ?? CENTRE;
      dots.push({
        clings: false,
        colour: since < 2 ? WHITE : YELLOW,
        x: Math.round(x + travelX),
        y: Math.round(row + travelY),
      });
    } else {
      const y = wound.top + pick * (wound.bottom - wound.top);
      dots.push({
        clings: false,
        colour: since < 3 ? RED : DARK_RED,
        x: Math.round(x + travelX),
        y: Math.round(y + travelY + 0.12 * since * since),
      });
    }
  }
  return dots;
}

function ambient(
  wound: Wound,
  seed: number,
  frame: number,
  severity: number
): Dot[] {
  if (severity < AMBIENT_FROM) {
    return [];
  }
  const slot = Math.floor(frame / AMBIENT_TICKS);
  const at = frame % AMBIENT_TICKS;
  if (chance(seed, slot, 8) > (AMBIENT_ODDS[severity - AMBIENT_FROM] ?? 0)) {
    return [];
  }
  if (wound.style === "sparks") {
    if (at >= SPARK_TICKS) {
      return [];
    }
    const x = 20 + Math.floor(chance(seed, slot, 9) * 8);
    const y = 10 + Math.floor(chance(seed, slot, 10) * 12);
    return [
      { clings: true, colour: at === 0 ? WHITE : YELLOW, x: x + at, y: y - at },
      { clings: true, colour: YELLOW, x: x - at, y: y + at },
    ];
  }
  if (at >= DRIP_TICKS) {
    return [];
  }
  const x = 11 + Math.floor(chance(seed, slot, 9) * 10);
  return [
    {
      clings: true,
      colour: at < DRIP_FADE ? RED : DARK_RED,
      x,
      y: 22 + at,
    },
  ];
}

export function portraitScene(moment: PortraitMoment): PortraitScene {
  const { avatar, frame, health, hurtAt, seed } = moment;
  const severity = HEALTH.indexOf(health);
  const since = hurtAt === null ? -1 : frame - hurtAt;
  const hurting = since >= 0 && since < HURT_TICKS;
  const idle = idlePose(moment);
  const poses = hurting
    ? (avatar.hurt[since % avatar.hurt.length] ?? [])
    : [idle].filter((pose) => pose !== null);
  const spray = hurting
    ? splatter(avatar.wound, seed + (hurtAt ?? 0), since, severity)
    : [];
  const shift = since % 2 === 0 ? -1 : 1;
  return {
    dots: [...ambient(avatar.wound, seed, frame, severity), ...spray],
    flash: hurting && since === 0,
    health,
    poses,
    shake: hurting && since < SHAKE_TICKS ? shift : 0,
  };
}

function isFigure(pixels: Uint8Array, at: number): boolean {
  return (
    (pixels[at] ?? 0) + (pixels[at + 1] ?? 0) + (pixels[at + 2] ?? 0) > SHADOW
  );
}

function drawDot(pixels: Uint8Array, cell: number, dot: Dot) {
  const unit = cell / GRID;
  const size = Math.max(1, Math.round(unit * DOT));
  const left = Math.round(dot.x * unit + (unit - size) / 2);
  const top = Math.round(dot.y * unit + (unit - size) / 2);
  const inside =
    left >= 0 && top >= 0 && left + size <= cell && top + size <= cell;
  if (!inside || (dot.clings && !isFigure(pixels, (top * cell + left) * 4))) {
    return;
  }
  for (let y = top; y < top + size; y += 1) {
    for (let x = left; x < left + size; x += 1) {
      pixels.set(dot.colour, (y * cell + x) * 4);
    }
  }
}

function shifted(pixels: Uint8Array, cell: number, by: number): Uint8Array {
  const moved = new Uint8Array(pixels.length);
  for (let at = 3; at < moved.length; at += 4) {
    moved[at] = 255;
  }
  for (let y = 0; y < cell; y += 1) {
    const row = pixels.subarray(y * cell * 4, (y + 1) * cell * 4);
    const from = Math.max(0, -by) * 4;
    const to = Math.max(0, by) * 4;
    moved.set(row.subarray(from, row.length - to), y * cell * 4 + to);
  }
  return moved;
}

export function paintPortrait(
  sheet: SpriteSheet,
  atlas: Uint8Array,
  scene: PortraitScene
): Uint8Array {
  const { cell } = sheet;
  const stride = HEALTH.length * cell * 4;
  const column = HEALTH.indexOf(scene.health) * cell * 4;
  const pixels = new Uint8Array(cell * cell * 4);
  for (let y = 0; y < cell; y += 1) {
    const from = y * stride + column;
    pixels.set(atlas.subarray(from, from + cell * 4), y * cell * 4);
  }
  for (const pose of scene.poses) {
    const top = (sheet.poses.indexOf(pose) + 1) * cell;
    if (top === 0) {
      continue;
    }
    for (let at = 0; at < pixels.length; at += 4) {
      const y = Math.floor(at / (cell * 4));
      const from = (top + y) * stride + column + (at % (cell * 4));
      if (atlas[from + 3] === 255) {
        pixels.set(atlas.subarray(from, from + 3), at);
      }
    }
  }
  for (const dot of scene.dots) {
    drawDot(pixels, cell, dot);
  }
  if (scene.flash) {
    for (let at = 0; at < pixels.length; at += 4) {
      if (isFigure(pixels, at)) {
        FLASH.forEach((boost, channel) => {
          pixels[at + channel] = Math.min(
            255,
            (pixels[at + channel] ?? 0) + boost
          );
        });
      }
    }
  }
  const by = Math.round((scene.shake * SHAKE * cell) / GRID);
  return by === 0 ? pixels : shifted(pixels, cell, by);
}
