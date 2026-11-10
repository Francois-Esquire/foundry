/**
 * Asks the browser itself whether it accepts a font. Loading a FontFace from
 * bytes runs the browser's font sanitizer, which is stricter than the tools
 * that built the font and shares no code with them.
 *
 * A variable font needs its range in the descriptors, for example
 * { weight: "300 800" }. Without it the browser takes the face for weight 400
 * and draws every other weight by faking it.
 */
export const loadInBrowser = (
  font: Uint8Array,
  family = "Derived font check",
  descriptors?: FontFaceDescriptors
): Promise<FontFace> =>
  // A copy, because the browser may keep the buffer it is given.
  new FontFace(family, font.slice().buffer, descriptors).load();
