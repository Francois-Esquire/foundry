import { describe, expect, it } from "vitest";

import { roundSeaLane } from "../../src/web/sea-lane";

describe("sea lane curves", () => {
  it("rounds each bend independently without moving endpoints or the input", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 60 },
      { x: 120, y: 60 },
    ];
    const before = structuredClone(points);
    const clear = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      [a, b].every((p) => !(p.x < 58 && p.y > 2));
    const result = roundSeaLane(points, clear);
    expect(result[0]).toEqual(points[0]);
    expect(result.at(-1)).toEqual(points.at(-1));
    expect(result.some((p) => p.x > 60 && p.x < 80 && p.y < 60)).toBe(true);
    expect(result.every((p, i) => !i || clear(result[i - 1] ?? p, p))).toBe(
      true
    );
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
