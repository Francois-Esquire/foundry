/**
 * Lays a long list of characters out as headed sections of fixed-height rows,
 * and says which rows are on screen. A script with a hundred thousand
 * characters then costs only the rows that show.
 */

export interface GridSection {
  readonly characters: Uint32Array;
  /** Said beside the title: the range and how much of it the face has. */
  readonly detail: string;
  readonly key: string;
  readonly title: string;
}

export interface GridMetrics {
  /** Cells per row. */
  readonly columns: number;
  /** Space left under each section. */
  readonly gap: number;
  readonly headingHeight: number;
  /** Height of one row of cells. */
  readonly rowHeight: number;
}

interface PlacedSection {
  /** Heading, rows and the gap under them. */
  readonly height: number;
  readonly rows: number;
  readonly section: GridSection;
  /** Distance from the top of the grid to the section's heading. */
  readonly top: number;
}

export interface GridLayout {
  readonly height: number;
  readonly metrics: GridMetrics;
  readonly sections: readonly PlacedSection[];
}

/** How many cells of at least `cellWidth` fit side by side. Never fewer than one. */
export const columnsFor = (width: number, cellWidth: number) =>
  Math.max(1, Math.floor(width / cellWidth));

export const layoutGrid = (
  sections: readonly GridSection[],
  metrics: GridMetrics
): GridLayout => {
  const placed: PlacedSection[] = [];
  let top = 0;
  for (const section of sections) {
    const rows = Math.ceil(section.characters.length / metrics.columns);
    const height =
      metrics.headingHeight + rows * metrics.rowHeight + metrics.gap;
    placed.push({ height, rows, section, top });
    top += height;
  }
  return { height: top, metrics, sections: placed };
};

/** The rows of one section to render: `firstRow` up to, not including, `endRow`. */
export interface SectionWindow {
  readonly characters: Uint32Array;
  readonly endRow: number;
  readonly firstRow: number;
  readonly placed: PlacedSection;
}

/**
 * The sections that cross the viewport, each with its rows on screen and
 * `overscan` more rows above and below, so the keyboard always finds a
 * neighbouring row to move to.
 */
export const visibleWindows = (
  layout: GridLayout,
  scrollTop: number,
  viewportHeight: number,
  overscan: number
): SectionWindow[] => {
  const { columns, headingHeight, rowHeight } = layout.metrics;
  const margin = overscan * rowHeight;
  const from = scrollTop - margin;
  const to = scrollTop + viewportHeight + margin;
  const windows: SectionWindow[] = [];
  for (const placed of layout.sections) {
    if (placed.top + placed.height <= from) {
      continue;
    }
    if (placed.top >= to) {
      break;
    }
    const rowsTop = placed.top + headingHeight;
    const firstRow = Math.min(
      placed.rows,
      Math.max(0, Math.floor((from - rowsTop) / rowHeight))
    );
    const endRow = Math.min(
      placed.rows,
      Math.max(firstRow, Math.ceil((to - rowsTop) / rowHeight))
    );
    windows.push({
      characters: placed.section.characters.subarray(
        firstRow * columns,
        endRow * columns
      ),
      endRow,
      firstRow,
      placed,
    });
  }
  return windows;
};

/** Where the row holding a character starts, or undefined when it is not in the grid. */
export const offsetOfCharacter = (
  layout: GridLayout,
  codePoint: number
): number | undefined => {
  const { columns, headingHeight, rowHeight } = layout.metrics;
  for (const placed of layout.sections) {
    const index = placed.section.characters.indexOf(codePoint);
    if (index !== -1) {
      return (
        placed.top + headingHeight + Math.floor(index / columns) * rowHeight
      );
    }
  }
};
