import type { TradePoint } from "./trade-routes";

type Clear = (a: TradePoint, b: TradePoint) => boolean;

/** Sampled points per curve, before length adds more. */
const curveSamples = 16;
/** Sample spacing along a curve, in map units. */
const sampleSpacing = 5;
/** Perpendicular bulges tried for a direct lane, as fractions of the crossing. */
const directBulges = [0.12, -0.12, 0, 0.25, -0.25, 0.4, -0.4];
/** Spline tensions tried per segment before it straightens: 0 is loose. */
const tensions = [0, 0.4, 0.75];

function sampleCount(length: number) {
  return Math.max(curveSamples, Math.ceil(length / sampleSpacing));
}

function segmentsClear(points: TradePoint[], clear: Clear) {
  return points.every((p, i) => i === 0 || clear(points[i - 1] ?? p, p));
}

function quadratic(
  a: TradePoint,
  control: TradePoint,
  b: TradePoint,
  samples: number
): TradePoint[] {
  return Array.from({ length: samples + 1 }, (_, n) => {
    const t = n / samples,
      s = 1 - t;
    return {
      x: s * s * a.x + 2 * s * t * control.x + t * t * b.x,
      y: s * s * a.y + 2 * s * t * control.y + t * t * b.y,
    };
  });
}

/**
 * A single arc from one point to another across open water: a gentle bulge
 * first, then the chord, then wider bulges. Undefined when every arc
 * touches land, so the caller falls back to the channel graph.
 */
export function directSeaLane(
  from: TradePoint,
  to: TradePoint,
  clear: Clear
): TradePoint[] | undefined {
  const dx = to.x - from.x,
    dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (!length) {
    return undefined;
  }
  const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  for (const bulge of directBulges) {
    const control = {
      x: middle.x - dy * bulge,
      y: middle.y + dx * bulge,
    };
    const lane = quadratic(from, control, to, sampleCount(length));
    if (segmentsClear(lane, clear)) {
      return lane;
    }
  }
  return undefined;
}

/** Drops every waypoint that a clear straight run can skip. */
export function shortcutLane(points: TradePoint[], clear: Clear) {
  const [first] = points;
  if (!first) {
    return [];
  }
  const result = [first];
  let i = 0;
  while (i < points.length - 1) {
    let j = points.length - 1;
    while (j > i + 1) {
      const a = points[i],
        b = points[j];
      if (a && b && clear(a, b)) {
        break;
      }
      j -= 1;
    }
    const next = points[j];
    if (next) {
      result.push(next);
    }
    i = j;
  }
  return result;
}

function hermite(
  p0: TradePoint,
  p1: TradePoint,
  p2: TradePoint,
  p3: TradePoint,
  tension: number
): TradePoint[] {
  const slack = (1 - tension) / 2;
  const m1 = { x: (p2.x - p0.x) * slack, y: (p2.y - p0.y) * slack };
  const m2 = { x: (p3.x - p1.x) * slack, y: (p3.y - p1.y) * slack };
  const samples = sampleCount(Math.hypot(p2.x - p1.x, p2.y - p1.y));
  return Array.from({ length: samples + 1 }, (_, n) => {
    const t = n / samples,
      t2 = t * t,
      t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1,
      h10 = t3 - 2 * t2 + t,
      h01 = -2 * t3 + 3 * t2,
      h11 = t3 - t2;
    return {
      x: h00 * p1.x + h10 * m1.x + h01 * p2.x + h11 * m2.x,
      y: h00 * p1.y + h10 * m1.y + h01 * p2.y + h11 * m2.y,
    };
  });
}

/**
 * Smooths a navigable polyline into one continuous lane. Redundant
 * waypoints go first, so only the corners land forces remain; a spline then
 * runs through those, loosest first, tightening per segment until it clears
 * the water. A segment that never clears stays straight and its corners are
 * rounded as far as the water allows.
 */
export function smoothSeaLane(points: TradePoint[], clear: Clear) {
  const waypoints = shortcutLane(points, clear);
  const [first] = waypoints;
  if (!first || waypoints.length < 3) {
    return waypoints;
  }
  const result = [first];
  let straightened = false;
  for (let i = 0; i < waypoints.length - 1; i += 1) {
    const p1 = waypoints[i],
      p2 = waypoints[i + 1];
    if (!(p1 && p2)) {
      continue;
    }
    const p0 = waypoints[i - 1] ?? p1,
      p3 = waypoints[i + 2] ?? p2;
    const segment = tensions
      .map((tension) => hermite(p0, p1, p2, p3, tension))
      .find((candidate) => segmentsClear(candidate, clear));
    if (segment) {
      result.push(...segment.slice(1));
    } else {
      straightened = true;
      result.push(p2);
    }
  }
  return straightened ? roundSeaLane(result, clear) : result;
}

/** Rounds each corner of a polyline with the widest arc the water allows. */
export function roundSeaLane(points: TradePoint[], clear: Clear) {
  const [first] = points;
  if (!first) {
    return [];
  }
  const result = [first];
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = points[i - 1],
      b = points[i],
      c = points[i + 1];
    if (!(a && b && c)) {
      continue;
    }
    const incoming = Math.hypot(b.x - a.x, b.y - a.y);
    const outgoing = Math.hypot(c.x - b.x, c.y - b.y);
    if (
      incoming * outgoing === 0 ||
      Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) /
        (incoming * outgoing) <
        0.08
    ) {
      result.push(b);
      continue;
    }
    let bend = Math.min(45, incoming * 0.4, outgoing * 0.4);
    let arc = [b];
    while (bend > 0.1) {
      const start = {
        x: b.x + ((a.x - b.x) * bend) / incoming,
        y: b.y + ((a.y - b.y) * bend) / incoming,
      };
      const end = {
        x: b.x + ((c.x - b.x) * bend) / outgoing,
        y: b.y + ((c.y - b.y) * bend) / outgoing,
      };
      const candidate = quadratic(start, b, end, curveSamples);
      if (segmentsClear(candidate, clear)) {
        arc = candidate;
        break;
      }
      bend /= 2;
    }
    result.push(...arc);
  }
  const last = points.at(-1);
  if (last && points.length > 1) {
    result.push(last);
  }
  return result;
}
