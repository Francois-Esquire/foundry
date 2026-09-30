import { describe, expect, it } from "vitest";

import { createChannelGraph } from "../../src/web/channel-graph";

interface Point {
  x: number;
  y: number;
}

const width = 20,
  height = 20;
/** Two coast-distance regions split along x = 7 above y = 10 and x = 12 below. */
const owners = Int32Array.from({ length: width * height }, (_, i) => {
  const x = i % width,
    y = Math.floor(i / width);
  if (x < (y < 10 ? 7 : 12)) {
    return 0;
  }
  return 1;
});
const from = { x: 2, y: 2 },
  to = { x: 17, y: 17 };

/** A wall along x ∈ [9, 10] with a slot at y ∈ [9.8, 10.2], where the graph crosses. */
const wall = (a: Point, b: Point) => {
  for (let n = 0; n <= 40; n += 1) {
    const t = n / 40;
    const x = a.x + (b.x - a.x) * t,
      y = a.y + (b.y - a.y) * t;
    if (x >= 9 && x <= 10 && (y < 9.8 || y > 10.2)) {
      return false;
    }
  }
  return true;
};

describe("channel graph lanes", () => {
  it("takes one smooth arc across open water", () => {
    const route = createChannelGraph(
      owners,
      width,
      height,
      (x, y) => ({ x, y }),
      () => true
    );
    const path = route(from, to);
    expect(path[0]).toEqual(from);
    expect(path.at(-1)).toEqual(to);
    expect(path.length).toBeGreaterThan(8);
    for (const p of path) {
      expect(Math.abs(p.x - p.y)).toBeLessThan(6);
    }
    expect(route(from, to)).toEqual(path);
  });

  it("follows the region graph through the only gap when land blocks the arc", () => {
    const route = createChannelGraph(
      owners,
      width,
      height,
      (x, y) => ({ x, y }),
      wall
    );
    const path = route(from, to);
    expect(path[0]).toEqual(from);
    expect(path.at(-1)).toEqual(to);
    expect(
      path.some((p) => Math.abs(p.x - 9.5) < 0.6 && Math.abs(p.y - 10) < 0.3)
    ).toBe(true);
    expect(path.every((p, i) => !i || wall(path[i - 1] ?? p, p))).toBe(true);
    expect(route(from, to)).toEqual(path);
  });

  it("finds no lane when nothing is clear", () => {
    expect(
      createChannelGraph(
        owners,
        width,
        height,
        (x, y) => ({ x, y }),
        () => false
      )(from, to)
    ).toEqual([]);
  });
});
