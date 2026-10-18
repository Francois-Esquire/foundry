import { describe, expect, it } from "vitest";
import type { Polygon } from "../../src/web/data/types";
import { clipPolygons, clipPolyline } from "../../src/web/layout/clip";

const square: Polygon = [
  [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ],
];
const triangle: Polygon = [
  [
    [5, -5],
    [15, 5],
    [5, 15],
    [5, -5],
  ],
];

/** The shoelace area of a polygon, holes taken out. */
function area(polygons: Polygon[]): number {
  let total = 0;
  for (const polygon of polygons) {
    for (const [index, ring] of polygon.entries()) {
      let twice = 0;
      for (let i = 0; i + 1 < ring.length; i += 1) {
        const [ax, ay] = ring[i] ?? [0, 0];
        const [bx, by] = ring[i + 1] ?? [0, 0];
        twice += ax * by - bx * ay;
      }
      total += ((index ? -1 : 1) * Math.abs(twice)) / 2;
    }
  }
  return total;
}

describe("clipping fills", () => {
  it("keeps the part of a square inside a triangle, as closed rings", () => {
    const clipped = clipPolygons([square], [triangle]);
    expect(clipped).toHaveLength(1);
    // The triangle covers the square's eastern half: a 5 by 10 rectangle.
    expect(area(clipped)).toBeCloseTo(50);
    const [ring] = clipped[0] ?? [];
    expect(ring?.[0]).toEqual(ring?.at(-1));
    for (const [x, y] of ring ?? []) {
      expect(x).toBeGreaterThanOrEqual(5);
      expect(x).toBeLessThanOrEqual(10);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(10);
    }
  });

  it("answers nothing for an empty subject or clip, and the same array for the same inputs", () => {
    expect(clipPolygons([], [triangle])).toEqual([]);
    expect(clipPolygons([square], [])).toEqual([]);
    const subject = [square];
    const clip = [triangle];
    expect(clipPolygons(subject, clip)).toBe(clipPolygons(subject, clip));
    expect(clipPolygons(subject, [triangle])).not.toBe(
      clipPolygons(subject, clip)
    );
  });
});

describe("clipping polylines", () => {
  it("keeps the stretch of a line that crosses a ring twice", () => {
    expect(clipPolyline([-5, 5, 15, 5], [square])).toEqual([[0, 5, 10, 5]]);
  });

  it("splits a polyline that leaves and re-enters into pieces, joined at its own vertices", () => {
    const pieces = clipPolyline([2, 2, 2, 12, 8, 12, 8, 2, 8, 20], [square]);
    expect(pieces).toEqual([
      [2, 2, 2, 10],
      [8, 10, 8, 2, 8, 10],
    ]);
  });

  it("keeps a polyline inside whole and drops one outside", () => {
    expect(clipPolyline([1, 1, 9, 1, 9, 9], [square])).toEqual([
      [1, 1, 9, 1, 9, 9],
    ]);
    expect(clipPolyline([20, 20, 30, 30], [square])).toEqual([]);
  });

  it("respects holes: a line through a hole loses the middle", () => {
    const holed: Polygon = [
      square[0] ?? [],
      [
        [4, 4],
        [6, 4],
        [6, 6],
        [4, 6],
        [4, 4],
      ],
    ];
    expect(clipPolyline([-1, 5, 11, 5], [holed])).toEqual([
      [0, 5, 4, 5],
      [6, 5, 10, 5],
    ]);
  });
});
