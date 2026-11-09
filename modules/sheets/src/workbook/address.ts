import { WorkbookError } from "./errors";

/** The largest grid a sheet may use: rows 1 to 10000, columns A to ZZ. */
export const MAX_ROWS = 10_000;
export const MAX_COLUMNS = 702;

const LETTERS = 26;
const A_CODE = 65;
const A1 = /^([A-Z]{1,2})([1-9]\d{0,4})$/;

/** A cell on a named sheet, by its A1 address, such as `{ sheet: "Inputs", cell: "B2" }`. */
export interface CellReference {
  readonly cell: string;
  readonly sheet: string;
}

/** A cell's position on its sheet, zero-based, as the engine counts. */
export interface CellPosition {
  readonly column: number;
  readonly row: number;
}

/** The column letters of a zero-based column: 0 is A, 26 is AA. */
export function columnName(column: number): string {
  let name = "";
  for (
    let rest = column + 1;
    rest > 0;
    rest = Math.floor((rest - 1) / LETTERS)
  ) {
    name = String.fromCharCode(A_CODE + ((rest - 1) % LETTERS)) + name;
  }
  return name;
}

function columnIndex(letters: string): number {
  let index = 0;
  for (const letter of letters) {
    index = index * LETTERS + (letter.charCodeAt(0) - A_CODE + 1);
  }
  return index - 1;
}

/** The position an A1 address names, such as `B3`; refuses one off the grid. */
export function positionOf(address: string): CellPosition {
  const [, letters, digits] = A1.exec(address) ?? [];
  const position =
    letters && digits
      ? { column: columnIndex(letters), row: Number(digits) - 1 }
      : null;
  if (!position || position.row >= MAX_ROWS || position.column >= MAX_COLUMNS) {
    throw new WorkbookError(
      `${address} is not a cell between A1 and ${addressOf({ column: MAX_COLUMNS - 1, row: MAX_ROWS - 1 })}`,
      { code: "invalid-address" }
    );
  }
  return position;
}

export function addressOf({ column, row }: CellPosition): string {
  return `${columnName(column)}${String(row + 1)}`;
}
