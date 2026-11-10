/**
 * What the Studio can do to an outline, taken through a font build: a node
 * added part way along a curve leaves coordinates that are not whole numbers,
 * and "make curved" puts a cubic segment into a font whose curves are
 * quadratic. The built font has to hold the same shape in its own terms.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { shapeAgreement } from "~/generation/evaluation/agreement";
import { nodeFontBuilder } from "~/packaging/engine/node";
import {
  type Outline,
  outlinePoints,
  type Point,
  type Segment,
} from "~/typeface/outline";
import { convertSegment, insertNode } from "~/typeface/outline-editing";
import type { GlyphShape } from "~/typeface/reading";
import { fontBytes } from "./helpers/fixtures";

const BULGE = 80;

const firstSegment = (outline: Outline, kind: Segment["kind"]) =>
  outline.contours[0]?.segments.findIndex((segment) => segment.kind === kind) ??
  -1;

/** The longest straight segment of the first contour: a stem of the letter. */
const longestLine = (outline: Outline) => {
  const [contour] = outline.contours;
  let from = contour?.start ?? { x: 0, y: 0 };
  let best = { index: -1, length: 0 };
  for (const [index, segment] of (contour?.segments ?? []).entries()) {
    const length = Math.hypot(segment.to.x - from.x, segment.to.y - from.y);
    if (segment.kind === "line" && length > best.length) {
      best = { index, length };
    }
    from = segment.to;
  }
  return best.index;
};

const pushed = (point: Point): Point => ({
  x: point.x + BULGE,
  y: point.y + BULGE,
});

/** Pushes the handles of one cubic segment aside, so the curve leaves the line. */
const bulge = (outline: Outline, index: number): Outline => ({
  contours: outline.contours.map((contour, position) =>
    position === 0
      ? {
          ...contour,
          segments: contour.segments.map((segment, at) =>
            at === index && segment.kind === "cubic"
              ? {
                  ...segment,
                  control1: pushed(segment.control1),
                  control2: pushed(segment.control2),
                }
              : segment
          ),
        }
      : contour
  ),
});

describe("an outline edited in the Studio, built into a font", () => {
  let source: GlyphShape;
  let edited: Outline;
  let built: GlyphShape;
  let unitsPerEm: number;

  beforeAll(async () => {
    const bytes = fontBytes("lato");
    const face = harfBuzzReader.open(bytes);
    ({ unitsPerEm } = face.description.metrics);
    const glyphId = face.glyphForCharacter("n".codePointAt(0) ?? 0) ?? 0;
    source = face.glyph(glyphId);
    const withNode = insertNode(
      source.outline,
      0,
      firstSegment(source.outline, "quadratic"),
      0.37
    );
    const line = longestLine(withNode);
    edited = bulge(convertSegment(withNode, 0, line, "cubic"), line);
    const builder = await nodeFontBuilder();
    const font = await builder.build({
      added: [],
      faceIndex: 0,
      featureCode: [],
      overrides: new Map([[glyphId, { outline: edited }]]),
      source: bytes,
    });
    const derived = harfBuzzReader.open(font.bytes);
    built = derived.glyph(
      derived.glyphForCharacter("n".codePointAt(0) ?? 0) ?? 0
    );
  });

  it("starts from an edit that a quadratic font cannot hold as it is", () => {
    const points = outlinePoints(edited);
    expect(points.some((point) => !Number.isInteger(point.x))).toBe(true);
    expect(
      edited.contours.some((contour) =>
        contour.segments.some((segment) => segment.kind === "cubic")
      )
    ).toBe(true);
  });

  it("holds whole-number quadratic curves in the built font", () => {
    const points = outlinePoints(built.outline);
    expect(
      points.every(
        (point) => Number.isInteger(point.x) && Number.isInteger(point.y)
      )
    ).toBe(true);
    expect(
      built.outline.contours.every((contour) =>
        contour.segments.every((segment) => segment.kind !== "cubic")
      )
    ).toBe(true);
  });

  it("keeps the edited shape, which differs from the source", () => {
    expect(
      shapeAgreement(built.outline, edited, unitsPerEm).inPlace
    ).toBeGreaterThan(0.99);
    expect(
      shapeAgreement(built.outline, source.outline, unitsPerEm).inPlace
    ).toBeLessThan(0.99);
  });
});
