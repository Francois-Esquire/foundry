import type { Bitmap } from "~/generation/raster/bitmap";
import { rasterizePolygons } from "~/generation/raster/rasterize";
import type { SheetLayout } from "~/generation/sheet/layout";
import { faceLabelWriter } from "~/generation/style/reference-sheet";
import { type Outline, transformOutline } from "~/typeface/outline";
import { flattenOutline } from "~/typeface/outline-geometry";
import type { GlyphShape, OpenFace } from "~/typeface/reading";

/** A hand-built sheet that breaks the grid the way a model does. */
export interface UnevenSheet {
  /** Pixels per em of the glyphs. */
  readonly emSize: number;
  readonly ink: Bitmap;
  /** The even grid a request would have asked for. */
  readonly layout: SheetLayout;
  /** Degrees the whole sheet is turned, clockwise as seen. */
  readonly rotation: number;
  /** Font units per pixel. */
  readonly unitsPerPixel: number;
}

const COLUMN_LEFTS = [0, 260, 610];
const COLUMN_WIDTHS = [260, 350, 290];
const ROW_TOPS = [0, 240, 520];
const WIDTH = 900;
const HEIGHT = 780;
const EM = 150;
const BASELINE_DROP = 170;
const LABEL_EM = 20;
const ROTATION = 1.5;

const rule = (
  left: number,
  top: number,
  width: number,
  height: number
): Outline => ({
  contours: [
    {
      segments: [
        { kind: "line", to: { x: left + width, y: top } },
        { kind: "line", to: { x: left + width, y: top + height } },
        { kind: "line", to: { x: left, y: top + height } },
      ],
      start: { x: left, y: top },
    },
  ],
});

const place = (outline: Outline, scale: number, x: number, baseline: number) =>
  transformOutline(outline, {
    dx: x,
    dy: baseline,
    xx: scale,
    xy: 0,
    yx: 0,
    yy: -scale,
  });

const turn = (outline: Outline, degrees: number): Outline => {
  const angle = (degrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  return transformOutline(outline, {
    dx: cx - cos * cx + sin * cy,
    dy: cy - sin * cx - cos * cy,
    xx: cos,
    xy: sin,
    yx: -sin,
    yy: cos,
  });
};

/**
 * Three rows of three uneven cells with dark rules on every baseline and
 * cell edge, a small label in each cell, one cell left empty, and all of it
 * turned by a degree and a half.
 */
export const unevenSheet = (
  face: OpenFace,
  cells: readonly (string | undefined)[],
  glyphOf: (character: string) => GlyphShape
): UnevenSheet => {
  const { unitsPerEm } = face.description.metrics;
  const scale = EM / unitsPerEm;
  const label = faceLabelWriter(face);
  const shapes: Outline[] = [];
  for (const [index, character] of cells.entries()) {
    const column = index % 3;
    const row = Math.floor(index / 3);
    const left = COLUMN_LEFTS[column] ?? 0;
    const top = ROW_TOPS[row] ?? 0;
    const text = label(character ?? "empty");
    if (text) {
      shapes.push(
        place(text.outline, LABEL_EM / unitsPerEm, left + 12, top + 30)
      );
    }
    if (character) {
      const glyph = glyphOf(character);
      const width = COLUMN_WIDTHS[column] ?? 0;
      shapes.push(
        place(
          glyph.outline,
          scale,
          left + (width - glyph.advance * scale) / 2,
          top + BASELINE_DROP
        )
      );
    }
  }
  for (const top of ROW_TOPS) {
    shapes.push(
      rule(0, top + 1, WIDTH, 2),
      rule(0, top + BASELINE_DROP, WIDTH, 2)
    );
  }
  for (const left of [...COLUMN_LEFTS.slice(1), WIDTH - 3]) {
    shapes.push(rule(left, 0, 2, HEIGHT));
  }
  const ink = rasterizePolygons(
    shapes.flatMap((shape) => flattenOutline(turn(shape, ROTATION), 0.05)),
    WIDTH,
    HEIGHT,
    { antialias: true }
  );
  return {
    emSize: EM,
    ink,
    layout: {
      baseline: 0.65,
      cellHeight: HEIGHT / 3,
      cells: cells.map((character, index) => ({
        key: character ?? `empty-${index}`,
        label: character ?? "",
      })),
      cellWidth: WIDTH / 3,
      columns: 3,
      emSize: EM,
    },
    rotation: ROTATION,
    unitsPerPixel: unitsPerEm / EM,
  };
};
