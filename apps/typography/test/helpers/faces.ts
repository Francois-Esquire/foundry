import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import type { OpenFace } from "~/typeface/reading";
import { type FONTS, fontBytes } from "./fixtures";

const faces = new Map<string, OpenFace>();

/** An opened fixture face, shared by the tests of one file. */
export const fixtureFace = (name: keyof typeof FONTS): OpenFace => {
  const known = faces.get(name);
  if (known) {
    return known;
  }
  const face = harfBuzzReader.open(fontBytes(name));
  faces.set(name, face);
  return face;
};
