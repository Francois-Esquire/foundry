import { WorkbookError } from "./errors";

export const MAX_ROWS = 10_000;
export const MAX_COLUMNS = 702;

const LETTERS = 26;
const A_CODE = 65;
const A1 = /^([A-Z]{1,2})([1-9]\d{0,4})$/;

export interface CellReference {
  readonly cell: string;
  readonly sheet: string;
}

export interface CellPosition {
  readonly column: number;
  readonly row: number;
}

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
