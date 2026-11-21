import type { Avatar, Wound } from "@/model/avatars";
import { HEALTH, type Health, type Pose, SPRITE_SIZE } from "@/model/sprite";

const DIGITS = "0123456789abcdefghijklmnopqrstuv";
const BACKDROP = 0;
const RED = 28;
const DARK_RED = 29;
const WHITE = 30;
const YELLOW = 31;
const CENTRE = SPRITE_SIZE / 2;

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
const FLASH: readonly [number, number, number] = [110, 90, 70];

const AMBIENT_TICKS = 9;
const AMBIENT_FROM = 3;
const AMBIENT_ODDS = [0.3, 0.55];
const DRIP_TICKS = 8;
const DRIP_FADE = 5;
const SPARK_TICKS = 3;

export interface PortraitMoment {
  readonly avatar: Avatar;
  readonly frame: number;
  readonly health: Health;
  readonly hurtAt: number | null;
  readonly seed: number;
}

export interface HalfBlocks {
  readonly bottom: string;
  readonly cells: number;
  readonly top: string;
}

type Dot = readonly [x: number, y: number, colour: number];

function chance(a: number, b: number, salt: number): number {
  const wave = Math.sin(a * 127.1 + b * 311.7 + salt * 74.7) * 43_758.5453;
  return wave - Math.floor(wave);
}

function patchOf(avatar: Avatar, pose: Pose, health: Health): string {
  return avatar.sheet.poses[pose]?.[health] ?? "";
}

function glance(avatar: Avatar, health: Health, pose: Pose, at: number) {
  if (patchOf(avatar, pose, health) === "") {
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
      dots.push([
        Math.round(x + travelX),
        Math.round(row + travelY),
        since < 2 ? WHITE : YELLOW,
      ]);
    } else {
      const y = wound.top + pick * (wound.bottom - wound.top);
      dots.push([
        Math.round(x + travelX),
        Math.round(y + travelY + 0.12 * since * since),
        since < 3 ? RED : DARK_RED,
      ]);
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
      [x + at, y - at, at === 0 ? WHITE : YELLOW],
      [x - at, y + at, YELLOW],
    ];
  }
  if (at >= DRIP_TICKS) {
    return [];
  }
  const x = 11 + Math.floor(chance(seed, slot, 9) * 10);
  return [[x, 22 + at, at < DRIP_FADE ? RED : DARK_RED]];
}

function stamp(grid: number[][], patch: string) {
  for (let at = 0; at < patch.length; at += 3) {
    const row = grid[DIGITS.indexOf(patch.charAt(at + 1))];
    if (row) {
      row[DIGITS.indexOf(patch.charAt(at))] = DIGITS.indexOf(
        patch.charAt(at + 2)
      );
    }
  }
}

function dot(grid: number[][], [x, y, colour]: Dot, onFigure: boolean) {
  const row = grid[y];
  const under = row?.[x];
  if (row && under !== undefined && !(onFigure && under === BACKDROP)) {
    row[x] = colour;
  }
}

function brighten(colour: string): string {
  const channels = FLASH.map((boost, index) =>
    Math.min(
      255,
      Number.parseInt(colour.slice(1 + index * 2, 3 + index * 2), 16) + boost
    )
  );
  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function portrait(moment: PortraitMoment): string[][] {
  const { avatar, frame, health, hurtAt, seed } = moment;
  const { palette, states } = avatar.sheet;
  const severity = HEALTH.indexOf(health);
  const since = hurtAt === null ? -1 : frame - hurtAt;
  const hurting = since >= 0 && since < HURT_TICKS;
  const grid = states[health].map((row) =>
    Array.from(row, (character) => DIGITS.indexOf(character))
  );
  const idle = idlePose(moment);
  const poses = hurting
    ? (avatar.hurt[since % avatar.hurt.length] ?? [])
    : [idle].filter((pose) => pose !== null);
  for (const pose of poses) {
    stamp(grid, patchOf(avatar, pose, health));
  }
  for (const drop of ambient(avatar.wound, seed, frame, severity)) {
    dot(grid, drop, true);
  }
  if (hurting) {
    for (const drop of splatter(
      avatar.wound,
      seed + (hurtAt ?? 0),
      since,
      severity
    )) {
      dot(grid, drop, false);
    }
  }
  const shift = since % 2 === 0 ? -1 : 1;
  const shake = hurting && since < SHAKE_TICKS ? shift : 0;
  const flash = hurting && since === 0;
  const backdrop = palette[BACKDROP] ?? "#000000";
  return grid.map((row) =>
    row.map((_, x) => {
      const index = row[x - shake] ?? BACKDROP;
      const colour = palette[index] ?? backdrop;
      return flash && index !== BACKDROP ? brighten(colour) : colour;
    })
  );
}

export function halfBlocks(
  pixels: readonly (readonly string[])[]
): HalfBlocks[][] {
  const lines: HalfBlocks[][] = [];
  for (let y = 0; y < pixels.length; y += 2) {
    const upper = pixels[y] ?? [];
    const lower = pixels[y + 1] ?? upper;
    const line: HalfBlocks[] = [];
    upper.forEach((top, x) => {
      const bottom = lower[x] ?? top;
      const last = line.at(-1);
      if (last && last.top === top && last.bottom === bottom) {
        line[line.length - 1] = { ...last, cells: last.cells + 1 };
      } else {
        line.push({ bottom, cells: 1, top });
      }
    });
    lines.push(line);
  }
  return lines;
}
