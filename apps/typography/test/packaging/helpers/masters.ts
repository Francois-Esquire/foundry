import type {
  VariableBuildRequest,
  VariableMaster,
} from "~/packaging/building";
import type { AddedGlyph } from "~/typeface/changes";
import { type Outline, outlinePoints } from "~/typeface/outline";
import type { GlyphShape } from "~/typeface/reading";

const WEDGE_CHARACTER = 0xe0_00;
export const BLOB_CHARACTER = 0xe0_01;

/** How far a cubic control point sits from its end to draw a quarter circle. */
const QUARTER_CIRCLE = 0.5523;

/** A triangle on the baseline whose base grows with `width`, so masters can differ in weight only. */
const wedge = (width: number): Outline => ({
  contours: [
    {
      segments: [
        { kind: "line", to: { x: 100 + width / 2, y: 700 } },
        { kind: "line", to: { x: 100 + width, y: 0 } },
      ],
      start: { x: 100, y: 0 },
    },
  ],
});

export const addedWedge = (
  width: number,
  changes: Partial<AddedGlyph> = {}
): AddedGlyph => ({
  advance: width + 200,
  characters: [WEDGE_CHARACTER],
  key: "wedge",
  name: "wedge",
  outline: wedge(width),
  provenance: { origin: "manual" },
  ...changes,
});

/** A circle of four cubic curves, drawn counter-clockwise, which TrueType has to convert and turn. */
const blob = (radius: number): Outline => {
  const centre = { x: 100 + radius, y: 350 };
  const reach = radius * QUARTER_CIRCLE;
  const at = (dx: number, dy: number) => ({
    x: centre.x + dx,
    y: centre.y + dy,
  });
  return {
    contours: [
      {
        segments: [
          {
            control1: at(radius, reach),
            control2: at(reach, radius),
            kind: "cubic",
            to: at(0, radius),
          },
          {
            control1: at(-reach, radius),
            control2: at(-radius, reach),
            kind: "cubic",
            to: at(-radius, 0),
          },
          {
            control1: at(-radius, -reach),
            control2: at(-reach, -radius),
            kind: "cubic",
            to: at(0, -radius),
          },
          {
            control1: at(reach, -radius),
            control2: at(radius, -reach),
            kind: "cubic",
            to: at(radius, 0),
          },
        ],
        start: at(radius, 0),
      },
    ],
  };
};

export const addedBlob = (radius: number): AddedGlyph => ({
  advance: 2 * radius + 200,
  characters: [BLOB_CHARACTER],
  key: "blob",
  name: "blob",
  outline: blob(radius),
  provenance: { origin: "manual" },
});

/** A master that changes nothing, to spread over. */
export const masterAt = (
  weight: number,
  styleName: string,
  changes: Partial<VariableMaster> = {}
): VariableMaster => ({
  added: [],
  featureCode: [],
  location: { wght: weight },
  overrides: new Map(),
  styleName,
  ...changes,
});

/** How wide the wedge is drawn at a weight. */
export const wedgeWidthAt = (weight: number) => 100 + weight / 2;

/** A master that adds the wedge, wider the heavier the master. */
export const wedgeMaster = (weight: number, styleName: string) =>
  masterAt(weight, styleName, { added: [addedWedge(wedgeWidthAt(weight))] });

export const variableRequestFor = (
  source: Uint8Array,
  masters: readonly VariableMaster[],
  changes: Partial<VariableBuildRequest> = {}
): VariableBuildRequest => ({ faceIndex: 0, masters, source, ...changes });

/** A glyph as numbers: its advance, then every point's x and y. */
const numbersOf = (glyph: GlyphShape) => [
  glyph.advance,
  ...outlinePoints(glyph.outline).flatMap(({ x, y }) => [x, y]),
];

const furthest = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length
    ? Math.max(...a.map((value, index) => Math.abs(value - (b[index] ?? 0))))
    : Number.POSITIVE_INFINITY;

/** The largest difference between two glyphs, in advance or in any point. Infinite when their points do not match up. */
export const furthestApart = (a: GlyphShape, b: GlyphShape) =>
  furthest(numbersOf(a), numbersOf(b));

/** How far a glyph is from the drawing halfway between two others. */
export const furthestFromHalfway = (
  glyph: GlyphShape,
  a: GlyphShape,
  b: GlyphShape
) => {
  const other = numbersOf(b);
  const middle = numbersOf(a).map(
    (value, index) => (value + (other[index] ?? Number.NaN)) / 2
  );
  return furthest(numbersOf(glyph), middle);
};
