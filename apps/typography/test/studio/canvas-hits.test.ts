import { describe, expect, it } from "vitest";
import { drawingBox, hitAt, outlinePlaceAt } from "~/studio/canvas-hits";
import { toScreen } from "~/studio/view-transform";
import { EMPTY_OUTLINE } from "~/typeface/outline";
import type { GlyphShape } from "~/typeface/reading";
import { describeFace, TRIANGLE } from "../helpers/fixtures";

const VIEW = { originX: 100, originY: 500, scale: 0.5 };
const GLYPH: GlyphShape = { advance: 1000, outline: TRIANGLE };

describe("what is under the pointer", () => {
  it("is a point when the pointer is within reach of one", () => {
    const apex = toScreen(VIEW, { x: 500, y: 700 });
    expect(hitAt(VIEW, GLYPH, { x: apex.x + 5, y: apex.y - 4 })).toEqual({
      address: { contour: 0, kind: "node", node: 1 },
      kind: "point",
    });
  });

  it("is the advance line near the right edge", () => {
    const edge = toScreen(VIEW, { x: 1000, y: 0 });
    expect(hitAt(VIEW, GLYPH, { x: edge.x - 3, y: 40 })).toEqual({
      kind: "line",
      measure: "advance",
    });
  });

  it("is the origin line near the left edge, which sets the left bearing", () => {
    expect(hitAt(VIEW, GLYPH, { x: 102, y: 40 })).toEqual({
      kind: "line",
      measure: "left",
    });
  });

  it("is no origin line for a glyph with nothing drawn", () => {
    const space: GlyphShape = { advance: 400, outline: EMPTY_OUTLINE };
    expect(hitAt(VIEW, space, { x: 100, y: 40 })).toEqual({ kind: "nothing" });
  });

  it("is nothing in open space", () => {
    expect(hitAt(VIEW, GLYPH, { x: 340, y: 40 })).toEqual({ kind: "nothing" });
  });

  it("finds the place on the outline for a new node, and none far from it", () => {
    const onBase = toScreen(VIEW, { x: 500, y: 0 });
    expect(
      outlinePlaceAt(VIEW, GLYPH, { x: onBase.x, y: onBase.y + 3 })
    ).toEqual({ contour: 0, segment: 2, t: 0.5 });
    expect(
      outlinePlaceAt(VIEW, GLYPH, { x: onBase.x, y: onBase.y + 60 })
    ).toBeUndefined();
  });

  it("frames the glyph, its advance and the vertical metrics", () => {
    const { metrics } = describeFace();
    expect(drawingBox(metrics, GLYPH)).toEqual({
      xMax: 1000,
      xMin: 0,
      yMax: 800,
      yMin: -200,
    });
    const overhang: GlyphShape = {
      advance: 300,
      outline: {
        contours: [
          {
            segments: [
              { kind: "line", to: { x: 420, y: 900 } },
              { kind: "line", to: { x: 420, y: -40 } },
            ],
            start: { x: -40, y: -40 },
          },
        ],
      },
    };
    expect(drawingBox(metrics, overhang)).toEqual({
      xMax: 420,
      xMin: -40,
      yMax: 900,
      yMin: -200,
    });
  });
});
