const HEX_ESCAPE_LENGTH = 4;
const UNICODE_ESCAPE_LENGTH = 6;
const BRACED_UNICODE_OPEN_LENGTH = 3;
const ASTRAL_PLANE = 0x1_00_00;
const UTF16_UNITS_ASTRAL = 2;

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
    const close = raw.indexOf("}", at + BRACED_UNICODE_OPEN_LENGTH);
    if (close === -1) {
      return { cooked: 1, width: 2 };
    }
    const codepoint = Number.parseInt(
      raw.slice(at + BRACED_UNICODE_OPEN_LENGTH, close),
      16
    );
    return {
      cooked: codepoint >= ASTRAL_PLANE ? UTF16_UNITS_ASTRAL : 1,
      width: close - at + 1,
    };
  }
  return { cooked: 1, width: 2 };
}

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
    at += Math.max(sequence.width, 1);
  }
  table.push(raw.length);
  const last = table.length - 1;
  return (cooked) => table[Math.min(Math.max(cooked, 0), last)] ?? raw.length;
}
