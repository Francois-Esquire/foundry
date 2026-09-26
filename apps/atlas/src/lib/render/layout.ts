import { displayWidth, padDisplay } from "./width";

/** Width tiers; the only place a renderer compares against a column count. */
export const WIDTH = { narrow: 70, wide: 110 } as const;

export type WidthTier = "narrow" | "normal" | "wide";

export function widthTier(width: number): WidthTier {
  if (width < WIDTH.narrow) {
    return "narrow";
  }
  if (width >= WIDTH.wide) {
    return "wide";
  }
  return "normal";
}

const BAR_CELLS: Record<WidthTier, number> = {
  narrow: 12,
  normal: 20,
  wide: 30,
};

export function barCells(width: number): number {
  return BAR_CELLS[widthTier(width)];
}

/** Widest label before truncation. */
export function labelCells(width: number): number {
  return Math.max(16, Math.floor(width * 0.4));
}

/** Prose width inside a section: the section indent plus the summary indent. */
export function wrapCells(width: number): number {
  return Math.max(24, width - 4);
}

/** Aligns values two columns past the widest label. */
export function labelValueLines(
  rows: readonly { label: string; value: string }[]
): string[] {
  const width = Math.max(0, ...rows.map((row) => displayWidth(row.label)));
  return rows.map((row) => `${padDisplay(row.label, width)}  ${row.value}`);
}

/**
 * Greedy wrap. Breaks at ` · ` separators first so a metric never splits;
 * a run with no separators that still overflows breaks on spaces.
 */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  const push = (piece: string, joiner: string) => {
    if (current === "") {
      current = piece;
    } else if (displayWidth(`${current}${joiner}${piece}`) <= width) {
      current = `${current}${joiner}${piece}`;
    } else {
      lines.push(current);
      current = piece;
    }
  };
  const flush = () => {
    if (current !== "") {
      lines.push(current);
    }
    current = "";
  };
  for (const part of text.split(" · ")) {
    if (displayWidth(part) <= width) {
      push(part, " · ");
      continue;
    }
    flush();
    for (const word of part.split(" ")) {
      push(word, " ");
    }
    flush();
  }
  flush();
  return lines;
}

export function indent(lines: readonly string[], depth = 2): string[] {
  const pad = " ".repeat(depth);
  return lines.map((line) => (line === "" ? "" : `${pad}${line}`));
}
