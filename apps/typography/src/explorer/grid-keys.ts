/**
 * Arrow keys at the edge of one section of the grid carry on into the next.
 * Inside a section the glyph grid moves focus itself; this only answers the
 * moves it cannot make.
 */

/** Where a cell sits on the page. Only equality and order matter. */
export interface CellPlace {
  readonly left: number;
  readonly top: number;
}

export interface CellAddress {
  readonly cell: number;
  readonly section: number;
}

/** The cell of a row that sits in a column, or the row's last cell when it is shorter. */
const inColumn = (
  cells: readonly CellPlace[],
  top: number | undefined,
  left: number
) => {
  let last = -1;
  for (const [index, cell] of cells.entries()) {
    if (cell.top === top) {
      last = index;
      if (cell.left === left) {
        return index;
      }
    }
  }
  return last;
};

/**
 * The cell an arrow key moves to when it leaves its section. Undefined when
 * the move stays inside the section or there is no section to move into.
 */
export const crossSectionTarget = (
  sections: readonly (readonly CellPlace[])[],
  from: CellAddress,
  key: string
): CellAddress | undefined => {
  const cells = sections[from.section] ?? [];
  const origin = cells[from.cell];
  if (!origin) {
    return;
  }
  const forward = key === "ArrowDown" || key === "ArrowRight";
  const section = from.section + (forward ? 1 : -1);
  const target = sections[section];
  if (!target || target.length === 0) {
    return;
  }
  const leaves: Readonly<Record<string, boolean>> = {
    ArrowDown: origin.top === cells.at(-1)?.top,
    ArrowLeft: from.cell === 0,
    ArrowRight: from.cell === cells.length - 1,
    ArrowUp: origin.top === cells[0]?.top,
  };
  if (!leaves[key]) {
    return;
  }
  if (key === "ArrowRight") {
    return { cell: 0, section };
  }
  if (key === "ArrowLeft") {
    return { cell: target.length - 1, section };
  }
  const row = key === "ArrowDown" ? target[0]?.top : target.at(-1)?.top;
  return { cell: inColumn(target, row, origin.left), section };
};
