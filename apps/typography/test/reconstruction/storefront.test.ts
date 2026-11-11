/**
 * The real storefront photograph. Its banner reads NEEDED THINGS FOR SALE in
 * a bold condensed sans: nineteen letters, thirteen distinct capitals. Every
 * number asserted here was measured on the photograph and is stated as it is.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { nodeImageCodec } from "~/generation/node-image-codec";
import { loadRecordedRuns } from "~/generation/strategies/recorded/manifest";
import { recordedRunStrategy } from "~/generation/strategies/recorded/recorded-run";
import { median } from "~/generation/style/measure";
import { analyseStyle } from "~/generation/style/reference";
import type { Evidence } from "~/reconstruction/evidence/evidence";
import { rectangleRegion } from "~/reconstruction/evidence/region";
import {
  fitWidthToObserved,
  type Inference,
  inferMissing,
} from "~/reconstruction/inference/infer";
import { observedFace } from "~/reconstruction/inference/observed-face";
import {
  createFaceRecognizer,
  type ReferenceFace,
} from "~/reconstruction/recognition/face-recognizer";
import { type Reconstruction, reconstruct } from "~/reconstruction/reconstruct";
import { outlineOnEvidence } from "~/reconstruction/recovery/correspondence";
import { outlineBounds, transformOutline } from "~/typeface/outline";
import {
  acceptCandidate,
  addSource,
  emptyProject,
  propose,
  workingFaceOf,
} from "~/typeface/project";
import { isUnconfirmed } from "~/typeface/provenance";
import { describeFace } from "../helpers/fixtures";
import {
  CANDIDATE_CHARACTERS,
  codePoints,
  lettersOf,
  photograph,
  REFERENCES,
} from "./helpers/evidence";

/**
 * The lettering of the banner, found by eye: inside the yellow, clear of its
 * edge and of the grommets in its corners.
 */
const REGION = rectangleRegion(432, 162, 400, 196);
const clock = () => new Date("2026-11-10T09:00:00.000Z");
/** The letters stand about four pixels apart, so the region is enlarged twice before isolating. */
const SCALE = 2;
const READING = ["NEEDED THINGS", "FOR SALE"];
const DISTINCT = "ADEFGHILNORST";
const CAPITALS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const allReferences = (): ReferenceFace[] => [
  REFERENCES.lato(),
  REFERENCES.sofia(),
  REFERENCES.sofiaBlack(),
  REFERENCES.sourceCode(),
  REFERENCES.david(),
];

let evidence: Evidence;

beforeAll(async () => {
  evidence = await photograph("storefront");
});

const readBanner = (
  references: readonly ReferenceFace[],
  characters: readonly number[]
) => {
  const result = reconstruct({
    evidence,
    recognizer: createFaceRecognizer(references, characters),
    region: REGION,
    target: { faceId: "target" },
    view: { scale: SCALE },
  });
  return READING.map((_, line) =>
    lettersOf(result.readings.filter((reading) => reading.line === line))
  );
};

const mistakes = (read: readonly string[]) =>
  READING.map((line) => line.replaceAll(" ", ""))
    .join("")
    .split("")
    .filter((letter, index) => read.join("")[index] !== letter).length;

describe("isolating the banner", () => {
  it("finds all nineteen letters, in two lines of two words each", () => {
    const { isolation } = reconstruct({
      evidence,
      region: REGION,
      target: { faceId: "target" },
      view: { scale: SCALE },
    });
    expect(isolation.lines.map((line) => line.letters.length)).toEqual([12, 7]);
    expect(
      isolation.lines.map(
        (line) => line.letters.filter((letter) => letter.spaceLeft).length
      )
    ).toEqual([2, 2]);
    expect(
      isolation.lines
        .flatMap((line) => line.letters)
        .some((letter) => letter.runTogether || letter.parts > 1)
    ).toBe(false);
    expect(isolation.lines.map((line) => line.body)).toEqual([
      "cap-height",
      "cap-height",
    ]);
    // The capitals are 68 pixels tall in the photograph, 136 in the view.
    expect(isolation.lines[0]?.bodyHeight).toBeCloseTo(135.6, 0);
    expect(isolation.lines[1]?.bodyHeight).toBeCloseTo(136.9, 0);
    // The banner hangs a little off level: both lines climb to the right.
    expect(isolation.lines[0]?.slope).toBeCloseTo(-0.007, 3);
    expect(isolation.lines[1]?.slope).toBeCloseTo(-0.011, 3);
    expect(isolation.separation.lettering).toBe("darker");
    expect(isolation.separation.polarity).toBe("automatic");
  });

  it("finds them by tone as well as by colour, at the photograph's size or enlarged", () => {
    // Red on yellow was expected to be weak by tone. Measured, it is not:
    // this red is much darker than this yellow. Separability is 0.95 by tone
    // and 0.94 by colour, and all nineteen letters are found either way.
    for (const by of ["tone", "colour"] as const) {
      for (const scale of [1, 2]) {
        const { isolation } = reconstruct({
          evidence,
          isolation: { by },
          region: REGION,
          target: { faceId: "target" },
          view: { scale },
        });
        expect(isolation.lines.map((line) => line.letters.length)).toEqual([
          12, 7,
        ]);
        expect(isolation.separation.separability).toBeGreaterThan(0.93);
      }
    }
  });
});

