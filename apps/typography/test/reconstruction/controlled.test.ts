/**
 * Controlled images: lines of text set from a fixture font, then degraded
 * the way a photograph is. The truth is known exactly, so recognition and
 * outline fit can be scored against it.
 */
import { describe, expect, it } from "vitest";
import { shapeAgreement } from "~/generation/evaluation/agreement";
import { median } from "~/generation/style/measure";
import { rectangleRegion } from "~/reconstruction/evidence/region";
import {
  createFaceRecognizer,
  type ReferenceFace,
} from "~/reconstruction/recognition/face-recognizer";
import { reconstruct } from "~/reconstruction/reconstruct";
import { outlineBounds } from "~/typeface/outline";
import { fixtureFace } from "../helpers/faces";
import {
  CANDIDATE_CHARACTERS,
  lettersOf,
  REFERENCES,
} from "./helpers/evidence";
import { degrade, setLettering, syntheticEvidence } from "./helpers/lettering";

const LINES = ["HANDGLOVES", "Quick Brown Fox", "jumps over 2 lazy dogs"];
const LETTERS = LINES.map((line) => line.replaceAll(" ", ""));
const LETTER_COUNT = 41;

const face = fixtureFace("lato");
const lettering = setLettering(
  LINES.map((text) => ({ emSize: 150, face, text }))
);
// Soft, grainy and tinted: a blur of 1.2 pixels, noise of 12 levels on every
// channel, dark blue on cream. Strokes are about 10 pixels thick.
const picture = degrade(lettering.ink, {
  blur: 1.2,
  ground: [236, 224, 196],
  ink: [38, 52, 110],
  noise: 12,
  seed: 7,
});
const evidence = syntheticEvidence(picture, "lato-three-lines");
const region = rectangleRegion(0, 0, picture.width, picture.height);

const mistakesIn = (read: readonly string[]) =>
  LETTERS.join("")
    .split("")
    .filter((letter, index) => read.join("")[index] !== letter).length;

const readWith = (references: readonly ReferenceFace[]) => {
  const recognizer = createFaceRecognizer(references, CANDIDATE_CHARACTERS);
  const result = reconstruct({
    evidence,
    recognizer,
    region,
    target: { faceId: "target" },
  });
  const read = LETTERS.map((_, line) =>
    lettersOf(result.readings.filter((reading) => reading.line === line))
  );
  const right = LETTERS.join("")
    .split("")
    .filter((letter, index) => read.join("")[index] === letter).length;
  return {
    nearest: recognizer.nearestFaces(result.isolation.lines, result.readings),
    read,
    result,
    right,
  };
};

