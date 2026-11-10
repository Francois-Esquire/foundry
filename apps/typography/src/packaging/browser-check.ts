/**
 * Asks the browser itself whether it accepts a font. Loading a FontFace from
 * bytes runs the browser's font sanitizer, which is stricter than the tools
 * that built the font and shares no code with them.
 */
export const loadInBrowser = (
  font: Uint8Array,
  family = "Derived font check"
): Promise<FontFace> =>
  // A copy, because the browser may keep the buffer it is given.
  new FontFace(family, font.slice().buffer).load();
