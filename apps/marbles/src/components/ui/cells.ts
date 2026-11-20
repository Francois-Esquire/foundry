const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function cellWidth(text: string): number {
  return globalThis.Bun.stringWidth(text);
}

export function cutToCells(text: string, cells: number): string {
  let cut = "";
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    used += cellWidth(segment);
    if (used > cells) {
      break;
    }
    cut += segment;
  }
  return cut;
}
