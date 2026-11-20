import { encodeCell } from "@/model/sextants";

export type Canvas = string[][];

export interface Label {
  readonly bg: string;
  readonly bold?: boolean;
  readonly fg: string;
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

interface Run {
  readonly bg: string;
  readonly bold: boolean;
  readonly fg: string;
  readonly key: string;
  readonly text: string;
}

export interface ArtRow {
  readonly key: string;
  readonly runs: readonly Run[];
}

interface Cell {
  readonly bg: string;
  readonly bold: boolean;
  readonly char: string;
  readonly fg: string;
}

const UPPER_HALF = "▀";

export type Detail = "coarse" | "fine";

export function createCanvas(
  width: number,
  rows: number,
  color: (x: number, y: number) => string
): Canvas {
  return Array.from({ length: rows * 2 }, (_, y) =>
    Array.from({ length: width }, (__, x) => color(x, y))
  );
}

function span(start: number, count: number): number[] {
  return Array.from({ length: Math.max(count, 0) }, (_, step) => start + step);
}

function plot(canvas: Canvas, x: number, y: number, color: string) {
  const row = canvas[y];
  if (row && x >= 0 && x < row.length) {
    row[x] = color;
  }
}

export function fill(
  canvas: Canvas,
  area: {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  },
  color: string | ((x: number, y: number) => string)
) {
  for (const y of span(area.y, area.height)) {
    for (const x of span(area.x, area.width)) {
      plot(canvas, x, y, typeof color === "string" ? color : color(x, y));
    }
  }
}

export function stamp(
  canvas: Canvas,
  x: number,
  y: number,
  sprite: readonly string[],
  inks: Readonly<Record<string, string>>
) {
  for (const [dy, line] of sprite.entries()) {
    for (const [dx, mark] of [...line].entries()) {
      const ink = inks[mark];
      if (ink) {
        plot(canvas, x + dx, y + dy, ink);
      }
    }
  }
}

export function etch(
  canvas: Canvas,
  area: {
    readonly height?: number;
    readonly width?: number;
    readonly x: number;
    readonly y: number;
  },
  mark: string,
  fg: string
): Label[] {
  const labels: Label[] = [];
  for (const y of span(area.y, area.height ?? 1)) {
    for (const x of span(area.x, area.width ?? 1)) {
      const bg = canvas[y * 2]?.[x];
      if (bg) {
        labels.push({ bg, fg, text: mark, x, y });
      }
    }
  }
  return labels;
}

function cellsOf(canvas: Canvas, row: number): Cell[] {
  const upper = canvas[row * 2] ?? [];
  const lower = canvas[row * 2 + 1] ?? [];
  return upper.map((top, x) => {
    const bottom = lower[x] ?? top;
    return top === bottom
      ? { bg: top, bold: false, char: " ", fg: top }
      : { bg: bottom, bold: false, char: UPPER_HALF, fg: top };
  });
}

function fineCells(canvas: Canvas, row: number): Cell[] {
  const lines = [0, 1, 2].map((line) => canvas[row * 3 + line] ?? []);
  return Array.from(
    { length: Math.floor((lines[0]?.length ?? 0) / 2) },
    (_, x) => {
      const { bg, char, fg } = encodeCell(pixelsAt(lines, x));
      return { bg, bold: false, char, fg };
    }
  );
}

function pixelsAt(lines: readonly string[][], x: number): string[] {
  return lines.flatMap((line) => [line[x * 2] ?? "", line[x * 2 + 1] ?? ""]);
}

function write(cells: Cell[], label: Label) {
  for (const [offset, char] of [...label.text].entries()) {
    const x = label.x + offset;
    if (x >= 0 && x < cells.length) {
      cells[x] = {
        bg: label.bg,
        bold: label.bold ?? false,
        char,
        fg: label.fg,
      };
    }
  }
}

function runsOf(cells: readonly Cell[]): Run[] {
  const runs: Run[] = [];
  for (const [x, cell] of cells.entries()) {
    const last = runs.at(-1);
    const blank = cell.char === " ";
    if (
      last &&
      last.bg === cell.bg &&
      last.bold === cell.bold &&
      (blank || last.fg === cell.fg || last.text.trim() === "")
    ) {
      runs[runs.length - 1] = {
        ...last,
        fg: blank ? last.fg : cell.fg,
        text: last.text + cell.char,
      };
    } else {
      runs.push({
        bg: cell.bg,
        bold: cell.bold,
        fg: cell.fg,
        key: `x${x}`,
        text: cell.char,
      });
    }
  }
  return runs;
}

function rowsOf(
  count: number,
  cellsAt: (row: number) => Cell[],
  labels: readonly Label[]
): ArtRow[] {
  return Array.from({ length: count }, (_, row) => {
    const cells = cellsAt(row);
    for (const label of labels) {
      if (label.y === row) {
        write(cells, label);
      }
    }
    return { key: `y${row}`, runs: runsOf(cells) };
  });
}

export function rasterize(
  canvas: Canvas,
  labels: readonly Label[] = []
): ArtRow[] {
  return rowsOf(
    Math.floor(canvas.length / 2),
    (row) => cellsOf(canvas, row),
    labels
  );
}

export function createFineCanvas(
  width: number,
  rows: number,
  color: string
): Canvas {
  return Array.from({ length: rows * 3 }, () =>
    Array.from({ length: width * 2 }, () => color)
  );
}

export function rasterizeFine(
  canvas: Canvas,
  labels: readonly Label[] = []
): ArtRow[] {
  return rowsOf(
    Math.floor(canvas.length / 3),
    (row) => fineCells(canvas, row),
    labels
  );
}

export function clashes(canvas: Canvas): number {
  let count = 0;
  for (const row of span(0, Math.floor(canvas.length / 3))) {
    const lines = [0, 1, 2].map((line) => canvas[row * 3 + line] ?? []);
    for (const x of span(0, Math.floor((lines[0]?.length ?? 0) / 2))) {
      count += encodeCell(pixelsAt(lines, x)).clash ? 1 : 0;
    }
  }
  return count;
}
