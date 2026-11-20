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

export function rasterize(
  canvas: Canvas,
  labels: readonly Label[] = []
): ArtRow[] {
  return Array.from({ length: Math.floor(canvas.length / 2) }, (_, row) => {
    const cells = cellsOf(canvas, row);
    for (const label of labels) {
      if (label.y === row) {
        write(cells, label);
      }
    }
    return { key: `y${row}`, runs: runsOf(cells) };
  });
}
