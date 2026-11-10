import { describe, expect, it } from "vitest";
import {
  type Outline,
  outlineBounds,
  outlinePoints,
  outlineToPath,
  transformOutline,
  translateOutline,
} from "~/typeface/outline";
import { TRIANGLE } from "../helpers/fixtures";

const ARCH: Outline = {
  contours: [
    {
      segments: [
        { control: { x: 50, y: 100 }, kind: "quadratic", to: { x: 100, y: 0 } },
        {
          control1: { x: 100, y: -80 },
          control2: { x: 0, y: -80 },
          kind: "cubic",
          to: { x: 0, y: 0 },
        },
      ],
      start: { x: 0, y: 0 },
    },
  ],
};

describe("outline", () => {
  it("measures the drawn curve, not its control points", () => {
    expect(outlineBounds(ARCH)).toEqual({
      xMax: 100,
      xMin: 0,
      yMax: 50,
      yMin: -60,
    });
  });

  it("has no bounds when empty", () => {
    expect(outlineBounds({ contours: [] })).toBeUndefined();
  });

  it("writes closed path data in font units", () => {
    expect(outlineToPath(TRIANGLE)).toBe("M100 0L500 700L900 0Z");
    expect(outlineToPath(ARCH)).toBe("M0 0Q50 100 100 0C100 -80 0 -80 0 0Z");
  });

  it("moves and transforms every defining point", () => {
    expect(outlinePoints(translateOutline(TRIANGLE, 10, -5))).toEqual([
      { x: 110, y: -5 },
      { x: 510, y: 695 },
      { x: 910, y: -5 },
    ]);
    const sheared = transformOutline(TRIANGLE, {
      dx: 0,
      dy: 0,
      xx: 1,
      xy: 0,
      yx: 0.5,
      yy: 1,
    });
    expect(outlinePoints(sheared)[1]).toEqual({ x: 850, y: 700 });
    expect(outlinePoints(TRIANGLE)[1]).toEqual({ x: 500, y: 700 });
  });
});
