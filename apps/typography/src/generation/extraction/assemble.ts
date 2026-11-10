/**
 * The last steps every sheet shares once each cell has an outline: straighten
 * the sheet, find each row's baseline, and express each glyph from its own
 * baseline so that relative size and vertical position survive.
 */
import {
  type Outline,
  outlineBounds,
  transformOutline,
} from "~/typeface/outline";
import type { Bitmap } from "../raster/bitmap";
import { median } from "../style/measure";
import { type CellSearch, cellCentre, type FoundCell } from "./cells";
import type { ExtractedGlyph, SheetExtraction, SheetRow } from "./extraction";
import {
  dominant,
  type InkFoot,
  rotationOf,
  straightening,
} from "./straighten";

export interface CellOutline {
  readonly bitmap?: Bitmap;
  readonly cell: FoundCell;
  /** In sheet pixels with y down. */
  readonly outline: Outline;
  readonly source: ExtractedGlyph["source"];
}

/** Feet and heads within this share of the body height stand on the same line. */
const SAME_LINE = 0.06;

interface Straight {
  readonly bottom: number;
  readonly drawn: CellOutline;
  readonly left: number;
  readonly outline: Outline;
  readonly top: number;
}

const rowsOf = (
  straight: readonly Straight[],
  bodyHeight: number
): Map<number, SheetRow> => {
  const rows = new Map<number, SheetRow>();
  const numbers = new Set(straight.map((item) => item.drawn.cell.row));
  for (const row of numbers) {
    const inRow = straight.filter((item) => item.drawn.cell.row === row);
    const tolerance = SAME_LINE * bodyHeight;
    const baseline =
      dominant(
        inRow.map((item) => item.bottom),
        tolerance
      ) ?? 0;
    const head =
      dominant(
        inRow.map((item) => item.top),
        tolerance
      ) ?? baseline;
    rows.set(row, { baseline, bodyHeight: baseline - head });
  }
  return rows;
};

export const assembleExtraction = (
  search: CellSearch,
  drawn: readonly CellOutline[],
  size: { readonly height: number; readonly width: number },
  notes: readonly string[]
): SheetExtraction => {
  const feet: InkFoot[] = drawn.map(({ cell }) => ({
    bottom: cell.box.bottom,
    row: cell.row,
    top: cell.box.top,
    x: cellCentre(cell).x,
  }));
  const widths = drawn.map(({ cell }) => cell.box.right - cell.box.left);
  const rotation = rotationOf(feet, median(widths) ?? 0);
  const upright = straightening(rotation, {
    x: size.width / 2,
    y: size.height / 2,
  });
  const straight: Straight[] = [];
  for (const item of drawn) {
    const outline = transformOutline(item.outline, upright);
    const bounds = outlineBounds(outline);
    if (bounds) {
      straight.push({
        bottom: bounds.yMax,
        drawn: item,
        left: bounds.xMin,
        outline,
        top: bounds.yMin,
      });
    }
  }
  const rows = rowsOf(straight, search.bodyHeight);
  const glyphs = straight.map(
    ({ drawn: item, left, outline }): ExtractedGlyph => {
      const baseline = rows.get(item.cell.row)?.baseline ?? 0;
      return {
        bitmap: item.bitmap,
        box: item.cell.box,
        column: item.cell.column,
        key: item.cell.key,
        outline: transformOutline(outline, {
          dx: -left,
          dy: baseline,
          xx: 1,
          xy: 0,
          yx: 0,
          yy: -1,
        }),
        row: item.cell.row,
        source: item.source,
      };
    }
  );
  const lastRow = Math.max(-1, ...rows.keys());
  return {
    glyphs,
    report: {
      empty: search.empty,
      extra: search.extra,
      guides: search.guides,
      labels: search.labels,
      merged: search.merged,
      notes,
    },
    rotation,
    rows: Array.from(
      { length: lastRow + 1 },
      (_, row) => rows.get(row) ?? { baseline: 0, bodyHeight: 0 }
    ),
    size,
  };
};
