import { readFileSync } from "node:fs";
import path from "node:path";
import type { FaceDescription } from "~/typeface/face";
import type { Outline } from "~/typeface/outline";

const FONTS_DIR = path.join(import.meta.dirname, "../fixtures/fonts");

/** Fixture fonts. Each is under the SIL Open Font License; see test/fixtures/fonts. */
export const FONTS = {
  /** Variable weight and width, Devanagari with conjuncts. */
  devanagari: "NotoSansDevanagari-wdth-wght.ttf",
  /** Static Latin with ligatures and kerning, 3023 glyphs. */
  lato: "Lato-Regular.ttf",
  /** Variable weight axis, Latin, Greek and Cyrillic. */
  sofia: "SofiaSans-wght.ttf",
} as const;

export const fontBytes = (name: keyof typeof FONTS) =>
  new Uint8Array(readFileSync(path.join(FONTS_DIR, FONTS[name])));

export const describeFace = (
  overrides: Partial<FaceDescription> = {}
): FaceDescription => ({
  axes: [],
  characterCount: 90,
  familyName: "Specimen",
  fullName: "Specimen Regular",
  glyphCount: 100,
  instances: [],
  italic: false,
  layout: { positioning: [], scripts: [], substitution: [] },
  licence: { embedding: 0 },
  metrics: { ascender: 800, descender: -200, lineGap: 0, unitsPerEm: 1000 },
  outlineFormat: "truetype",
  postScriptName: "Specimen-Regular",
  styleName: "Regular",
  weightClass: 400,
  widthClass: 5,
  ...overrides,
});

/** A clockwise triangle, 800 units wide and 700 tall. */
export const TRIANGLE: Outline = {
  contours: [
    {
      segments: [
        { kind: "line", to: { x: 500, y: 700 } },
        { kind: "line", to: { x: 900, y: 0 } },
      ],
      start: { x: 100, y: 0 },
    },
  ],
};
