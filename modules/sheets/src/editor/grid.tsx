import { type KeyboardEvent, memo, useCallback, useMemo, useRef } from "react";
import { addressOf, type CellPosition, columnName } from "../workbook/address";
import type { CellValue } from "../workbook/value";
import type { WorkbookView } from "./session";

/** The part of a sheet the editor shows. The workbook itself runs to ZZ10000. */
const GRID_ROWS = 100;
const GRID_COLUMNS = 26;

const ROWS = Array.from({ length: GRID_ROWS }, (_, row) => row);
const COLUMNS = Array.from({ length: GRID_COLUMNS }, (_, column) => column);
const ARROWS: Readonly<Record<string, CellPosition>> = {
  ArrowDown: { column: 0, row: 1 },
  ArrowLeft: { column: -1, row: 0 },
  ArrowRight: { column: 1, row: 0 },
  ArrowUp: { column: 0, row: -1 },
};

interface ShownCell {
  readonly kind: CellValue["kind"];
  readonly text: string;
  readonly title?: string;
}

const EMPTY: ShownCell = { kind: "empty", text: "" };

function display(value: CellValue): ShownCell {
  if (value.kind === "empty") {
    return EMPTY;
  }
  if (value.kind === "boolean") {
    return { kind: value.kind, text: value.value ? "TRUE" : "FALSE" };
  }
  if (value.kind === "error") {
    return { kind: value.kind, text: value.value, title: value.message };
  }
  return { kind: value.kind, text: String(value.value) };
}

function clamp(value: number, size: number): number {
  return Math.max(0, Math.min(size - 1, value));
}

interface GridProps {
  /** Start editing the selected cell, optionally replacing it with a typed key. */
  onEdit(initial?: string): void;
  onSelect(position: CellPosition): void;
  selected: CellPosition;
  sheet: string;
  view: WorkbookView;
  writable: boolean;
}

/**
 * The visible cells of one sheet. Values are read once per workbook revision
 * and sheet; moving the selection re-renders only the two cells it touches.
 */
export const Grid = memo(function SheetGrid({
  view,
  sheet,
  selected,
  onSelect,
  onEdit,
  writable,
}: GridProps) {
  const table = useRef<HTMLTableElement>(null);
  const cells = useMemo(
    () =>
      ROWS.map((row) =>
        COLUMNS.map((column) =>
          display(view.value({ cell: addressOf({ column, row }), sheet }))
        )
      ),
    [view, sheet]
  );
  const move = useCallback(
    (from: CellPosition, step: CellPosition) => {
      const next = {
        column: clamp(from.column + step.column, GRID_COLUMNS),
        row: clamp(from.row + step.row, GRID_ROWS),
      };
      table.current
        ?.querySelector<HTMLButtonElement>(`[data-cell="${addressOf(next)}"]`)
        ?.focus();
      onSelect(next);
    },
    [onSelect]
  );
  return (
    <table aria-label="Cells" id="grid" ref={table}>
      <thead>
        <tr>
          <th aria-label="Row" />
          {COLUMNS.map((column) => (
            <th key={column} scope="col">
              {columnName(column)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {ROWS.map((row) => (
          <tr key={row}>
            <th scope="row">{row + 1}</th>
            {COLUMNS.map((column) => (
              <GridCell
                column={column}
                current={row === selected.row && column === selected.column}
                key={column}
                onEdit={onEdit}
                onMove={move}
                onSelect={onSelect}
                row={row}
                shown={cells[row]?.[column] ?? EMPTY}
                writable={writable}
              />
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
});

interface GridCellProps {
  column: number;
  current: boolean;
  onEdit(initial?: string): void;
  onMove(from: CellPosition, step: CellPosition): void;
  onSelect(position: CellPosition): void;
  row: number;
  shown: ShownCell;
  writable: boolean;
}

const GridCell = memo(function Cell({
  column,
  row,
  current,
  shown: { kind, text, title },
  writable,
  onEdit,
  onMove,
  onSelect,
}: GridCellProps) {
  const cell = addressOf({ column, row });
  const select = useCallback(
    () => onSelect({ column, row }),
    [column, row, onSelect]
  );
  const edit = useCallback(() => onEdit(), [onEdit]);
  const key = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      const step = ARROWS[event.key];
      if (step) {
        event.preventDefault();
        onMove({ column, row }, step);
        return;
      }
      if (event.key === "Enter" || event.key === "F2") {
        event.preventDefault();
        onEdit();
        return;
      }
      const typed =
        event.key.length === 1 &&
        !(event.metaKey || event.ctrlKey || event.altKey);
      if (writable && typed) {
        event.preventDefault();
        onEdit(event.key);
      }
    },
    [column, row, writable, onEdit, onMove]
  );
  return (
    <td data-kind={kind}>
      <button
        aria-current={current ? "true" : undefined}
        aria-label={kind === "empty" ? `${cell}, empty` : `${cell}: ${text}`}
        data-cell={cell}
        onClick={select}
        onDoubleClick={edit}
        onKeyDown={key}
        tabIndex={current ? 0 : -1}
        title={title}
        type="button"
      >
        {text}
      </button>
    </td>
  );
});
