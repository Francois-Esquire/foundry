import "./glyph-cell.css";
import { type CSSProperties, type ReactNode, useCallback } from "react";

interface GlyphGridProps {
  /** The narrowest a cell may get, in pixels. */
  readonly cellWidth?: number;
  /** Glyph cells. */
  readonly children: ReactNode;
  readonly label: string;
}

const cellsOf = (grid: HTMLElement) =>
  Array.from(grid.querySelectorAll<HTMLButtonElement>("button.ty-glyph-cell"));

/** The cell above or below: the nearest one in the same column. */
const inColumn = (
  cells: readonly HTMLButtonElement[],
  from: number,
  direction: -1 | 1
) => {
  const origin = cells[from];
  for (
    let index = from + direction;
    origin && index >= 0 && index < cells.length;
    index += direction
  ) {
    const cell = cells[index];
    if (cell && cell.offsetLeft === origin.offsetLeft) {
      return cell;
    }
  }
};

const cellForKey = (
  cells: readonly HTMLButtonElement[],
  from: number,
  key: string
) => {
  switch (key) {
    case "ArrowRight":
      return cells[from + 1];
    case "ArrowLeft":
      return from > 0 ? cells[from - 1] : undefined;
    case "ArrowDown":
      return inColumn(cells, from, 1);
    case "ArrowUp":
      return inColumn(cells, from, -1);
    case "Home":
      return cells[0];
    case "End":
      return cells.at(-1);
    default:
      return;
  }
};

/**
 * Glyph cells in ruled rows that fill the width. Tab reaches every cell;
 * the arrow keys, Home and End also move between them.
 */
export function GlyphGrid({ cellWidth = 56, children, label }: GlyphGridProps) {
  // One listener on the grid, instead of one per cell, keeps large grids
  // cheap. React runs the returned function when the grid goes away.
  const listen = useCallback((element: HTMLElement | null) => {
    if (!element) {
      return;
    }
    const moveFocus = (event: KeyboardEvent) => {
      const cells = cellsOf(element);
      const from = cells.indexOf(event.target as HTMLButtonElement);
      const target = from < 0 ? undefined : cellForKey(cells, from, event.key);
      if (target) {
        event.preventDefault();
        target.focus();
      }
    };
    element.addEventListener("keydown", moveFocus);
    return () => element.removeEventListener("keydown", moveFocus);
  }, []);

  return (
    <section aria-label={label} className="ty-glyph-grid" ref={listen}>
      <div
        className="ty-glyph-grid-cells"
        style={{ "--ty-glyph-cell-width": `${cellWidth}px` } as CSSProperties}
      >
        {children}
      </div>
    </section>
  );
}
