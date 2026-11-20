const FIRST = 0x1_fb_00;
const LEFT = 21;
const RIGHT = 42;
const FULL = 63;
const HEX = 16;

interface Encoded {
  readonly bg: string;
  readonly char: string;
  readonly clash: boolean;
  readonly fg: string;
}

export function sextant(pattern: number): string {
  if (pattern <= 0) {
    return " ";
  }
  if (pattern >= FULL) {
    return "█";
  }
  if (pattern === LEFT) {
    return "▌";
  }
  if (pattern === RIGHT) {
    return "▐";
  }
  const skipped = (pattern > LEFT ? 1 : 0) + (pattern > RIGHT ? 1 : 0);
  return String.fromCodePoint(FIRST + pattern - 1 - skipped);
}

function channels(color: string): [number, number, number] {
  return [
    Number.parseInt(color.slice(1, 3), HEX),
    Number.parseInt(color.slice(3, 5), HEX),
    Number.parseInt(color.slice(5, 7), HEX),
  ];
}

function brightness(color: string): number {
  const [red, green, blue] = channels(color);
  return red * 299 + green * 587 + blue * 114;
}

function distance(a: string, b: string): number {
  const [ar, ag, ab] = channels(a);
  const [br, bg, bb] = channels(b);
  return (ar - br) ** 2 + (ag - bg) ** 2 + (ab - bb) ** 2;
}

function ranked(pixels: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const pixel of pixels) {
    counts.set(pixel, (counts.get(pixel) ?? 0) + 1);
  }
  return [...counts.keys()].sort(
    (a, b) =>
      (counts.get(b) ?? 0) - (counts.get(a) ?? 0) ||
      pixels.indexOf(a) - pixels.indexOf(b)
  );
}

function darkerFirst(a: string, b: string): [string, string] {
  const gap = brightness(a) - brightness(b);
  if (gap === 0) {
    return a < b ? [a, b] : [b, a];
  }
  return gap < 0 ? [a, b] : [b, a];
}

export function encodeCell(pixels: readonly string[]): Encoded {
  const [first, second, ...rest] = ranked(pixels);
  if (first === undefined || second === undefined) {
    const only = first ?? "#000000";
    return { bg: only, char: " ", clash: false, fg: only };
  }
  const [bg, fg] = darkerFirst(first, second);
  let pattern = 0;
  for (const [index, pixel] of pixels.entries()) {
    const lit =
      pixel === fg ||
      (pixel !== bg && distance(pixel, fg) < distance(pixel, bg));
    pattern += lit ? 2 ** index : 0;
  }
  return { bg, char: sextant(pattern), clash: rest.length > 0, fg };
}
