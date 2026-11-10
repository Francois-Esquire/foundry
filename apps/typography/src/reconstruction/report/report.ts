/** A reconstruction as plain data, for a JSON report a person or a test can read. */
import { median } from "~/generation/style/measure";
import type { Evidence } from "../evidence/evidence";
import type { FaceMatch } from "../recognition/face-recognizer";
import type { Guess } from "../recognition/recognizer";
import type { Reconstruction } from "../reconstruct";

const letterOf = (character: number | undefined) =>
  character === undefined ? null : String.fromCodePoint(character);

const round = (value: number, places = 3) => Number(value.toFixed(places));

const guessOf = ({ character, confidence, reference }: Guess) => ({
  character: letterOf(character),
  confidence: round(confidence),
  reference: reference ?? null,
});

/**
 * The report of one reconstruction. Everything in it was observed in the
 * evidence. `nearestFaces` ranks resemblance and identifies nothing.
 */
export const reportOf = (
  evidence: Evidence,
  reconstruction: Reconstruction,
  nearestFaces: readonly FaceMatch[] = []
) => {
  const { distinct, isolation, readings, recovered, view } = reconstruction;
  const fits = recovered.map((letter) => letter.fit);
  return {
    candidates: distinct.map(({ candidate, character, fit, reading }) => ({
      advance: candidate.advance,
      character: letterOf(character),
      fit: round(fit),
      from: { index: reading.index, line: reading.line },
      id: candidate.id,
      name: candidate.name,
      redrawsSourceGlyph: candidate.replaces !== undefined,
    })),
    evidence: {
      fileName: evidence.fileName,
      height: evidence.height,
      id: evidence.id,
      width: evidence.width,
    },
    fit: {
      lowest: fits.length > 0 ? round(Math.min(...fits)) : null,
      middle: fits.length > 0 ? round(median(fits) ?? 0) : null,
    },
    isolation: {
      ...isolation.separation,
      rulesRemoved: isolation.rulesRemoved,
      separability: round(isolation.separation.separability),
      specksRemoved: isolation.specksRemoved,
      strayPieces: isolation.stray.length,
      strokeThickness: round(isolation.strokeThickness, 1),
    },
    letters: readings.map((reading) => {
      const traced = recovered.find((letter) => letter.reading === reading);
      return {
        box: reading.letter.box,
        character: letterOf(reading.character),
        guesses: reading.guesses.map(guessOf),
        index: reading.index,
        labelledBy: reading.character === undefined ? null : reading.labelledBy,
        line: reading.line,
        pieces: reading.letter.parts,
        runTogether: reading.letter.runTogether,
        traced: traced
          ? {
              advance: traced.candidate.advance,
              fit: round(traced.fit),
              onEvidence:
                traced.candidate.provenance.origin === "reconstructed"
                  ? (traced.candidate.provenance.region ?? null)
                  : null,
              sidebearings: traced.sidebearings,
            }
          : null,
      };
    }),
    lines: isolation.lines.map((line) => ({
      ascent: round(line.ascent, 1),
      baseline: round(line.baseline, 1),
      body: line.body,
      bodyHeight: round(line.bodyHeight, 1),
      letters: line.letters.length,
      slope: round(line.slope, 4),
    })),
    nearestFaces: nearestFaces.map((match) => ({
      ...match,
      agreement: round(match.agreement),
      widthFactors: match.widthFactors.map((factor) => round(factor)),
    })),
    notes: [
      "Every letter here was observed in the evidence. Nothing in this report is inferred.",
      "A label marked recognizer is a guess and can be wrong. A label marked person was given.",
      "Fit says how closely an outline follows the shape that was isolated. It does not say the shape is the letter.",
      "Nearest faces rank resemblance among the reference fonts given. They do not identify the typeface.",
    ],
    region: view.region,
    viewScale: view.scale,
  };
};
