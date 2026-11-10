import { describe, expect, it } from "vitest";
import { compatibilityOf } from "~/generation/family/compatibility";
import type { Outline, Segment } from "~/typeface/outline";

const line = (x: number, y: number): Segment => ({
  kind: "line",
  to: { x, y },
});

const curve = (x: number, y: number): Segment => ({
  control: { x: x - 10, y: y + 10 },
  kind: "quadratic",
  to: { x, y },
});

const contour = (...segments: Segment[]) => ({
  segments,
  start: { x: 0, y: 0 },
});

const drawing = (label: string, ...contours: Outline["contours"]) => ({
  label,
  outline: { contours },
});

describe("whether drawings of one glyph can interpolate", () => {
  const triangle = contour(line(50, 100), line(100, 0));

  it("accepts the same drawing with its points moved", () => {
    const heavier = contour(line(80, 120), line(160, 0));
    expect(
      compatibilityOf([
        drawing("Light", triangle),
        drawing("Regular", triangle),
        drawing("Bold", heavier),
      ])
    ).toEqual({ compatible: true });
  });

  it("says which faces differ in their number of contours", () => {
    expect(
      compatibilityOf([
        drawing("Light", triangle),
        drawing("Regular", triangle),
        drawing("Bold", triangle, triangle),
      ])
    ).toEqual({
      compatible: false,
      reason: "Light has 1 contour and Bold has 2.",
    });
  });

  it("says which contour differs in its number of segments", () => {
    const square = contour(line(0, 100), line(100, 100), line(100, 0));
    expect(
      compatibilityOf([
        drawing("Light", triangle, triangle),
        drawing("Bold", triangle, square),
      ])
    ).toEqual({
      compatible: false,
      reason: "Contour 2 has 2 segments in Light and 3 in Bold.",
    });
  });

  it("says where a line meets a curve", () => {
    const rounded = contour(line(50, 100), curve(100, 0));
    expect(
      compatibilityOf([drawing("Light", triangle), drawing("Bold", rounded)])
    ).toEqual({
      compatible: false,
      reason: "Contour 1 has a line in Light where Bold has a quadratic curve.",
    });
  });

  it("gives the reason a face has no drawing", () => {
    expect(
      compatibilityOf([
        drawing("Light", triangle),
        {
          label: "Bold",
          missing: "The face has no glyph for the mark U+0303.",
        },
      ])
    ).toEqual({
      compatible: false,
      reason:
        "Bold has no candidate. The face has no glyph for the mark U+0303.",
    });
  });

  it("does not call nothing at all compatible", () => {
    expect(compatibilityOf([])).toEqual({
      compatible: false,
      reason: "No face has a candidate.",
    });
  });
});