describe("reading the banner against the fixture faces", () => {
  it("reads 16 of 19 letters among capitals, small letters and figures", () => {
    // The three mistakes are both D's and the O, each read as a zero. In a
    // bold condensed face the three are near twins, and the heavy reference
    // has a zero narrower than its O.
    const read = readBanner(allReferences(), CANDIDATE_CHARACTERS);
    expect(read).toEqual(["NEE0E0THINGS", "F0RSALE"]);
    expect(mistakes(read)).toBe(3);
  });

  it("reads all 19 when told the lettering is capitals", () => {
    const read = readBanner(allReferences(), codePoints(CAPITALS));
    expect(read).toEqual(["NEEDEDTHINGS", "FORSALE"]);
  });

  it("reads 14 of 19 when no reference is heavy", () => {
    // Without Sofia Sans at weight 900 every reference is a regular weight,
    // and a regular glyph stretched to fit a bold one is a poor match.
    const read = readBanner(
      [
        REFERENCES.lato(),
        REFERENCES.sofia(),
        REFERENCES.sourceCode(),
        REFERENCES.david(),
      ],
      CANDIDATE_CHARACTERS
    );
    expect(read).toEqual(["NEEBEBTMINGS", "F0R8ALE"]);
    expect(mistakes(read)).toBe(5);
  });
});

