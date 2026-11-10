/**
 * Finds the cells of a sheet in its ink map: removes ruled lines, sets label
 * text aside, and groups the remaining ink into rows and columns.
 */
import {
  type Bitmap,
  boxHeight,
  boxWidth,
  INK_THRESHOLD,
  type PixelBox,
  unionBox,
} from "../raster/bitmap";
import {
  type SheetLayout,
  sheetHeight,
  sheetRows,
  sheetWidth,
} from "../sheet/layout";
import { type Band, bandCentre, bandsOf, matchBands } from "./bands";
import {
  type InkComponent,
  type Labelled,
  labelComponents,
} from "./components";
import { removeGuideLines } from "./guides";

export interface FoundCell {
  /** The box around the ink of the cell's glyph. */
  readonly box: PixelBox;
  readonly column: number;
  readonly key: string;
  /** The ids of the pieces of ink that make up the glyph. */
  readonly members: readonly number[];
  readonly row: number;
}

export interface CellSearch {
  /** The typical height of a glyph's main piece of ink, in pixels. */
  readonly bodyHeight: number;
  readonly cells: readonly FoundCell[];
  /** The ink map with ruled lines removed. */
  readonly cleaned: Bitmap;
  readonly empty: readonly string[];
  readonly extra: readonly PixelBox[];
  readonly guides: number;
  readonly labelled: Labelled;
  readonly labels: number;
  readonly merged: readonly (readonly string[])[];
}

/** Ink this much thinner than the glyphs' strokes is label text or a leftover rule. */
const THIN = 0.45;
/** Label text is this small beside a glyph. */
const SMALL = 0.4;
/** A piece of ink smaller than this share of the body height, squared, is a speck. */
const SPECK = 0.04;
/** Gaps narrower than these shares of a cell lie inside one glyph, not between two. */
const ROW_GAP = 0.08;
const COLUMN_GAP = 0.1;
/** A guide spans at least this share of a cell, and is at most this share of it thick. */
const GUIDE_LENGTH = 0.9;
const GUIDE_THICKNESS = 0.02;
/** A guide hidden behind a glyph for up to this share of a cell is still one line. */
const GUIDE_GAP = 0.6;
/** Where a glyph's ink is centred, as a share of the em above the baseline. */
const INK_CENTRE = 0.35;

/** The value at the middle of the total weight: the typical value where the ink is. */
const weightedMedian = (
  items: readonly InkComponent[],
  value: (item: InkComponent) => number
): number => {
  const sorted = items.toSorted((a, b) => value(a) - value(b));
  const half = sorted.reduce((sum, item) => sum + item.area, 0) / 2;
  let seen = 0;
  for (const item of sorted) {
    seen += item.area;
    if (seen >= half) {
      return value(item);
    }
  }
  return 0;
};

interface Sorted {
  readonly bodies: readonly InkComponent[];
  readonly bodyHeight: number;
  readonly labels: number;
  readonly rules: number;
}

/** Sorts pieces of ink into glyph bodies, label text, leftover rules and specks. */
const sortComponents = (components: readonly InkComponent[]): Sorted => {
  const bodyHeight = weightedMedian(components, (item) => boxHeight(item.box));
  const stem = weightedMedian(components, (item) => item.thickness);
  const bodies: InkComponent[] = [];
  let labels = 0;
  let rules = 0;
  for (const component of components) {
    const size = Math.max(boxWidth(component.box), boxHeight(component.box));
    const thin = component.thickness < THIN * stem;
    if (component.area < (SPECK * bodyHeight) ** 2) {
      continue;
    }
    if (thin && size < SMALL * bodyHeight) {
      labels += 1;
    } else if (thin) {
      rules += 1;
    } else {
      bodies.push(component);
    }
  }
  return { bodies, bodyHeight, labels, rules };
};

const centreOf = (box: PixelBox) => ({
  x: (box.left + box.right) / 2,
  y: (box.top + box.bottom) / 2,
});

const within = (band: Band, position: number) =>
  position >= band.start && position < band.end;

interface Grid {
  readonly cellHeight: number;
  readonly cellWidth: number;
  readonly columnCentres: number[];
  readonly rowCentres: number[];
}

/** The asked-for grid, stretched to the size the sheet actually has. */
const gridFor = (layout: SheetLayout, ink: Bitmap): Grid => {
  const cellWidth = (layout.cellWidth * ink.width) / sheetWidth(layout);
  const cellHeight = (layout.cellHeight * ink.height) / sheetHeight(layout);
  const inkCentre =
    layout.baseline - (INK_CENTRE * layout.emSize) / layout.cellHeight;
  return {
    cellHeight,
    cellWidth,
    columnCentres: Array.from(
      { length: layout.columns },
      (_, column) => (column + 0.5) * cellWidth
    ),
    rowCentres: Array.from(
      { length: sheetRows(layout) },
      (_, row) => (row + inkCentre) * cellHeight
    ),
  };
};

