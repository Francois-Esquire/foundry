/**
 * Expands a CLDR exemplar set such as "[a-c é {ch} \\u200C]" into the code
 * points it names. A multi-character string contributes each of its code
 * points, because a face needs every one of them to set that string.
 */

export class ExemplarSyntaxError extends Error {
  override readonly name = "ExemplarSyntaxError";
}

const HEX = /^[0-9A-Fa-f]+$/;
const PATTERN_SPACE = /\s/;
const UNSUPPORTED = new Set(["[", "]", "^", "&", "$"]);
const UNSUPPORTED_ESCAPES = new Set(["p", "P", "N"]);

interface Cursor {
  index: number;
  readonly symbols: readonly string[];
}

const hexValue = (digits: string, pattern: string): number => {
  const value = HEX.test(digits) ? Number.parseInt(digits, 16) : Number.NaN;
  if (!(value <= 0x10_ff_ff)) {
    throw new ExemplarSyntaxError(`Bad escape \\${digits} in ${pattern}`);
  }
  return value;
};

const take = (cursor: Cursor, count: number) => {
  const taken = cursor.symbols
    .slice(cursor.index, cursor.index + count)
    .join("");
  cursor.index += count;
  return taken;
};

const takeBraced = (cursor: Cursor, pattern: string) => {
  const close = cursor.symbols.indexOf("}", cursor.index);
  if (cursor.symbols[cursor.index] !== "{" || close === -1) {
    throw new ExemplarSyntaxError(`Unclosed escape in ${pattern}`);
  }
  const digits = cursor.symbols.slice(cursor.index + 1, close).join("");
  cursor.index = close + 1;
  return digits;
};

/** Reads the escape after a backslash and returns the code point it stands for. */
const readEscape = (cursor: Cursor, pattern: string): number => {
  const symbol = take(cursor, 1);
  if (symbol === "" || UNSUPPORTED_ESCAPES.has(symbol)) {
    throw new ExemplarSyntaxError(
      `Unsupported escape \\${symbol} in ${pattern}`
    );
  }
  if (symbol === "u") {
    return hexValue(take(cursor, 4), pattern);
  }
  if (symbol === "U") {
    return hexValue(take(cursor, 8), pattern);
  }
  if (symbol === "x") {
    return hexValue(
      cursor.symbols[cursor.index] === "{"
        ? takeBraced(cursor, pattern)
        : take(cursor, 2),
      pattern
    );
  }
  return symbol.codePointAt(0) ?? 0;
};

/** Reads one character, escaped or literal. */
const readCharacter = (cursor: Cursor, pattern: string): number => {
  const symbol = take(cursor, 1);
  if (symbol === "\\") {
    return readEscape(cursor, pattern);
  }
  return symbol.codePointAt(0) ?? 0;
};

const readString = (cursor: Cursor, pattern: string): number[] => {
  const codePoints: number[] = [];
  while (cursor.symbols[cursor.index] !== "}") {
    if (cursor.index >= cursor.symbols.length) {
      throw new ExemplarSyntaxError(`Unclosed string in ${pattern}`);
    }
    if (!PATTERN_SPACE.test(cursor.symbols[cursor.index] ?? "")) {
      codePoints.push(readCharacter(cursor, pattern));
      continue;
    }
    cursor.index += 1;
  }
  cursor.index += 1;
  return codePoints;
};

const isRangeDash = (cursor: Cursor, previous: number | undefined) =>
  previous !== undefined &&
  cursor.symbols[cursor.index] === "-" &&
  cursor.index + 1 < cursor.symbols.length;

/** The distinct code points of an exemplar set, ascending. */
export const expandExemplarSet = (pattern: string): number[] => {
  const trimmed = pattern.trim();
  if (!(trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    throw new ExemplarSyntaxError(`Not a bracketed set: ${pattern}`);
  }
  const cursor: Cursor = { index: 0, symbols: [...trimmed.slice(1, -1)] };
  const found = new Set<number>();
  // The last single character read, which a following dash turns into a range.
  let previous: number | undefined;
  while (cursor.index < cursor.symbols.length) {
    const symbol = cursor.symbols[cursor.index] ?? "";
    if (PATTERN_SPACE.test(symbol)) {
      cursor.index += 1;
    } else if (symbol === "{") {
      cursor.index += 1;
      for (const codePoint of readString(cursor, pattern)) {
        found.add(codePoint);
      }
      previous = undefined;
    } else if (isRangeDash(cursor, previous)) {
      cursor.index += 1;
      const last = readCharacter(cursor, pattern);
      for (
        let codePoint = previous ?? last;
        codePoint <= last;
        codePoint += 1
      ) {
        found.add(codePoint);
      }
      previous = undefined;
    } else if (UNSUPPORTED.has(symbol)) {
      throw new ExemplarSyntaxError(
        `Unsupported syntax ${symbol} in ${pattern}`
      );
    } else {
      previous = readCharacter(cursor, pattern);
      found.add(previous);
    }
  }
  return [...found].sort((a, b) => a - b);
};
