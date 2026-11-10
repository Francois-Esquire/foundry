import { describe, expect, it } from "vitest";
import { parseSvg } from "~/generation/vector/svg/document";
import { parsePathData } from "~/generation/vector/svg/path-data";
import { parseTransform } from "~/generation/vector/svg/transform";
import { MalformedXmlError } from "~/generation/vector/svg/xml";
import { type Outline, outlineBounds } from "~/typeface/outline";

const boundsOf = (outline: Outline) => {
  const bounds = outlineBounds(outline);
  if (!bounds) {
    throw new Error("Expected a drawn outline.");
  }
  return bounds;
};

const pathBounds = (data: string) =>
  boundsOf({ contours: parsePathData(data) });

describe("path data", () => {
  it("reads relative commands from the pen position", () => {
    const [contour] = parsePathData("m10 10 l20 0 v20 h-20 z");
    expect(contour?.start).toEqual({ x: 10, y: 10 });
    expect(contour?.segments.map((segment) => segment.to)).toEqual([
      { x: 30, y: 10 },
      { x: 30, y: 30 },
      { x: 10, y: 30 },
    ]);
  });

  it("treats pairs after a move as lines, and numbers packed without spaces", () => {
    const [contour] = parsePathData("M0,0 10,0 10,10-5.5.5z");
    expect(contour?.segments.map((segment) => segment.to)).toEqual([
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: -5.5, y: 0.5 },
    ]);
  });

  it("mirrors the last control point for smooth curves", () => {
    const [contour] = parsePathData("M0 0 C0 10 10 10 10 0 s10 -10 10 0 Z");
    expect(contour?.segments[1]).toEqual({
      control1: { x: 10, y: -10 },
      control2: { x: 20, y: -10 },
      kind: "cubic",
      to: { x: 20, y: 0 },
    });
    const [quadratic] = parsePathData("M0 0 Q5 10 10 0 T20 0 Z");
    expect(quadratic?.segments[1]).toEqual({
      control: { x: 15, y: -10 },
      kind: "quadratic",
      to: { x: 20, y: 0 },
    });
  });

  it("turns arcs into cubics that stay on the circle", () => {
    // Two half circles of radius 50 around (50, 50), with glued arc flags.
    const bounds = pathBounds("M0 50 A50 50 0 01100 50 A50 50 0 010 50 Z");
    expect(bounds.xMin).toBeCloseTo(0, 1);
    expect(bounds.xMax).toBeCloseTo(100, 1);
    expect(bounds.yMin).toBeCloseTo(0, 1);
    expect(bounds.yMax).toBeCloseTo(100, 1);
  });

  it("follows the large-arc and sweep flags, and grows radii that cannot reach", () => {
    // From (0,0) to (10,0) with radius 10: the small arc bulges 1.34 units.
    const small = pathBounds("M0 0 a10 10 0 0 1 10 0 z");
    expect(small.yMin).toBeCloseTo(-(10 - Math.sqrt(75)), 2);
    const large = pathBounds("M0 0 a10 10 0 1 1 10 0 z");
    expect(large.yMin).toBeCloseTo(-(10 + Math.sqrt(75)), 2);
    const swept = pathBounds("M0 0 a10 10 0 0 0 10 0 z");
    expect(swept.yMax).toBeCloseTo(10 - Math.sqrt(75), 2);
    // A radius of 1 cannot span 10 units, so it grows to a half circle of 5.
    const grown = pathBounds("M0 0 A1 1 0 0 1 10 0 Z");
    expect(grown.yMin).toBeCloseTo(-5, 2);
  });

  it("rotates an ellipse by the arc's x-axis rotation", () => {
    const upright = pathBounds("M-20 0 A20 10 0 1 1 20 0 A20 10 0 1 1 -20 0 Z");
    expect(upright.yMax).toBeCloseTo(10, 2);
    const turned = pathBounds(
      "M0 -20 A20 10 90 1 1 0 20 A20 10 90 1 1 0 -20 Z"
    );
    expect(turned.xMax).toBeCloseTo(10, 2);
    expect(turned.yMax).toBeCloseTo(20, 2);
  });

  it("closes a subpath left open and keeps several subpaths apart", () => {
    const contours = parsePathData("M0 0 L10 0 L10 10 M20 0 L30 0 L30 10");
    expect(contours).toHaveLength(2);
    expect(contours[1]?.start).toEqual({ x: 20, y: 0 });
  });
});

