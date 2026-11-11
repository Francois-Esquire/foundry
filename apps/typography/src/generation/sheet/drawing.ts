/**
 * Draws a glyph sheet from its layout. One drawing gives both the SVG that
 * documents a sheet and the bitmap a model is shown, so the two cannot differ.
 */
import {
  type Outline,
  outlineToPath,
  transformOutline,
} from "~/typeface/outline";
import { flattenOutline } from "~/typeface/outline-geometry";
import type { GlyphShape } from "~/typeface/reading";
import type { Bitmap } from "../raster/bitmap";
import { rasterizePolygons } from "../raster/rasterize";
import { type SheetLayout, sheetHeight, sheetRows, sheetWidth } from "./layout";

type SheetTone = "glyph" | "guide" | "label";

interface SheetShape {
  /** In sheet pixels, with y down. */
  readonly outline: Outline;
  readonly tone: SheetTone;
}

export interface SheetDrawing {
  readonly height: number;
  readonly shapes: readonly SheetShape[];
  readonly width: number;
}

/** Sets a short text as one outline in font units, or nothing when it cannot. */
export type LabelWriter = (text: string) => GlyphShape | undefined;

export interface DrawOptions {
  /** Rule the baseline of each row and the edges of each cell. */
  readonly guides?: boolean;
  /** Label each cell in its top-left corner. */
  readonly labels?: LabelWriter;
  readonly unitsPerEm: number;
}

/** How dark each tone is in the bitmap, where 255 is full ink. */
const TONE_INK: Readonly<Record<SheetTone, number>> = {
  glyph: 255,
  guide: 56,
  label: 255,
};
const TONE_FILL: Readonly<Record<SheetTone, string>> = {
  glyph: "#000",
  guide: "#c7c7c7",
  label: "#000",
};
const LABEL_EM = 0.09;
const LABEL_INSET = 0.05;

const rectangle = (
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

/** Font units to sheet pixels: scaled, turned so y points down, and moved. */
const place = (outline: Outline, scale: number, x: number, baseline: number) =>
  transformOutline(outline, {
    dx: x,
    dy: baseline,
    xx: scale,
    xy: 0,
    yx: 0,
    yy: -scale,
  });

const guideShapes = (layout: SheetLayout): SheetShape[] => {
  const width = sheetWidth(layout);
  const height = sheetHeight(layout);
  const guides: Outline[] = [];
  for (let row = 0; row < sheetRows(layout); row += 1) {
    const top = row * layout.cellHeight;
    guides.push(
      rectangle(0, top, width, 1),
      rectangle(0, top + layout.baseline * layout.cellHeight, width, 1)
    );
  }
  for (let column = 0; column <= layout.columns; column += 1) {
    const left = Math.min(width - 1, column * layout.cellWidth);
    guides.push(rectangle(left, 0, 1, height));
  }
  guides.push(rectangle(0, height - 1, width, 1));
  return guides.map((outline) => ({ outline, tone: "guide" }));
};

/** Draws the glyphs of a layout, each centred on its advance and standing on the cell's baseline. */
export const drawSheet = (
  layout: SheetLayout,
  glyphs: ReadonlyMap<string, GlyphShape>,
  options: DrawOptions
): SheetDrawing => {
  const shapes: SheetShape[] = options.guides ? guideShapes(layout) : [];
  const scale = layout.emSize / options.unitsPerEm;
  const labelScale = (layout.cellHeight * LABEL_EM) / options.unitsPerEm;
  for (const [index, cell] of layout.cells.entries()) {
    const left = (index % layout.columns) * layout.cellWidth;
    const top = Math.floor(index / layout.columns) * layout.cellHeight;
    const glyph = glyphs.get(cell.key);
    if (glyph) {
      shapes.push({
        outline: place(
          glyph.outline,
          scale,
          left + (layout.cellWidth - glyph.advance * scale) / 2,
          top + layout.baseline * layout.cellHeight
        ),
        tone: "glyph",
      });
    }
    const label = options.labels ? options.labels(cell.label) : undefined;
    if (label !== undefined) {
      const inset = layout.cellHeight * LABEL_INSET;
      shapes.push({
        outline: place(
          label.outline,
          labelScale,
          left + inset,
          top + inset + layout.cellHeight * LABEL_EM
        ),
        tone: "label",
      });
    }
  }
  return { height: sheetHeight(layout), shapes, width: sheetWidth(layout) };
};

/** The sheet as an SVG file: black glyphs and labels, grey guides, white paper. */
export const sheetToSvg = (drawing: SheetDrawing): string => {
  const paths = drawing.shapes.map(
    (shape) =>
      `<path class="${shape.tone}" fill="${TONE_FILL[shape.tone]}" d="${outlineToPath(shape.outline)}"/>`
  );
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${drawing.width} ${drawing.height}" width="${drawing.width}" height="${drawing.height}">`,
    `<rect class="paper" width="${drawing.width}" height="${drawing.height}" fill="#fff"/>`,
    ...paths,
    "</svg>",
  ].join("\n");
};

export interface SheetBitmapOptions {
  /** Ink level for the guides, 0 to 255. Light by default, so a threshold drops them. */
  readonly guideInk?: number;
}

/** The sheet as an ink map: 255 where a glyph or label is, less where a guide is. */
export const sheetToBitmap = (
  drawing: SheetDrawing,
  options: SheetBitmapOptions = {}
): Bitmap => {
  const tones: readonly SheetTone[] = ["guide", "label", "glyph"];
  const layers = tones.map((tone) => ({
    ink:
      tone === "guide" ? (options.guideInk ?? TONE_INK.guide) : TONE_INK[tone],
    layer: rasterizePolygons(
      drawing.shapes
        .filter((shape) => shape.tone === tone)
        .flatMap((shape) => flattenOutline(shape.outline, 0.05)),
      drawing.width,
      drawing.height,
      { antialias: true }
    ),
  }));
  const [first] = layers;
  if (!first) {
    throw new Error("A sheet has at least one tone.");
  }
  const bitmap = first.layer;
  for (let index = 0; index < bitmap.data.length; index += 1) {
    let ink = 0;
    for (const { ink: level, layer } of layers) {
      ink = Math.max(ink, ((layer.data[index] ?? 0) * level) / 255);
    }
    bitmap.data[index] = Math.round(ink);
  }
  return bitmap;
};

/** A greyscale picture of an ink map: black ink on white paper, ready to encode. */
export const inkToImage = (ink: Bitmap) => {
  const data = new Uint8Array(ink.width * ink.height * 4);
  for (let index = 0; index < ink.data.length; index += 1) {
    const level = 255 - (ink.data[index] ?? 0);
    data.set([level, level, level, 255], index * 4);
  }
  return { data, height: ink.height, width: ink.width };
};
