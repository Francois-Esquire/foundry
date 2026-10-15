/**
 * Map offsets in a template's cooked text back to its raw source text. A
 * prompt is parsed cooked, so `\${` is two characters to the parser and
 * three in the file; an editor highlighting from diagnostics needs the raw
 * position. Pure, so a static tool can bundle it.
 */

const HEX_ESCAPE_LENGTH = 4; // \xHH
const UNICODE_ESCAPE_LENGTH = 6; // \uHHHH
const ASTRAL_PLANE = 0x1_00_00;
const UTF16_UNITS_ASTRAL = 2;

/** One raw escape: how many raw characters it spans and how many cooked characters it yields. */
function escapeAt(raw: string, at: number): { cooked: number; width: number } {
  const next = raw.charAt(at + 1);
  if (next === "\n" || next === " " || next === " ") {
    return { cooked: 0, width: 2 };
  }
  if (next === "\r") {
    return { cooked: 0, width: raw.charAt(at + 2) === "\n" ? 3 : 2 };
  }
  if (next === "x") {
    return { cooked: 1, width: HEX_ESCAPE_LENGTH };
  }
  if (next === "u") {
    if (raw.charAt(at + 2) !== "{") {
      return { cooked: 1, width: UNICODE_ESCAPE_LENGTH };
    }
    const close = raw.indexOf("}", at);
    const codepoint = Number.parseInt(raw.slice(at + 3, close), 16);
    return {
      cooked: codepoint >= ASTRAL_PLANE ? UTF16_UNITS_ASTRAL : 1,
      width: close - at + 1,
    };
  }
  return { cooked: 1, width: 2 };
}

/**
 * For one raw chunk of a template, the function from a cooked offset to the
 * raw offset of the same character. The cooked length maps to the raw
 * length, so a span's `end` maps too.
 */
export function cookedToRaw(raw: string): (cooked: number) => number {
  const table: number[] = [];
  let at = 0;
  while (at < raw.length) {
    if (raw.charAt(at) !== "\\") {
      table.push(at);
      at += 1;
      continue;
    }
    const sequence = escapeAt(raw, at);
    for (let unit = 0; unit < sequence.cooked; unit += 1) {
      table.push(at);
    }
    at += sequence.width;
  }
  table.push(raw.length);
  const last = table.length - 1;
  return (cooked) => table[Math.min(Math.max(cooked, 0), last)] ?? raw.length;
}