describe("lettering set from Lato, blurred, grainy and tinted", () => {
  it("is isolated whole: every letter, on the right line, on the right baseline", () => {
    const { result } = readWith([REFERENCES.lato()]);
    const { lines } = result.isolation;
    expect(lines.map((line) => line.letters.length)).toEqual([10, 13, 18]);
    expect(lines.map((line) => line.body)).toEqual([
      "cap-height",
      "x-height",
      "x-height",
    ]);
    for (const [index, line] of lines.entries()) {
      expect(
        Math.abs(line.baseline - (lettering.baselines[index] ?? 0))
      ).toBeLessThanOrEqual(1.5);
    }
    expect(result.isolation.separation.lettering).toBe("darker");
  });

  it("is read without a mistake when its own face is among the references", () => {
    // Measured: 41 of 41. This is partly the face recognising itself, so it
    // is the ceiling of the method, not its accuracy on unknown lettering.
    const { nearest, read, right } = readWith([
      REFERENCES.lato(),
      REFERENCES.sourceCode(),
      REFERENCES.david(),
    ]);
    expect(read).toEqual(LETTERS);
    expect(right).toBe(LETTER_COUNT);
    expect(nearest[0]?.reference).toBe("lato");
    // Measured 0.90 for Lato against 0.68 for the next face: its own glyphs
    // after blur and grain. The stretch found is none.
    expect(nearest[0]?.agreement).toBeGreaterThan(0.85);
    expect(nearest[0]?.widthFactors).toEqual([1, 1, 1]);
    expect(nearest[1]?.agreement).toBeLessThan(0.75);
  });

  it("is read with its own face held out, less well", () => {
    // Measured: 39 of 41 (95%), read as HANDGLOVE5, QuickBroWnFox,
    // jumpsover2lazydogs. The two mistakes are S taken for 5 and a small w
    // taken for a capital, both against Sofia Sans, another humanist sans.
    // Which two letters fall depends on the grain: with another seed it was
    // S and Q. So the count is asserted, not the letters. The threshold is
    // 90%: five mistakes in 41 fail it. With reference faces of the same
    // kind this is the number to expect, and it falls quickly when the
    // references are of another kind, as the storefront test shows.
    const { nearest, read, right } = readWith([
      REFERENCES.sofia(),
      REFERENCES.sourceCode(),
      REFERENCES.david(),
    ]);
    expect(right / LETTER_COUNT).toBeGreaterThanOrEqual(0.9);
    expect(mistakesIn(read)).toBeLessThanOrEqual(4);
    expect(nearest[0]?.reference).toBe("sofia-sans-400");
  });

  describe("recovered outlines against the glyphs they were set from", () => {
    const { ascender, descender, unitsPerEm } = face.description.metrics;
    const topOf = (letter: string) =>
      outlineBounds(
        face.glyph(face.glyphForCharacter(letter.codePointAt(0) ?? 0) ?? 0)
          .outline
      )?.yMax ?? 0;
    // The line heights are mapped to Lato's own, so the recovered outlines
    // and Lato's glyphs are in the same units and can be laid over each other.
    const { recovered } = reconstruct({
      evidence,
      metrics: {
        ascender,
        capHeight: topOf("H"),
        descender,
        unitsPerEm,
        xHeight: topOf("x"),
      },
      region,
      target: { faceId: "target" },
      text: LINES,
    });
    const compared = recovered.map((letter) => {
      const glyph = face.glyph(face.glyphForCharacter(letter.character) ?? 0);
      return {
        advanceError:
          Math.abs(letter.candidate.advance - glyph.advance) / unitsPerEm,
        agreement: shapeAgreement(
          letter.candidate.outline,
          glyph.outline,
          unitsPerEm
        ).aligned,
        fit: letter.fit,
      };
    });

    it("traces every labelled letter", () => {
      expect(recovered).toHaveLength(LETTER_COUNT);
    });

    it("fits the isolated shape it was traced from", () => {
      // Measured: lowest 0.94. This score says the outline follows the
      // isolated shape. It says nothing about whether that shape is right.
      expect(Math.min(...compared.map((item) => item.fit))).toBeGreaterThan(
        0.92
      );
    });

    it("agrees with the true glyph", () => {
      // Intersection over union with Lato's own glyph, after sliding the two
      // together. Measured: middle 0.93, lowest 0.84 (the two small o's).
      // A blur of 1.2 pixels and the grain move an edge by up to half a
      // pixel; on a 10 pixel stroke that costs about a tenth of the overlap,
      // and most on thin rings. So: middle above 0.9, none below 0.8.
      const agreements = compared.map((item) => item.agreement);
      expect(median(agreements) ?? 0).toBeGreaterThan(0.9);
      expect(Math.min(...agreements)).toBeGreaterThan(0.8);
    });

    it("spaces letters from the gaps between them, roughly", () => {
      // Half of each measured gap goes to each neighbour, which is right for
      // two straight stems and wrong for a round letter beside a straight
      // one. Measured against Lato's advances: middle error 0.025 em, worst
      // 0.089 em. Kerning in the original also ends up in these numbers.
      const errors = compared.map((item) => item.advanceError);
      expect(median(errors) ?? 1).toBeLessThan(0.04);
      expect(Math.max(...errors)).toBeLessThan(0.12);
    });
  });
});
