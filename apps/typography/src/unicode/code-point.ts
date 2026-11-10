/** The written form of a code point: U+0915. */
import { isCodePoint } from "./characters";

const NOTATION = /^(?:u\+|0x)?([0-9a-f]{1,6})$/i;

/** U+ and at least four upper case hex digits, for example U+0915 or U+1F600. */
export const formatCodePoint = (codePoint: number) =>
  `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;

/** Reads U+0915, u+915, 0x915 or 0915. Undefined for anything else. */
export const parseCodePoint = (text: string): number | undefined => {
  const digits = NOTATION.exec(text.trim())?.[1];
  const codePoint = digits ? Number.parseInt(digits, 16) : Number.NaN;
  return isCodePoint(codePoint) ? codePoint : undefined;
};
