import { type Canvas, stamp } from "@/model/pixels";

const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  "0": ["#####", "## ##", "## ##", "## ##", "#####"],
  "1": ["##", "##", "##", "##", "##"],
  "2": ["#####", "   ##", "#####", "##   ", "#####"],
  "3": ["#####", "   ##", " ####", "   ##", "#####"],
  "4": ["## ##", "## ##", "#####", "   ##", "   ##"],
  "5": ["#####", "##   ", "#####", "   ##", "#####"],
  "6": ["#####", "##   ", "#####", "## ##", "#####"],
  "7": ["#####", "## ##", "   ##", "   ##", "   ##"],
  "8": ["#####", "## ##", "#####", "## ##", "#####"],
  "9": ["#####", "## ##", "#####", "   ##", "#####"],
};

const GAP = 1;

function glyphsOf(text: string): (readonly string[])[] {
  return [...text].flatMap((char) => {
    const glyph = GLYPHS[char];
    return glyph ? [glyph] : [];
  });
}

export function numeralWidth(text: string): number {
  const glyphs = glyphsOf(text);
  return (
    glyphs.reduce((sum, glyph) => sum + (glyph[0]?.length ?? 0), 0) +
    Math.max(glyphs.length - 1, 0) * GAP
  );
}

export function drawNumerals(
  canvas: Canvas,
  at: { readonly x: number; readonly y: number },
  text: string,
  ramp: readonly string[],
  ghost: string
) {
  let offset = 0;
  for (const glyph of glyphsOf(text)) {
    const reach = glyph[0]?.length ?? 0;
    const x = at.x + offset;
    stamp(canvas, x, at.y, (reach === 2 ? GLYPHS["1"] : GLYPHS["8"]) ?? glyph, {
      "#": ghost,
    });
    for (const [row, line] of glyph.entries()) {
      stamp(canvas, x, at.y + row, [line], {
        "#": ramp[Math.min(row, ramp.length - 1)] ?? ghost,
      });
    }
    offset += reach + GAP;
  }
}

const TALL: Readonly<Record<string, readonly string[]>> = {
  "0": [
    ".####.",
    "######",
    "##..##",
    "##..##",
    "##..##",
    "##..##",
    "##..##",
    "######",
    ".####.",
  ],
  "1": [
    "..##..",
    ".###..",
    "####..",
    "..##..",
    "..##..",
    "..##..",
    "..##..",
    "######",
    "######",
  ],
  "2": [
    ".####.",
    "######",
    "##..##",
    "....##",
    "...##.",
    "..##..",
    ".##...",
    "######",
    "######",
  ],
  "3": [
    "#####.",
    "######",
    "....##",
    "....##",
    ".####.",
    "....##",
    "....##",
    "######",
    "#####.",
  ],
  "4": [
    "##..##",
    "##..##",
    "##..##",
    "##..##",
    "######",
    "######",
    "....##",
    "....##",
    "....##",
  ],
  "5": [
    "######",
    "######",
    "##....",
    "#####.",
    "######",
    "....##",
    "....##",
    "######",
    "#####.",
  ],
  "6": [
    ".####.",
    "######",
    "##....",
    "#####.",
    "######",
    "##..##",
    "##..##",
    "######",
    ".####.",
  ],
  "7": [
    "######",
    "######",
    "....##",
    "....##",
    "...##.",
    "...##.",
    "..##..",
    "..##..",
    "..##..",
  ],
  "8": [
    ".####.",
    "######",
    "##..##",
    "##..##",
    ".####.",
    "##..##",
    "##..##",
    "######",
    ".####.",
  ],
  "9": [
    ".####.",
    "######",
    "##..##",
    "##..##",
    "######",
    ".#####",
    "....##",
    "######",
    ".####.",
  ],
};

export const TALL_WIDTH = 6;

export function tallNumerals(text: string): (readonly string[])[] {
  return [...text].flatMap((char) => {
    const glyph = TALL[char];
    return glyph ? [glyph] : [];
  });
}