describe("the banner, labelled by a person", () => {
  let result: Reconstruction;
  const recognizer = () =>
    createFaceRecognizer(allReferences(), CANDIDATE_CHARACTERS);

  beforeAll(() => {
    result = reconstruct({
      evidence,
      recognizer: recognizer(),
      region: REGION,
      target: { faceId: "target" },
      text: READING,
      view: { scale: SCALE },
    });
  });

  it("keeps the person's label over the recogniser's, and the recogniser's guesses beside it", () => {
    const [, , , firstD] = result.readings;
    expect(firstD?.labelledBy).toBe("person");
    expect(String.fromCodePoint(firstD?.character ?? 0)).toBe("D");
    expect(String.fromCodePoint(firstD?.guesses[0]?.character ?? 0)).toBe("0");
  });

  it("names the nearest faces, and does not call the nearest an identification", () => {
    const nearest = recognizer().nearestFaces(
      result.isolation.lines,
      result.readings
    );
    expect(nearest.map((match) => match.reference)).toEqual([
      "sofia-sans-900",
      "sofia-sans-400",
      "source-code-pro",
      "lato",
      "david-libre",
    ]);
    const [first, second] = nearest;
    // Agreement 0.85 for the heavy Sofia Sans, 0.57 for the next. The
    // banner is not Sofia Sans: this is the nearest of five fonts that
    // happen to be in the fixtures.
    expect(first?.agreement).toBeCloseTo(0.854, 2);
    // The two lines of the banner are not set at one width. The top line
    // fits that face squeezed to 46% of its width, the bottom line to 63%.
    expect(first?.widthFactors[0]).toBeCloseTo(0.456, 2);
    expect(first?.widthFactors[1]).toBeCloseTo(0.632, 2);
    // The one-number summary is the middle of the two and fits neither line.
    expect(first?.widthFactor).toBeCloseTo(0.544, 2);
    expect(first?.letters).toBe(19);
    expect(second?.agreement).toBeCloseTo(0.568, 2);
  });

  it("traces all nineteen letters and fits each to the shape it came from", () => {
    expect(result.recovered).toHaveLength(19);
    const fits = result.recovered.map((letter) => letter.fit);
    // Measured: 0.946 (the I, the smallest shape) to 0.990.
    expect(Math.min(...fits)).toBeGreaterThan(0.94);
    expect(Math.max(...fits)).toBeLessThan(0.995);
  });

  it("makes one candidate for each of the thirteen distinct capitals", () => {
    const letters = result.distinct
      .map((letter) => String.fromCodePoint(letter.character))
      .toSorted()
      .join("");
    expect(letters).toBe(DISTINCT);
    for (const { candidate, character, fit } of result.distinct) {
      expect(fit).toBeGreaterThan(0.94);
      expect(candidate.characters).toEqual([character]);
      expect(candidate.provenance).toMatchObject({
        basis: "observed",
        confidence: 1,
        evidenceId: evidence.id,
        origin: "reconstructed",
      });
      expect(isUnconfirmed(candidate.provenance)).toBe(false);
      expect(candidate.replaces).toBeUndefined();
      const bounds = outlineBounds(candidate.outline);
      // One scale for a line: capitals stand on the baseline and reach the
      // cap height of 700, round ones a little past both.
      expect(bounds?.yMin).toBeGreaterThan(-25);
      expect(bounds?.yMin).toBeLessThan(15);
      expect(bounds?.yMax).toBeGreaterThan(685);
      expect(bounds?.yMax).toBeLessThan(730);
      expect(candidate.advance).toBeGreaterThan((bounds?.xMax ?? 0) - 1);
    }
    expect(
      new Set(result.distinct.map((letter) => letter.candidate.id)).size
    ).toBe(13);
    // Of the four E's the one chosen agrees best with the other three.
    const chosenE = result.distinct.find((letter) => letter.character === 0x45);
    expect(chosenE?.reading.line).toBe(0);
  });

  it("takes sidebearings from measured gaps, and says where there was no neighbour", () => {
    const [n, e] = result.recovered;
    // N opens the line: nothing on its left. Its right gap is shared with E.
    expect(n?.sidebearings.left.from).toBe("line");
    expect(n?.sidebearings.right.from).toBe("neighbour");
    expect(n?.sidebearings.right.value).toBe(e?.sidebearings.left.value);
    // S and A in SALE stand so close that their boxes touch.
    const s = result.recovered.find(
      ({ reading }) => reading.line === 1 && reading.index === 3
    );
    expect(s?.sidebearings.right).toEqual({ from: "neighbour", value: 0 });
  });

  it("maps every outline back onto the photograph", () => {
    for (const { candidate, correspondence } of result.recovered) {
      const { provenance } = candidate;
      const region =
        provenance.origin === "reconstructed" ? provenance.region : undefined;
      const onEvidence = outlineBounds(
        outlineOnEvidence(candidate.outline, correspondence)
      );
      // The outline, carried to the photograph, covers the box the letter
      // was found in, to within a pixel of the photograph.
      expect(
        Math.abs((onEvidence?.xMin ?? 0) - (region?.x ?? 99))
      ).toBeLessThan(1);
      expect(
        Math.abs((onEvidence?.yMin ?? 0) - (region?.y ?? 99))
      ).toBeLessThan(1);
      expect(
        Math.abs(
          (onEvidence?.xMax ?? 0) - ((region?.x ?? 0) + (region?.width ?? 99))
        )
      ).toBeLessThan(1);
      expect(
        Math.abs(
          (onEvidence?.yMax ?? 0) - ((region?.y ?? 0) + (region?.height ?? 99))
        )
      ).toBeLessThan(1);
      // A rectangular region maps back by one transform, the same map.
      expect(correspondence.toEvidence).toBeDefined();
      const direct = correspondence.toEvidence
        ? outlineBounds(
            transformOutline(candidate.outline, correspondence.toEvidence)
          )
        : undefined;
      expect(direct?.xMin).toBeCloseTo(onEvidence?.xMin ?? 0, 6);
      expect(direct?.yMax).toBeCloseTo(onEvidence?.yMax ?? 0, 6);
      // And it lies inside the region that was given.
      expect(region?.x).toBeGreaterThanOrEqual(432);
      expect((region?.y ?? 0) + (region?.height ?? 0)).toBeLessThanOrEqual(
        162 + 196
      );
    }
  });

  describe("inferring the thirteen capitals the banner lacks, from a recorded model run", () => {
    const RUN = path.join(
      import.meta.dirname,
      "../fixtures/generation/2026-11-10-storefront-completion"
    );
    let inference: Inference;

    beforeAll(async () => {
      const files = new Map(
        readdirSync(RUN).map((name) => [
          name,
          new Uint8Array(readFileSync(path.join(RUN, name))),
        ])
      );
      const [run] = loadRecordedRuns(
        new TextDecoder().decode(files.get("run.json")),
        files
      );
      if (!run) {
        throw new Error("The storefront fixture holds no recorded run.");
      }
      inference = await inferMissing({
        clock,
        codec: nodeImageCodec,
        evidenceId: evidence.id,
        metrics: result.metrics,
        newId: () => "attempt",
        observed: result.distinct,
        strategy: recordedRunStrategy(run),
        target: { faceId: "target" },
        wanted: codePoints(`${CAPITALS}&?`),
        widthReference: REFERENCES.sofiaBlack(),
      });
    });

    it("measures the style from the observed outlines alone", () => {
      const { style } = inference;
      expect(style.characters).toHaveLength(13);
      // The cap height is measured from H, I, E and T. No small letter was
      // seen, so the x-height is an assumption and is marked as one.
      expect(style.metrics.sources.capHeight).toBe("measured");
      expect(style.metrics.capHeight).toBeCloseTo(704.5, 0);
      expect(style.metrics.sources.xHeight).toBe("assumed");
      // Upright strokes of 98 units under level strokes of 132: lettering
      // squeezed across after it was drawn, as the top line of the banner is.
      expect(style.stems.vertical).toBeCloseTo(98, 0);
      expect(style.stems.horizontal).toBeCloseTo(132, 0);
      expect(style.slant).toBe(0);
    });

    it("leaves the observed letters alone and infers the other fifteen", () => {
      expect(
        inference.alreadyObserved
          .map((character) => String.fromCodePoint(character))
          .toSorted()
          .join("")
      ).toBe(DISTINCT);
      expect(
        inference.candidates
          .map((candidate) =>
            String.fromCodePoint(candidate.characters[0] ?? 0)
          )
          .join("")
      ).toBe("BCJKMPQUVWXYZ&?");
      expect(inference.run.record.unmade).toEqual([]);
    });

    it("marks every one as inferred, and keeps the record of the model run that drew it", () => {
      for (const candidate of inference.candidates) {
        // Replayed, not live: each candidate says so itself, with the model.
        expect(candidate.provenance).toMatchObject({
          basis: "inferred",
          evidenceId: evidence.id,
          inferredBy: {
            model: "ideogram/vector/text-to-vector",
            recorded: true,
            runId: "2026-11-10-storefront-completion#vector-model",
          },
          origin: "reconstructed",
        });
        expect(isUnconfirmed(candidate.provenance)).toBe(true);
      }
      // The run record says the same.
      const { record } = inference.run;
      expect(record.recorded).toBe(true);
      expect(record.strategy.kind).toBe("recorded-run");
      expect(record.producedBy).toBe("vector-model");
      expect(record.model).toBe("ideogram/vector/text-to-vector");
      expect(record.runId).toBe(
        "2026-11-10-storefront-completion#vector-model"
      );
      expect(record.createdAt).toBe("2026-11-10T05:35:30Z");
    });

    it("shows that the model drew the letters more than twice as wide as the banner's", () => {
      const { widths } = inference;
      expect(widths.basis).toBe("reference-face");
      // Each letter's width over height, over the same letter's in Sofia
      // Sans at weight 900. The observed capitals are about half as wide as
      // that face's, the inferred ones wider than it.
      expect(widths.observedMiddle).toBeCloseTo(0.52, 2);
      expect(widths.inferredMiddle).toBeCloseTo(1.14, 2);
      expect(widths.ratio).toBeCloseTo(2.18, 2);
      // The observed middle is of two widths mixed. Eight of the thirteen
      // candidates come from the top line and five from the wider bottom
      // line, so the thirteen are not one coherent width, and the ratio is
      // 2.36 against the top line and 1.69 against the bottom.
      const relativeOn = (line: number) =>
        median(
          result.distinct
            .filter((letter) => letter.reading.line === line)
            .flatMap(
              (letter) =>
                widths.observed.find(
                  (glyph) => glyph.character === letter.character
                )?.relative ?? []
            )
        ) ?? 0;
      expect(
        result.distinct.filter((letter) => letter.reading.line === 0)
      ).toHaveLength(8);
      expect(relativeOn(0)).toBeCloseTo(0.483, 2);
      expect(relativeOn(1)).toBeCloseTo(0.675, 2);
      expect(widths.inferredMiddle / relativeOn(0)).toBeCloseTo(2.36, 1);
      expect(widths.inferredMiddle / relativeOn(1)).toBeCloseTo(1.69, 1);
      // The run's own note says the model matched the weight. Measured
      // against the cap height it did not: generation's stem check fails on
      // all thirteen letters, with upright strokes about 210 units thick
      // against the banner's 98. The same factor of about 2.2: the model
      // drew the design at its natural width.
      const failing = inference.candidates.filter((candidate) =>
        inference.run.evaluations
          .get(candidate.id)
          ?.defects.some((defect) => defect.kind === "stem-thickness")
      );
      expect(failing).toHaveLength(13);
      expect(inference.run.rejected).toEqual([]);
    });

    it("says so when no reference face can make the comparison like for like", async () => {
      const files = new Map(
        readdirSync(RUN).map((name) => [
          name,
          new Uint8Array(readFileSync(path.join(RUN, name))),
        ])
      );
      const [run] = loadRecordedRuns(
        new TextDecoder().decode(files.get("run.json")),
        files
      );
      if (!run) {
        throw new Error("The storefront fixture holds no recorded run.");
      }
      const plain = await inferMissing({
        clock,
        codec: nodeImageCodec,
        evidenceId: evidence.id,
        metrics: result.metrics,
        newId: () => "plain",
        observed: result.distinct,
        strategy: recordedRunStrategy(run),
        target: { faceId: "target" },
        wanted: codePoints("BCJ"),
      });
      expect(plain.widths.basis).toBe("ink-proportion");
      expect(plain.widths.ratio).toBeGreaterThan(2);
      // Asked for three, given a sheet of fifteen: only the three come back.
      expect(plain.candidates).toHaveLength(3);
    });

    it("can bring the inferred letters to the observed width, when asked", () => {
      const fitted = fitWidthToObserved(inference);
      expect(fitted.factor).toBeCloseTo(0.459, 2);
      const capitals = fitted.candidates.filter((candidate) =>
        CAPITALS.includes(String.fromCodePoint(candidate.characters[0] ?? 0))
      );
      const style = analyseStyle(
        observedFace(
          capitals.map((candidate) => ({
            advance: candidate.advance,
            character: candidate.characters[0] ?? 0,
            outline: candidate.outline,
          })),
          result.metrics
        )
      );
      // Squeezed by that one factor, the inferred uprights come to 96 units
      // against the observed 98. The level strokes, untouched, stay heavier
      // than the banner's: 152 against 132.
      expect(style.stems.vertical).toBeCloseTo(96, 0);
      expect(style.stems.horizontal).toBeCloseTo(152, 0);
      // The candidates given in are not changed.
      expect(inference.widths.ratio).toBeCloseTo(2.18, 2);
    });

    it("gives candidates a project can propose and accept, observed and inferred side by side", () => {
      const source = {
        bytes: new Uint8Array([1]),
        fileName: "blank.ttf",
        id: "blank-source",
        importedAt: "2026-11-10T00:00:00.000Z",
      };
      const withFace = addSource(emptyProject(), source, [describeFace()]);
      const faceId = withFace.faces[0]?.id ?? "";
      const onFace = [
        ...result.distinct.map((letter) => letter.candidate),
        ...inference.candidates,
      ].map((candidate) => ({ ...candidate, faceId }));
      const proposed = propose(withFace, onFace);
      expect(proposed.candidates).toHaveLength(28);
      expect(new Set(onFace.map((candidate) => candidate.name)).size).toBe(28);
      const observedA = onFace.find(
        (candidate) => candidate.characters[0] === 0x41
      );
      const inferredB = onFace.find(
        (candidate) => candidate.characters[0] === 0x42
      );
      const accepted = acceptCandidate(
        acceptCandidate(proposed, observedA?.id ?? ""),
        inferredB?.id ?? ""
      );
      const working = workingFaceOf(accepted, faceId);
      expect(
        working.added.map((glyph) =>
          glyph.provenance.origin === "reconstructed"
            ? glyph.provenance.basis
            : glyph.provenance.origin
        )
      ).toEqual(["observed", "inferred"]);
    });
  });
});
