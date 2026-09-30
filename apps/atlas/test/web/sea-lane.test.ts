import { describe, expect, it } from "vitest";

import {
  directSeaLane,
  roundSeaLane,
  shortcutLane,
  smoothSeaLane,
} from "../../src/web/sea-lane";

interface Point {
  x: number;
  y: number;
}

const segmentsClear = (
  points: Point[],
  clear: (a: Point, b: Point) => boolean
) => points.every((p, i) => !i || clear(points[i - 1] ?? p, p));

/** Rejects any segment that touches the block x ∈ [40, 80], y ∈ [-20, 20]. */
const block = (a: Point, b: Point) => {
  for (let n = 0; n <= 40; n += 1) {
    const t = n / 40;
    const x = a.x + (b.x - a.x) * t,
      y = a.y + (b.y - a.y) * t;
    if (x >= 40 && x <= 80 && y >= -20 && y <= 20) {
      return false;
    }
  }
  return true;
};

describe("direct sea lanes", () => {
  it("prefers a gentle arc over the chord in open water", () => {
    const lane = directSeaLane({ x: 0, y: 0 }, { x: 100, y: 0 }, () => true);
    expect(lane?.[0]).toEqual({ x: 0, y: 0 });
    expect(lane?.at(-1)).toEqual({ x: 100, y: 0 });
    const peak = Math.max(...(lane ?? []).map((p) => Math.abs(p.y)));
    expect(peak).toBeGreaterThan(3);
    expect(peak).toBeLessThan(10);
  });

  it("widens the arc until it clears land, and gives up when nothing does", () => {
    const lane = directSeaLane({ x: 0, y: 0 }, { x: 120, y: 0 }, block);
    expect(lane).toBeDefined();
    expect(segmentsClear(lane ?? [], block)).toBe(true);
    expect(Math.max(...(lane ?? []).map((p) => Math.abs(p.y)))).toBeGreaterThan(
      20
    );
    expect(
      directSeaLane({ x: 0, y: 0 }, { x: 120, y: 0 }, () => false)
    ).toBeUndefined();
    expect(
      directSeaLane({ x: 5, y: 5 }, { x: 5, y: 5 }, () => true)
    ).toBeUndefined();
  });
});

describe("smoothed sea lanes", () => {
  const detour = [
    { x: 0, y: 0 },
    { x: 20, y: 10 },
    { x: 35, y: 30 },
    { x: 60, y: 30 },
    { x: 85, y: 30 },
    { x: 100, y: 10 },
    { x: 120, y: 0 },
  ];

  it("drops every waypoint a clear run can skip", () => {
    expect(shortcutLane(detour, () => true)).toEqual([
      detour[0],
      detour.at(-1),
    ]);
    const kept = shortcutLane(detour, block);
    expect(kept.length).toBeLessThan(detour.length);
    expect(kept.length).toBeGreaterThan(2);
    expect(segmentsClear(kept, block)).toBe(true);
    expect(shortcutLane([], () => true)).toEqual([]);
  });

  it("runs a continuous spline through the corners land forces", () => {
    const before = structuredClone(detour);
    const lane = smoothSeaLane(detour, block);
    expect(lane[0]).toEqual(detour[0]);
    expect(lane.at(-1)).toEqual(detour.at(-1));
    expect(lane.length).toBeGreaterThan(detour.length);
    expect(segmentsClear(lane, block)).toBe(true);
    const turns = lane.slice(1, -1).map((p, i) => {
      const a = lane[i] ?? p,
        c = lane[i + 2] ?? p;
      return Math.abs(
        Math.atan2(c.y - p.y, c.x - p.x) - Math.atan2(p.y - a.y, p.x - a.x)
      );
    });
    expect(Math.max(...turns)).toBeLessThan(0.6);
    expect(detour).toEqual(before);
  });

  it("collapses to the chord in open water and keeps short input as is", () => {
    expect(smoothSeaLane(detour, () => true)).toEqual([
      detour[0],
      detour.at(-1),
    ]);
    expect(smoothSeaLane(detour.slice(0, 2), () => true)).toEqual(
      detour.slice(0, 2)
    );
  });
});

describe("sea lane curves", () => {
  it("rounds each bend independently without moving endpoints or the input", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 60 },
      { x: 120, y: 60 },
    ];
    const before = structuredClone(points);
    const clear = (a: Point, b: Point) =>
      [a, b].every((p) => !(p.x < 58 && p.y > 2));
    const result = roundSeaLane(points, clear);
    expect(result[0]).toEqual(points[0]);
    expect(result.at(-1)).toEqual(points.at(-1));
    expect(result.some((p) => p.x > 60 && p.x < 80 && p.y < 60)).toBe(true);
    expect(segmentsClear(result, clear)).toBe(true);
    expect(points).toEqual(before);
  });

  it("does not subdivide straight lanes or generate invalid points from repeated endpoints", () => {
    const straight = [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 60, y: 0 },
    ];
    expect(roundSeaLane(straight, () => true)).toEqual(straight);
    expect(
      roundSeaLane([...straight, { x: 60, y: 0 }], () => true).every(
        (p) => Number.isFinite(p.x) && Number.isFinite(p.y)
      )
    ).toBe(true);
    expect(roundSeaLane([], () => true)).toEqual([]);
  });
});
