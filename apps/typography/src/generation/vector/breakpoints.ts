/**
 * Decides where a traced edge needs a point: at corners, and where a curve
 * turns back in x or y, which is where a type designer places extremes.
 */
import type { Point } from "~/typeface/outline";
import { polygonLength } from "~/typeface/outline-geometry";

type KnotKind = "corner" | "extreme-x" | "extreme-y";

export interface Knot {
  /** Index into the loop the knots were found on. */
  readonly index: number;
  readonly kind: KnotKind;
}

/** A closed edge rotated to start at a knot, with the knots that cut it into pieces. */
export interface KnottedLoop {
  /** Ascending. The first is 0 and the last is `points.length - 1`, the same place. */
  readonly knots: readonly Knot[];
  /** The loop with its first point repeated at the end. */
  readonly points: readonly Point[];
}

/** How far a coordinate must turn back before the turn counts as an extreme. */
const RETREAT = 0.75;
/** Points this close to the extreme value are one flat stretch. */
const PLATEAU = 0.15;
/** The span, in samples, that a turn is measured across. */
const REACH = 3;
/** Knots closer than this many samples collapse into one. */
const MIN_GAP = 3;

/** The same edge with points one pixel apart, so an index measures distance. */
export const resampleLoop = (loop: readonly Point[]): Point[] => {
  const length = polygonLength(loop);
  const count = Math.max(4, Math.round(length));
  const spacing = length / count;
  const resampled: Point[] = [];
  let travelled = 0;
  let target = 0;
  for (let index = 0; index < loop.length; index += 1) {
    const from = loop[index];
    const to = loop[(index + 1) % loop.length];
    if (!(from && to)) {
      continue;
    }
    const step = Math.hypot(to.x - from.x, to.y - from.y);
    while (target < travelled + step && resampled.length < count) {
      const t = step === 0 ? 0 : (target - travelled) / step;
      resampled.push({
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
      });
      target += spacing;
    }
    travelled += step;
  }
  return resampled;
};

const wrapped = (loop: readonly Point[], index: number): Point => {
  const count = loop.length;
  return loop[((index % count) + count) % count] ?? { x: 0, y: 0 };
};

/** The turn of the edge at a point, in degrees, measured across the reach. */
const turnAt = (loop: readonly Point[], index: number): number => {
  const before = wrapped(loop, index - REACH);
  const here = wrapped(loop, index);
  const after = wrapped(loop, index + REACH);
  const inX = here.x - before.x;
  const inY = here.y - before.y;
  const outX = after.x - here.x;
  const outY = after.y - here.y;
  const cross = inX * outY - inY * outX;
  const dot = inX * outX + inY * outY;
  return Math.abs((Math.atan2(cross, dot) * 180) / Math.PI);
};

/**
 * Indices where the edge turns sharply, each the sharpest point of its
 * neighbourhood. One corner spreads its turn over twice the reach, so two
 * candidates closer than that are the same corner and the sharper one stays.
 */
const findCorners = (loop: readonly Point[], cornerAngle: number): number[] => {
  const count = loop.length;
  const turns = loop.map((_, index) => turnAt(loop, index));
  const turn = (index: number) => turns[((index % count) + count) % count] ?? 0;
  const apart = (a: number, b: number) =>
    Math.min(Math.abs(a - b), count - Math.abs(a - b));
  const sharp = turns
    .map((_, index) => index)
    .filter((index) => turn(index) >= cornerAngle)
    .sort((a, b) => turn(b) - turn(a));
  const corners: number[] = [];
  for (const index of sharp) {
    if (corners.every((corner) => apart(corner, index) > 2 * REACH)) {
      corners.push(index);
    }
  }
  return corners.sort((a, b) => a - b);
};

/** Where the line through a and b meets the line through c and d. */
const meeting = (a: Point, b: Point, c: Point, d: Point): Point | undefined => {
  const abX = b.x - a.x;
  const abY = b.y - a.y;
  const cdX = d.x - c.x;
  const cdY = d.y - c.y;
  const cross = abX * cdY - abY * cdX;
  if (Math.abs(cross) < 1e-9) {
    return;
  }
  const t = ((c.x - a.x) * cdY - (c.y - a.y) * cdX) / cross;
  return { x: a.x + t * abX, y: a.y + t * abY };
};

/** Samples this near a corner are rounded off by the pixel grid. */
const BLUNT = 2;
/** A sharpened corner further than this from where it was found is not trusted. */
const SHARPEN_LIMIT = 2.5;

/**
 * Contour following cuts every corner short by a fraction of a pixel. This
 * puts each corner back where the edges on its two sides meet, so straight
 * edges stay straight right up to the corner.
 */
