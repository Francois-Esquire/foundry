/**
 * The pieces of ink in a separated region: connected components, with the
 * specks among them removed. A speck is far smaller than a stroke is thick,
 * so the dot of an i stays and the grain of a photograph goes.
 */

import {
  type InkComponent,
  type Labelled,
  labelComponents,
} from "~/generation/extraction/components";
import {
  type Bitmap,
  INK_THRESHOLD,
  type PixelBox,
} from "~/generation/raster/bitmap";

export interface InkPieces {
  /** The ink map with the specks wiped out. */
  readonly ink: Bitmap;
  /** Which piece each pixel belongs to. Specks keep their ids here and are absent from `pieces`. */
  readonly labelled: Labelled;
  readonly pieces: readonly InkComponent[];
  readonly specksRemoved: number;
  /** The usual stroke thickness, in pixels: the middle value by ink area. */
  readonly strokeThickness: number;
}

export interface PieceOptions {
  /** Pieces smaller than this many pixels are specks. A quarter of a stroke squared when absent. */
  readonly minimumArea?: number;
}

/** A stroke this thin still has a quarter of its square as the speck limit, never less than this. */
const SMALLEST_SPECK = 4;

/** The thickness that half the ink, by area, is at least as thick as. */
const usualThickness = (components: readonly InkComponent[]): number => {
  const sorted = components.toSorted((a, b) => a.thickness - b.thickness);
  const total = sorted.reduce((sum, component) => sum + component.area, 0);
  let seen = 0;
  for (const component of sorted) {
    seen += component.area;
    if (seen >= total / 2) {
      return component.thickness;
    }
  }
  return 1;
};

/** Finds the pieces of ink and removes the specks. */
export const findPieces = (
  ink: Bitmap,
  options: PieceOptions = {}
): InkPieces => {
  const labelled = labelComponents(ink, INK_THRESHOLD);
  const strokeThickness = usualThickness(labelled.components);
  const minimumArea =
    options.minimumArea ?? Math.max(SMALLEST_SPECK, strokeThickness ** 2 / 4);
  const kept = new Set<number>();
  const pieces = labelled.components.filter(
    (component) => component.area >= minimumArea
  );
  for (const piece of pieces) {
    kept.add(piece.id);
  }
  const data = ink.data.slice();
  for (let pixel = 0; pixel < data.length; pixel += 1) {
    const owner = labelled.labels[pixel] ?? 0;
    if (owner !== 0 && !kept.has(owner)) {
      data[pixel] = 0;
    }
  }
  return {
    ink: { data, height: ink.height, width: ink.width },
    labelled,
    pieces,
    specksRemoved: labelled.components.length - pieces.length,
    strokeThickness,
  };
};

/** Paper kept around a cut-out so a tracer sees every edge whole. */
export const CUT_MARGIN = 2;

/**
 * The ink of some pieces on its own: their box cut from the region with a
 * margin, and the ink of every other piece inside the box wiped out.
 */
export const cutPieces = (
  { ink, labelled }: InkPieces,
  members: readonly number[],
  box: PixelBox
): Bitmap => {
  const own = new Set(members);
  const width = box.right - box.left + 2 * CUT_MARGIN;
  const height = box.bottom - box.top + 2 * CUT_MARGIN;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sourceY = box.top - CUT_MARGIN + y;
    if (sourceY < 0 || sourceY >= ink.height) {
      continue;
    }
    for (let x = 0; x < width; x += 1) {
      const sourceX = box.left - CUT_MARGIN + x;
      if (sourceX < 0 || sourceX >= ink.width) {
        continue;
      }
      const at = sourceY * ink.width + sourceX;
      const owner = labelled.labels[at] ?? 0;
      // Paper keeps its grey level, so the edge of the ink stays as fine as
      // the picture made it. Another piece's ink is wiped.
      if (owner === 0 || own.has(owner)) {
        data[y * width + x] = ink.data[at] ?? 0;
      }
    }
  }
  return { data, height, width };
};
