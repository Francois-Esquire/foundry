import { Color } from "three";

const inkColours = new Map<string, Color>();

/** A ladder ink as a linear colour, kept by its text; the renderer encodes it back to sRGB. */
export function inkColour(ink: string): Color {
  let colour = inkColours.get(ink);
  if (!colour) {
    colour = new Color(ink);
    inkColours.set(ink, colour);
  }
  return colour;
}