const sharpenCorners = (
  loop: readonly Point[],
  corners: readonly number[]
): Point[] => {
  const sharpened = [...loop];
  const count = loop.length;
  const slot = (index: number) => ((index % count) + count) % count;
  for (const corner of corners) {
    const here = wrapped(loop, corner);
    const tip = meeting(
      wrapped(loop, corner - BLUNT - REACH),
      wrapped(loop, corner - BLUNT),
      wrapped(loop, corner + BLUNT),
      wrapped(loop, corner + BLUNT + REACH)
    );
    if (!tip || Math.hypot(tip.x - here.x, tip.y - here.y) > SHARPEN_LIMIT) {
      continue;
    }
    sharpened[slot(corner)] = tip;
    for (const side of [-1, 1]) {
      const sound = wrapped(loop, corner + side * BLUNT);
      for (let step = 1; step < BLUNT; step += 1) {
        const t = step / BLUNT;
        sharpened[slot(corner + side * step)] = {
          x: tip.x + (sound.x - tip.x) * t,
          y: tip.y + (sound.y - tip.y) * t,
        };
      }
    }
  }
  return sharpened;
};

/**
 * The middle of the flat stretch around an extreme value. A stretch that
 * runs into either end has no middle of its own: the end is the extreme.
 */
const plateauMiddle = (
  values: readonly number[],
  peak: number,
  first: number,
  last: number
): number | undefined => {
  const level = values[peak] ?? 0;
  const near = (index: number) =>
    Math.abs((values[index] ?? 0) - level) <= PLATEAU;
  let low = peak;
  while (low > first && near(low - 1)) {
    low -= 1;
  }
  let high = peak;
  while (high < last && near(high + 1)) {
    high += 1;
  }
  return low === first || high === last
    ? undefined
    : Math.round((low + high) / 2);
};

/**
 * Indices strictly between `first` and `last` where the values reach a local
 * extreme and then turn back by more than the retreat. Small wobbles from
 * pixel noise never retreat that far.
 */
const findExtremes = (
  values: readonly number[],
  first: number,
  last: number
): number[] => {
  const found: (number | undefined)[] = [];
  let seeking: "either" | "max" | "min" = "either";
  let maxAt = first;
  let minAt = first;
  for (let index = first + 1; index <= last; index += 1) {
    const value = values[index] ?? 0;
    if (value > (values[maxAt] ?? 0)) {
      maxAt = index;
    }
    if (value < (values[minAt] ?? 0)) {
      minAt = index;
    }
    if (seeking !== "min" && value < (values[maxAt] ?? 0) - RETREAT) {
      found.push(plateauMiddle(values, maxAt, first, last));
      seeking = "min";
      minAt = index;
    } else if (seeking !== "max" && value > (values[minAt] ?? 0) + RETREAT) {
      found.push(plateauMiddle(values, minAt, first, last));
      seeking = "max";
      maxAt = index;
    }
  }
  return found.filter(
    (index): index is number =>
      index !== undefined && index - first >= MIN_GAP && last - index >= MIN_GAP
  );
};

const extremesBetween = (
  points: readonly Point[],
  first: number,
  last: number
): Knot[] => {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const knots: Knot[] = [
    ...findExtremes(xs, first, last).map(
      (index): Knot => ({ index, kind: "extreme-x" })
    ),
    ...findExtremes(ys, first, last).map(
      (index): Knot => ({ index, kind: "extreme-y" })
    ),
  ].sort((a, b) => a.index - b.index);
  return knots.filter(
    (knot, position) =>
      position === 0 ||
      knot.index - (knots[position - 1]?.index ?? 0) >= MIN_GAP
  );
};

const rotate = (loop: readonly Point[], start: number): Point[] => [
  ...loop.slice(start),
  ...loop.slice(0, start),
];

/** The middle of the highest stretch of a loop that has no corner to start at. */
const topmost = (loop: readonly Point[]): number => {
  const count = loop.length;
  let best = 0;
  for (let index = 1; index < count; index += 1) {
    if ((loop[index]?.y ?? 0) > (loop[best]?.y ?? 0)) {
      best = index;
    }
  }
  const doubled = [...loop, ...loop].map((point) => point.y);
  const middle = plateauMiddle(doubled, best + count, best, best + 2 * count);
  return (middle ?? best) % count;
};

/** Cuts a resampled closed edge at its corners and extremes. */
export const knotLoop = (
  loop: readonly Point[],
  cornerAngle: number
): KnottedLoop => {
  const corners = findCorners(loop, cornerAngle);
  const start = corners[0] ?? topmost(loop);
  const rotated = rotate(sharpenCorners(loop, corners), start);
  const [first] = rotated;
  const points = first ? [...rotated, first] : rotated;
  const end = points.length - 1;
  const stops = [0, ...corners.slice(1).map((corner) => corner - start), end];
  const edgeKind: KnotKind = corners.length > 0 ? "corner" : "extreme-y";
  const knots: Knot[] = [];
  for (let position = 0; position < stops.length - 1; position += 1) {
    const from = stops[position] ?? 0;
    const to = stops[position + 1] ?? end;
    knots.push(
      { index: from, kind: edgeKind },
      ...extremesBetween(points, from, to)
    );
  }
  knots.push({ index: end, kind: edgeKind });
  return { knots, points };
};
