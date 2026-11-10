/** A code point as printed under a glyph: at least four capital hex digits. */
export const codePointDigits = (codePoint: number) =>
  codePoint.toString(16).toUpperCase().padStart(4, "0");

/** A code point as written in running text: U+0041. */
export const codePointName = (codePoint: number) =>
  `U+${codePointDigits(codePoint)}`;
