/** Extract, for a glyph sheet that arrived as a picture. */
import { type Outline, transformOutline } from "~/typeface/outline";
import {
  type Bitmap,
  createBitmap,
  inkAt,
  type PixelBox,
  type RasterImage,
} from "../raster/bitmap";
import type { SheetLayout } from "../sheet/layout";
import { contourTracer } from "../vector/trace";
import type { TraceOptions, Vectorizer } from "../vector/vectorizer";
import { assembleExtraction, type CellOutline } from "./assemble";
import { type CellSearch, type FoundCell, findCells } from "./cells";
import type { SheetExtraction } from "./extraction";
import { inkFromImage } from "./ink";

export interface ExtractionOptions {
  readonly trace?: TraceOptions;
  /** The tracer to use. The built-in contour tracer when absent. */
  readonly vectorizer?: Vectorizer;
}

/** Paper kept around a cell's ink so the tracer sees every edge whole. */
const MARGIN = 2;

/**
 * One cell's ink on its own: the cell's box cut from the sheet, with ink
 * that belongs to anything else in the box wiped out.
 */
export const cutCell = (search: CellSearch, cell: FoundCell): Bitmap => {
  const { cleaned, labelled } = search;
  const members = new Set(cell.members);
  const cut = createBitmap(
    cell.box.right - cell.box.left + 2 * MARGIN,
    cell.box.bottom - cell.box.top + 2 * MARGIN
  );
  for (let y = 0; y < cut.height; y += 1) {
    for (let x = 0; x < cut.width; x += 1) {
      const sheetX = cell.box.left - MARGIN + x;
      const sheetY = cell.box.top - MARGIN + y;
      const inside =
        sheetX >= 0 &&
        sheetY >= 0 &&
        sheetX < labelled.width &&
        sheetY < labelled.height;
      const owner = inside
        ? (labelled.labels[sheetY * labelled.width + sheetX] ?? 0)
        : 0;
      cut.data[y * cut.width + x] =
        owner === 0 || members.has(owner) ? inkAt(cleaned, sheetX, sheetY) : 0;
    }
  }
  return cut;
};

/** A traced cut-out, moved back to where its cell sits on the sheet, with y down. */
export const tracedOnSheet = (traced: Outline, box: PixelBox): Outline =>
  transformOutline(traced, {
    dx: box.left - MARGIN,
    dy: box.bottom + MARGIN,
    xx: 1,
    xy: 0,
    yx: 0,
    yy: -1,
  });

/** Extracts the glyphs of a sheet from its ink map. */
export const extractInkSheet = (
  ink: Bitmap,
  layout: SheetLayout,
  options: ExtractionOptions = {}
): SheetExtraction => {
  const vectorizer = options.vectorizer ?? contourTracer;
  const search = findCells(ink, layout);
  const drawn = search.cells.map((cell): CellOutline => {
    const bitmap = cutCell(search, cell);
    return {
      bitmap,
      cell,
      outline: tracedOnSheet(vectorizer.trace(bitmap, options.trace), cell.box),
      source: "traced",
    };
  });
  return assembleExtraction(
    search,
    drawn,
    { height: ink.height, width: ink.width },
    []
  );
};

/**
 * Splits a picture of a glyph sheet into one outline per requested glyph.
 * The layout is a hint; cells and ink are found in the picture itself.
 */
export const extractRasterSheet = (
  image: RasterImage,
  layout: SheetLayout,
  options: ExtractionOptions = {}
): SheetExtraction => extractInkSheet(inkFromImage(image), layout, options);
