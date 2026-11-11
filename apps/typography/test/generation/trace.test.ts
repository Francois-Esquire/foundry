import { describe, expect, it } from "vitest";
import { inkArea, inkAt } from "~/generation/raster/bitmap";
import {
  frameAround,
  rasterizeOutline,
  tracedToOutline,
} from "~/generation/raster/rasterize";
import { contourTracer } from "~/generation/vector/trace";
import {
  type Contour,
  type Outline,
  outlineBounds,
  outlinePoints,
  transformOutline,
} from "~/typeface/outline";
import {
  flattenContour,
  polygonLength,
  signedArea,
} from "~/typeface/outline-geometry";
import { fixtureFace } from "../helpers/faces";
import {
  frameOf,
  glyphOf,
  outlineAgreement,
  shapedGlyphOf,
} from "./helpers/glyphs";

const TOLERANCE = 0.75;

const square = (
  left: number,
  bottom: number,
  size: number,
  clockwise = false
): Contour => {
  const corners = [
    { x: left, y: bottom },
    { x: left + size, y: bottom },
    { x: left + size, y: bottom + size },
    { x: left, y: bottom + size },
  ];
  const [start, ...rest] = clockwise ? corners.toReversed() : corners;
  return {
    segments: rest.map((to) => ({ kind: "line", to })),
    start: start ?? { x: 0, y: 0 },
  };
};

const FRAME = frameAround({ xMax: 30, xMin: 0, yMax: 30, yMin: 0 }, 1, 0);

describe("the rasteriser", () => {
  it("fills overlapping contours solid, as the non-zero rule does", () => {
    const overlapping = { contours: [square(0, 0, 20), square(10, 10, 20)] };
    const bitmap = rasterizeOutline(overlapping, FRAME);
    // 400 + 400 - 100 shared: an even-odd fill would leave the shared part empty.
    expect(inkArea(bitmap)).toBe(700);
    // Outline (15, 15) is in the overlap. Row 0 is the top, at y = 30.
    expect(inkAt(bitmap, 15, 14)).toBe(255);
  });

  it("leaves a counter open when it runs against its shape", () => {
    const ring = { contours: [square(0, 0, 30), square(10, 10, 10, true)] };
    const bitmap = rasterizeOutline(ring, FRAME);
    expect(inkArea(bitmap)).toBe(800);
    expect(inkAt(bitmap, 15, 15)).toBe(0);
  });

  it("greys edge pixels by coverage only when asked to", () => {
    const offset = { contours: [square(0.5, 0.5, 10)] };
    const hard = rasterizeOutline(offset, FRAME);
    expect(new Set(hard.data)).toEqual(new Set([0, 255]));
    const soft = rasterizeOutline(offset, FRAME, { antialias: true });
    // The left edge at x = 0.5 covers half of pixel column 0.
    expect(inkAt(soft, 0, 25)).toBe(128);
    expect(inkAt(soft, 5, 25)).toBe(255);
  });
});

const roundTrip = (outline: Outline, scale: number) => {
  const frame = frameOf(outline, scale);
  const bitmap = rasterizeOutline(outline, frame, { antialias: true });
  const traced = transformOutline(
    contourTracer.trace(bitmap, { tolerance: TOLERANCE }),
    tracedToOutline(frame)
  );
  const polygons = bitmap
    ? transformOutline(outline, {
        dx: 0,
        dy: 0,
        xx: scale,
        xy: 0,
        yx: 0,
        yy: scale,
      }).contours.map((contour) => flattenContour(contour, 0.1))
    : [];
  return {
    agreement: outlineAgreement(outline, traced, frame),
    /** Ink area and edge length in pixels, for the bound below. */
    area: inkArea(bitmap),
    perimeter: polygons.reduce(
      (sum, polygon) => sum + polygonLength(polygon),
      0
    ),
    sourcePoints: outlinePoints(outline).length,
    traced,
  };
};

describe("rasterise then trace", () => {
  const lato = fixtureFace("lato");
  // Lato has 2000 units to the em, so these draw it at 500 pixels to the em,
  // and the 1000-unit Devanagari face at the same size.
  const cases: [string, Outline, number][] = [
    ["Lato a", glyphOf(lato, "a").outline, 0.25],
    ["Lato g", glyphOf(lato, "g").outline, 0.25],
    ["Lato O", glyphOf(lato, "O").outline, 0.25],
    ["Lato &", glyphOf(lato, "&").outline, 0.25],
    [
      "Devanagari conjunct kssa",
      shapedGlyphOf(fixtureFace("devanagari"), "क्ष").outline,
      0.5,
    ],
  ];

  it.each(cases)("%s keeps its shape", (_, outline, scale) => {
    const { agreement, area, perimeter } = roundTrip(outline, scale);
    // A fitted curve may stray up to the tolerance from the true edge. If it
    // strayed that far along the whole edge, the two shapes would differ by a
    // band of perimeter times tolerance, which for these glyphs at this size
    // leaves an agreement between 0.955 and 0.967. Asking for 0.97 therefore
    // demands a better fit than the tolerance alone guarantees.
    expect(1 - (perimeter * TOLERANCE) / area).toBeLessThan(0.97);
    expect(agreement).toBeGreaterThan(0.97);
  });

  it.each(cases)("%s comes back with few points", (_, outline, scale) => {
    const { sourcePoints, traced } = roundTrip(outline, scale);
    // Points are counted as the font editor shows them: every contour start,
    // curve handle and segment end. The sources are quadratic, which takes
    // about twice the curves of a cubic outline, so a good trace lands
    // between a third of the source's count and the same count.
    const points = outlinePoints(traced).length;
    expect(points).toBeLessThanOrEqual(sourcePoints);
    expect(points).toBeGreaterThanOrEqual(sourcePoints / 3);
  });

  it("puts points on the extremes and keeps the counter as a hole", () => {
    const source = glyphOf(lato, "O").outline;
    const { traced } = roundTrip(source, 0.25);
    expect(traced.contours).toHaveLength(2);
    const areas = traced.contours.map((contour) =>
      signedArea(flattenContour(contour, 1))
    );
    expect(Math.sign(areas[0] ?? 0)).toBe(-Math.sign(areas[1] ?? 0));
    for (const contour of traced.contours) {
      const bounds = outlineBounds({ contours: [contour] });
      const ends = contour.segments.map((segment) => segment.to);
      // One pixel is four units here.
      const onCurve = (value: number, axis: "x" | "y") =>
        ends.some((point) => Math.abs(point[axis] - value) <= 4);
      expect(onCurve(bounds?.xMin ?? 0, "x")).toBe(true);
      expect(onCurve(bounds?.xMax ?? 0, "x")).toBe(true);
      expect(onCurve(bounds?.yMin ?? 0, "y")).toBe(true);
      expect(onCurve(bounds?.yMax ?? 0, "y")).toBe(true);
      // Four quarter curves and nothing else.
      expect(contour.segments.map((segment) => segment.kind)).toEqual([
        "cubic",
        "cubic",
        "cubic",
        "cubic",
      ]);
    }
  });

  it("keeps corners sharp and straight edges as lines", () => {
    const capital = glyphOf(lato, "H").outline;
    const { traced } = roundTrip(capital, 0.25);
    expect(traced.contours).toHaveLength(1);
    expect(
      traced.contours[0]?.segments.every((segment) => segment.kind === "line")
    ).toBe(true);
    expect(traced.contours[0]?.segments).toHaveLength(12);
  });
});