interface RowFinding {
  readonly bodies: readonly InkComponent[];
  readonly columns: ReturnType<typeof matchBands>;
  readonly keys: readonly string[];
  readonly row: number;
}

const cellFrom = (
  finding: RowFinding,
  column: number,
  band: Band
): FoundCell | undefined => {
  const members = finding.bodies.filter((body) =>
    within(band, centreOf(body.box).x)
  );
  const [first, ...rest] = members;
  const key = finding.keys[column];
  if (!(first && key)) {
    return;
  }
  return {
    box: rest.reduce((box, body) => unionBox(box, body.box), first.box),
    column,
    key,
    members: members.map((body) => body.id),
    row: finding.row,
  };
};

const boxOfBand = (bodies: readonly InkComponent[], band: Band): PixelBox[] => {
  const [first, ...rest] = bodies.filter((body) =>
    within(band, centreOf(body.box).x)
  );
  return first
    ? [rest.reduce((box, body) => unionBox(box, body.box), first.box)]
    : [];
};

interface RowCells {
  readonly cells: FoundCell[];
  readonly empty: string[];
  readonly extra: PixelBox[];
  readonly merged: string[][];
}

/** Sorts one row's column bands into cells found, cells empty, cells run together and ink left over. */
const sortRow = (finding: RowFinding): RowCells => {
  const { bodies, columns, keys } = finding;
  const found: RowCells = { cells: [], empty: [], extra: [], merged: [] };
  const lost = new Set<number>();
  for (const [first, last] of columns.merged) {
    found.merged.push(keys.slice(first, last + 1));
    for (let column = first; column <= last; column += 1) {
      lost.add(column);
    }
  }
  for (const [column, band] of columns.slots.entries()) {
    const key = keys[column];
    const cell = band && cellFrom(finding, column, band);
    if (cell) {
      found.cells.push(cell);
    } else if (band) {
      // Ink in a cell of the sheet that no target was asked for.
      found.extra.push(...boxOfBand(bodies, band));
    } else if (key && !lost.has(column)) {
      found.empty.push(key);
    }
  }
  found.extra.push(
    ...columns.extra.flatMap((spare) => boxOfBand(bodies, spare))
  );
  return found;
};

/** Finds the cells of a sheet. The layout says what was asked for; the ink says what is there. */
export const findCells = (ink: Bitmap, layout: SheetLayout): CellSearch => {
  const grid = gridFor(layout, ink);
  const cell = Math.min(grid.cellWidth, grid.cellHeight);
  const guides = removeGuideLines(ink, {
    maximumGap: GUIDE_GAP * cell,
    maximumThickness: Math.max(3, GUIDE_THICKNESS * grid.cellHeight),
    minimumLength: GUIDE_LENGTH * cell,
    threshold: INK_THRESHOLD,
  });
  const labelled = labelComponents(guides.bitmap, INK_THRESHOLD);
  const sorted = sortComponents(labelled.components);
  const rowBands = bandsOf(
    sorted.bodies.map((body) => ({
      end: body.box.bottom,
      start: body.box.top,
    })),
    ROW_GAP * grid.cellHeight
  );
  const rows = matchBands(rowBands, grid.rowCentres);
  const cells: FoundCell[] = [];
  const empty: string[] = [];
  const merged: string[][] = [];
  const extra: PixelBox[] = [];
  for (const band of rows.extra) {
    extra.push(
      ...sorted.bodies
        .filter((body) => within(band, centreOf(body.box).y))
        .map((body) => body.box)
    );
  }
  for (const [row, band] of rows.slots.entries()) {
    const keys = layout.cells
      .slice(row * layout.columns, (row + 1) * layout.columns)
      .map((item) => item.key);
    const bodies = band
      ? sorted.bodies.filter((body) => within(band, centreOf(body.box).y))
      : [];
    const columns = matchBands(
      bandsOf(
        bodies.map((body) => ({ end: body.box.right, start: body.box.left })),
        COLUMN_GAP * grid.cellWidth
      ),
      grid.columnCentres
    );
    const found = sortRow({ bodies, columns, keys, row });
    cells.push(...found.cells);
    empty.push(...found.empty);
    merged.push(...found.merged);
    extra.push(...found.extra);
  }
  return {
    bodyHeight: sorted.bodyHeight,
    cells,
    cleaned: guides.bitmap,
    empty,
    extra,
    guides: guides.removed + sorted.rules,
    labelled,
    labels: sorted.labels,
    merged,
  };
};

/** Bands are matched by centre, so the search also offers the centre of a cell's ink. */
export const cellCentre = (cell: FoundCell) => ({
  x: bandCentre({ end: cell.box.right, start: cell.box.left }),
  y: bandCentre({ end: cell.box.bottom, start: cell.box.top }),
});
