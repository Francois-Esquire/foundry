/**
 * A number with its noun, plural unless there is exactly one: "1 glyph",
 * "3 glyphs". A noun whose plural is not the noun and an s is given its
 * plural: "2 axes".
 */
export const count = (amount: number, noun: string, plural = `${noun}s`) =>
  `${amount} ${amount === 1 ? noun : plural}`;
