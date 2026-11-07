import { describe, expect, it } from "vitest";
import { fitStroke } from "../../../lib/annotations/geometry.ts";

describe("responsive drawing geometry", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 500, y: 100 },
  ];
  it("fits a desktop stroke into a narrow column without changing saved points", () => {
    const fitted = fitStroke(points, { x: 160, y: 200 }, 342);
    expect(fitted[0]).toEqual({ x: 8, y: 200 });
    expect(fitted[1]?.x).toBeLessThanOrEqual(334);
    expect(fitted[1]?.y).toBeCloseTo(265.2);
    expect(points[1]).toEqual({ x: 500, y: 100 });
  });
  it("restores full-size geometry on a wider column", () => {
    expect(fitStroke(points, { x: 20, y: 200 }, 700)).toEqual([
      { x: 20, y: 200 },
      { x: 520, y: 300 },
    ]);
  });
  it("fits strokes extending to the left of their anchor", () => {
    const fitted = fitStroke(
      [
        { x: -500, y: 0 },
        { x: 0, y: 0 },
      ],
      { x: 100, y: 50 },
      342
    );
    expect(fitted[0]?.x).toBeGreaterThanOrEqual(8);
    expect(fitted[1]?.x).toBeLessThanOrEqual(334);
  });
});
