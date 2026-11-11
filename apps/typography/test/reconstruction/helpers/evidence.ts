import { readFileSync } from "node:fs";
import path from "node:path";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { nodeImageCodec } from "~/generation/node-image-codec";
import {
  type Evidence,
  importEvidence,
  mediaTypeFor,
} from "~/reconstruction/evidence/evidence";
import type { ReferenceFace } from "~/reconstruction/recognition/face-recognizer";
import type { OpenFace } from "~/typeface/reading";
import { type FONTS, fontBytes } from "../../helpers/fixtures";

const EVIDENCE_DIR = path.join(import.meta.dirname, "../../fixtures/evidence");

/** The evidence photographs. See test/fixtures/evidence/README.md. */
export const PHOTOGRAPHS = {
  copper: "ozark-copper-letters.jpg",
  handwriting: "handwriting-defg.jpg",
  storefront: "storefront-needed-things.jpg",
} as const;

export const evidenceBytes = (name: keyof typeof PHOTOGRAPHS) =>
  new Uint8Array(readFileSync(path.join(EVIDENCE_DIR, PHOTOGRAPHS[name])));

export const photograph = (name: keyof typeof PHOTOGRAPHS): Promise<Evidence> =>
  importEvidence(
    {
      bytes: evidenceBytes(name),
      fileName: PHOTOGRAPHS[name],
      mediaType: mediaTypeFor(PHOTOGRAPHS[name]),
    },
    nodeImageCodec
  );

const faces = new Map<string, OpenFace>();

export const fixtureFace = (name: keyof typeof FONTS): OpenFace => {
  const known = faces.get(name);
  if (known) {
    return known;
  }
  const face = harfBuzzReader.open(fontBytes(name));
  faces.set(name, face);
  return face;
};

/**
 * The Latin fixture faces as references. Sofia Sans is variable, so it
 * stands in twice: at its regular weight and at its heaviest but one.
 */
export const REFERENCES = {
  david: (): ReferenceFace => ({
    face: fixtureFace("hebrew"),
    id: "david-libre",
    name: "David Libre Regular",
  }),
  lato: (): ReferenceFace => ({
    face: fixtureFace("lato"),
    id: "lato",
    name: "Lato Regular",
  }),
  sofia: (): ReferenceFace => ({
    face: fixtureFace("sofia"),
    id: "sofia-sans-400",
    location: { wght: 400 },
    name: "Sofia Sans at weight 400",
  }),
  sofiaBlack: (): ReferenceFace => ({
    face: fixtureFace("sofia"),
    id: "sofia-sans-900",
    location: { wght: 900 },
    name: "Sofia Sans at weight 900",
  }),
  sourceCode: (): ReferenceFace => ({
    face: fixtureFace("postscript"),
    id: "source-code-pro",
    name: "Source Code Pro Regular",
  }),
};

export const codePoints = (text: string): number[] =>
  [...text].map((character) => character.codePointAt(0) ?? 0);

/**
 * The characters every recognition test here considers: the Latin capitals,
 * small letters and figures. An accuracy means nothing without this list.
 */
export const CANDIDATE_CHARACTERS = codePoints(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
);

export const lettersOf = (readings: readonly { character?: number }[]) =>
  readings
    .map(({ character }) =>
      character === undefined ? "?" : String.fromCodePoint(character)
    )
    .join("");
