/** What extraction hands on: one item per glyph found on a sheet, and what went wrong. */
import type { Outline } from "~/typeface/outline";
import type { Bitmap, PixelBox } from "../raster/bitmap";

export interface ExtractedGlyph {
  /** The glyph's ink cut out of the sheet. Absent when the outline came straight from vector shapes. */
  readonly bitmap?: Bitmap;
  /** Where the ink sits on the sheet, in sheet pixels. */
  readonly box: PixelBox;
  readonly column: number;
  readonly key: string;
  /**
   * In sheet pixels, straightened, with y up from the baseline of the
   * glyph's row and x from the left edge of its ink.
   */
  readonly outline: Outline;
  readonly row: number;
  /** Traced from pixels, or taken over from the vector shapes of an SVG. */
  readonly source: "traced" | "vector";
}

export interface SheetRow {
  /** The y of the row's baseline, in straightened sheet pixels from the top. */
  readonly baseline: number;
  /** How far above the baseline most of the row's glyphs reach, in pixels. */
  readonly bodyHeight: number;
}

interface ExtractionReport {
  /** Keys of cells where no ink was found. */
  readonly empty: readonly string[];
  /** Ink that belongs to no cell of the layout. */
  readonly extra: readonly PixelBox[];
  /** How many ruled lines were removed. */
  readonly guides: number;
  /** How many pieces of ink were set aside as label text. */
  readonly labels: number;
  /** Groups of cells whose ink runs together. No glyph is extracted for them. */
  readonly merged: readonly (readonly string[])[];
  readonly notes: readonly string[];
}

export interface SheetExtraction {
  readonly glyphs: readonly ExtractedGlyph[];
  readonly report: ExtractionReport;
  /** How far the ink was turned, in degrees clockwise, before it was straightened. */
  readonly rotation: number;
  readonly rows: readonly SheetRow[];
  /** The size of the sheet the positions refer to, in pixels. */
  readonly size: { readonly height: number; readonly width: number };
}
