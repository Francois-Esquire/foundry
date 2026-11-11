/** A number with its noun, plural unless there is exactly one: "1 glyph", "3 glyphs". */
export const count = (amount: number, noun: string) =>
  `${amount} ${noun}${amount === 1 ? "" : "s"}`;
