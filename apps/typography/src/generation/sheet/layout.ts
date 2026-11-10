/**
 * The grid of a glyph sheet: the one model behind the style reference sheet,
 * the sheet a model is asked to draw, and the hint extraction starts from.
 */

export interface SheetCell {
  /** The key of the glyph in the cell. */
  readonly key: string;
  /** What a label on the cell says. */
  readonly label: string;
}

export interface SheetLayout {
  /** Where the baseline sits in a cell, as a share of the cell height from its top. */
  readonly baseline: number;
  readonly cellHeight: number;
  /** Cells in reading order, row by row. The last row may be short. */
  readonly cells: readonly SheetCell[];
  readonly cellWidth: number;
  readonly columns: number;
  /** The height of one em in a cell, in sheet pixels. */
  readonly emSize: number;
  /**
   * How many rows the sheet has, when that is more than the cells fill: a
   * sheet may hold cells nobody asked to use.
   */
  readonly rows?: number;
}

export const sheetRows = (layout: SheetLayout) =>
  Math.max(layout.rows ?? 0, Math.ceil(layout.cells.length / layout.columns));

export const sheetWidth = (layout: SheetLayout) =>
  layout.columns * layout.cellWidth;

export const sheetHeight = (layout: SheetLayout) =>
  sheetRows(layout) * layout.cellHeight;

export interface LayoutOptions {
  /** The widest and tallest the sheet may be, in pixels. */
  readonly maxSize?: number;
}

const DEFAULT_SIZE = 1024;
const BASELINE = 0.72;
const EM_SHARE = 0.62;

/** A near-square grid of equal cells that fits the given size. */
export const layoutSheet = (
  cells: readonly SheetCell[],
  options: LayoutOptions = {}
): SheetLayout => {
  const size = options.maxSize ?? DEFAULT_SIZE;
  const columns = Math.max(1, Math.ceil(Math.sqrt(cells.length)));
  const rows = Math.max(1, Math.ceil(cells.length / columns));
  const cell = Math.floor(size / Math.max(columns, rows));
  return {
    baseline: BASELINE,
    cellHeight: cell,
    cells,
    cellWidth: cell,
    columns,
    emSize: cell * EM_SHARE,
  };
};