describe("transforms", () => {
  it("applies a list right to left", () => {
    const transform = parseTransform("translate(100 0) scale(2)");
    expect(transform).toMatchObject({ dx: 100, dy: 0, xx: 2, yy: 2 });
  });

  it("rotates about a centre", () => {
    const transform = parseTransform("rotate(90, 10, 10)");
    const x = transform.xx * 20 + transform.yx * 10 + transform.dx;
    const y = transform.xy * 20 + transform.yy * 10 + transform.dy;
    expect(x).toBeCloseTo(10);
    expect(y).toBeCloseTo(20);
  });
});

describe("svg documents", () => {
  it("applies the transforms of the path and of every group around it", () => {
    const { shapes } = parseSvg(`<?xml version="1.0"?>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
        <g transform="translate(100, 50)">
          <g transform="scale(2)">
            <path transform="rotate(90)" d="M0 0 h10 v5 h-10 z"/>
          </g>
        </g>
      </svg>`);
    // The 10 by 5 box turns to 5 by 10 leftwards, doubles, then moves.
    const bounds = boundsOf(shapes[0]?.outline ?? { contours: [] });
    expect(bounds.xMin).toBeCloseTo(90);
    expect(bounds.xMax).toBeCloseTo(100);
    expect(bounds.yMin).toBeCloseTo(50);
    expect(bounds.yMax).toBeCloseTo(70);
  });

  it("reads basic shapes", () => {
    const { shapes } = parseSvg(`<svg viewBox="0 0 100 100">
      <rect x="10" y="20" width="30" height="40"/>
      <rect x="0" y="0" width="20" height="20" rx="5"/>
      <circle cx="50" cy="50" r="10"/>
      <ellipse cx="50" cy="50" rx="20" ry="5"/>
      <polygon points="0,0 10,0 5,8"/>
    </svg>`);
    expect(shapes.map((shape) => shape.element)).toEqual([
      "rect",
      "rect",
      "circle",
      "ellipse",
      "polygon",
    ]);
    const [box, rounded, circle, ellipse, triangle] = shapes.map((shape) =>
      boundsOf(shape.outline)
    );
    expect(box).toEqual({ xMax: 40, xMin: 10, yMax: 60, yMin: 20 });
    expect(rounded?.xMax).toBeCloseTo(20);
    expect(shapes[1]?.outline.contours[0]?.segments).toHaveLength(8);
    expect(circle?.xMin).toBeCloseTo(40, 1);
    expect(circle?.yMax).toBeCloseTo(60, 1);
    expect(ellipse?.xMax).toBeCloseTo(70, 1);
    expect(ellipse?.yMin).toBeCloseTo(45, 1);
    expect(triangle).toEqual({ xMax: 10, xMin: 0, yMax: 8, yMin: 0 });
  });

  it("reports strokes and text as defects and leaves unfilled shapes out", () => {
    const { defects, shapes } = parseSvg(`<svg viewBox="0 0 100 100">
      <path d="M0 0 h10 v10 z" fill="none" stroke="#000" stroke-width="2"/>
      <path d="M0 0 h10 v10 z" style="fill: #000; stroke: red"/>
      <text x="5" y="5">A</text>
      <line x1="0" y1="0" x2="5" y2="5"/>
    </svg>`);
    expect(shapes).toHaveLength(1);
    expect(defects.map((defect) => defect.kind)).toEqual([
      "stroke",
      "stroke",
      "text",
      "unsupported-element",
    ]);
  });

  it("inherits fills, reads style sheets and measures how dark a fill is", () => {
    const { shapes } = parseSvg(`<svg viewBox="0 0 100 100">
      <style><![CDATA[ .paper { fill: #fff } .ink { fill: rgb(0, 0, 0) } ]]></style>
      <defs><path d="M0 0 h50 v50 z"/></defs>
      <rect class="paper" width="100" height="100"/>
      <g fill="#333"><path d="M0 0 h10 v10 z"/></g>
      <path class="ink" fill-rule="evenodd" d="M0 0 h10 v10 z"/>
      <path d="M0 0 h10 v10 z" display="none"/>
    </svg>`);
    expect(shapes.map((shape) => Number(shape.darkness.toFixed(2)))).toEqual([
      0, 0.8, 1,
    ]);
    expect(shapes[2]?.evenOdd).toBe(true);
  });

  it("refuses a file that is not well formed", () => {
    expect(() => parseSvg("<svg><g></svg>")).toThrow(MalformedXmlError);
  });
});
