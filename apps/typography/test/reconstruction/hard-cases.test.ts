/**
 * The two photographs the method is not expected to handle. These tests
 * assert what actually happens, failure included, so the limits stay written
 * down and a change that moves them shows up here.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Evidence } from "~/reconstruction/evidence/evidence";
import {
  quadrilateralRegion,
  rectangleRegion,
} from "~/reconstruction/evidence/region";
import { createFaceRecognizer } from "~/reconstruction/recognition/face-recognizer";
import { LabelCountError } from "~/reconstruction/recognition/recognizer";
import { type Reconstruction, reconstruct } from "~/reconstruction/reconstruct";
import {
  CANDIDATE_CHARACTERS,
  lettersOf,
  photograph,
  REFERENCES,
} from "./helpers/evidence";

const recognizer = () =>
  createFaceRecognizer(
    [
      REFERENCES.lato(),
      REFERENCES.sofia(),
      REFERENCES.sofiaBlack(),
      REFERENCES.sourceCode(),
      REFERENCES.david(),
    ],
    CANDIDATE_CHARACTERS
  );

const shapes = (result: Reconstruction) =>
  result.isolation.lines.flatMap((line) => line.letters);

describe("the copper letters: perspective, depth and shadow", () => {
  /**
   * The table top the letters lie on, by eye: its far edge is shorter and
   * higher on the right. Five letters, O Z A R K, lie inside it.
   */
  const TABLE = quadrilateralRegion([
    { x: 12, y: 112 },
    { x: 938, y: 85 },
    { x: 938, y: 240 },
    { x: 12, y: 240 },
  ]);
  let evidence: Evidence;

  beforeAll(async () => {
    evidence = await photograph("copper");
  });

  it("does not isolate the five letters: left to itself it takes the white cloth for the lettering", () => {
    const result = reconstruct({
      evidence,
      recognizer: recognizer(),
      region: TABLE,
      target: { faceId: "target" },
    });
    // Neither class holds the border of the region, so the larger one is
    // taken for the ground. The larger one is the dark, and the cloth is
    // read as light lettering on it.
    expect(result.isolation.separation.lettering).toBe("lighter");
    // Two classes explain 0.82 of the picture, against 0.94 on the
    // storefront: copper, patina, shadow, cloth and wall are not two things.
    expect(result.isolation.separation.separability).toBeLessThan(0.85);
    expect(result.isolation.separation.separability).toBeGreaterThan(0.78);
    expect(shapes(result)).toHaveLength(3);
    expect(shapes(result).filter((shape) => shape.runTogether)).toHaveLength(1);
    // What it reads is noise, and its confidence in most of it is low.
    expect(lettersOf(result.readings)).toBe("CPW");
    expect(result.readings[2]?.guesses[0]?.confidence).toBeLessThan(0.25);
  });

  it("does no better told that the lettering is the darker part: letters, shadows and wall are one shape", () => {
    const result = reconstruct({
      evidence,
      isolation: { lettering: "darker" },
      recognizer: recognizer(),
      region: TABLE,
      target: { faceId: "target" },
    });
    expect(shapes(result)).toHaveLength(1);
    expect(shapes(result)[0]?.runTogether).toBe(true);
    expect(result.readings[0]?.guesses[0]?.confidence).toBeLessThan(0.25);
  });

  it("refuses a typed reading that does not match what it found, instead of mislabelling", () => {
    expect(() =>
      reconstruct({
        evidence,
        isolation: { lettering: "darker" },
        region: TABLE,
        target: { faceId: "target" },
        text: ["OZARK"],
      })
    ).toThrow(LabelCountError);
  });

  it("still traces faithfully what it wrongly isolated, which is why fit alone proves nothing", () => {
    const result = reconstruct({
      evidence,
      isolation: { lettering: "darker" },
      recognizer: recognizer(),
      region: TABLE,
      target: { faceId: "target" },
    });
    // The one shape is the wrong shape, traced well: fit 0.98.
    expect(result.recovered).toHaveLength(1);
    expect(result.recovered[0]?.fit).toBeGreaterThan(0.95);
    // A four-corner region has no single transform back to the photograph.
    expect(result.recovered[0]?.correspondence.toEvidence).toBeUndefined();
    const place = result.recovered[0]?.correspondence.place({ x: 0, y: 0 });
    expect(place?.x).toBeGreaterThan(0);
    expect(place?.x).toBeLessThan(evidence.width);
  });
});

describe("the handwriting: thin cursive letters on ruled lines that cross them", () => {
  let evidence: Evidence;
  const whole = () => rectangleRegion(0, 0, evidence.width, evidence.height);

  beforeAll(async () => {
    evidence = await photograph("handwriting");
  });

  it("finds four shapes, each a letter fused with the rules it is written on", () => {
    const result = reconstruct({
      evidence,
      isolation: { by: "tone" },
      recognizer: recognizer(),
      region: whole(),
      target: { faceId: "target" },
    });
    expect(result.isolation.separation.separability).toBeGreaterThan(0.88);
    const found = shapes(result);
    expect(found).toHaveLength(4);
    // Each is as tall as the whole ruling, top line to bottom line: 247
    // pixels of a picture 308 tall. The rules above and below a letter that
    // touch nothing are stacked onto it as if they were its parts.
    expect(result.isolation.lines[0]?.bodyHeight).toBeCloseTo(247.5, 0);
    expect(found.map((shape) => shape.parts)).toEqual([2, 3, 1, 2]);
    expect(lettersOf(result.readings)).toBe("Xe7e");
  });

  it("parts the letters from most of the ruling when asked to take rules out, and leaves stubs of it on them", () => {
    const result = reconstruct({
      evidence,
      isolation: { by: "tone", ruledLines: true },
      recognizer: recognizer(),
      region: whole(),
      target: { faceId: "target" },
    });
    expect(result.isolation.rulesRemoved).toBe(7);
    const found = shapes(result);
    expect(found).toHaveLength(4);
    expect(found.map((shape) => shape.parts)).toEqual([1, 1, 1, 1]);
    // The baseline lands on the heavy rule the letters are written on, at
    // 200 pixels down, and f and g go below it.
    const [line] = result.isolation.lines;
    expect(line?.baseline).toBeCloseTo(201.5, 0);
    expect(line?.slope).toBe(0);
    expect(found.map((shape) => shape.box.bottom > 250)).toEqual([
      false,
      false,
      true,
      true,
    ]);
    // But the rules are only gone where they run clear of the writing. The
    // stretch of rule under each letter is still joined to it: the d is 217
    // pixels wide here, the full length of its piece of ruling, and about
    // 174 without it.
    const [d] = found;
    expect((d?.box.right ?? 0) - (d?.box.left ?? 0)).toBe(217);
  });

  /**
   * Rule sizes set by hand for this picture. They sit in a narrow window:
   * at a thickness of 7.7, which is what the automatic sizing above uses,
   * stubs of rule stay on the letters, and at 9 the d comes apart in two.
   */
  const RULES = { maximumGap: 30, maximumThickness: 8, minimumLength: 100 };

  it("gets the letters nearly clean with rule sizes set by hand, and reads none of them", () => {
    const result = reconstruct({
      evidence,
      isolation: { by: "tone", ruledLines: RULES },
      recognizer: recognizer(),
      region: whole(),
      target: { faceId: "target" },
    });
    expect(result.isolation.rulesRemoved).toBe(8);
    const found = shapes(result);
    expect(found.map((shape) => shape.box.right - shape.box.left)).toEqual([
      174, 151, 123, 162,
    ]);
    // The g is in two pieces where a rule cut through its tail, joined
    // again because one hangs under the other.
    expect(found.map((shape) => shape.parts)).toEqual([1, 1, 1, 2]);
    // d e f g, read as V a y y. No reference is a script hand, and a
    // cursive letter carries the strokes that join it to its neighbours.
    expect(lettersOf(result.readings)).toBe("Vayy");
    for (const reading of result.readings) {
      expect(reading.guesses[0]?.confidence).toBeLessThan(0.25);
    }
  });

  it("traces them once a person has said what they are", () => {
    const result = reconstruct({
      evidence,
      isolation: { by: "tone", ruledLines: RULES },
      region: whole(),
      target: { faceId: "target" },
      text: ["defg"],
    });
    expect(
      result.distinct.map((letter) => String.fromCodePoint(letter.character))
    ).toEqual(["d", "e", "f", "g"]);
    // Fit 0.91 to 0.94, lower than the storefront's 0.98: the strokes are
    // three pixels thick, so half a pixel of edge is a sixth of the stroke.
    const fits = result.recovered.map((letter) => letter.fit);
    expect(Math.min(...fits)).toBeGreaterThan(0.9);
    expect(Math.max(...fits)).toBeLessThan(0.95);
    // What is traced is an outline around a pen stroke, broken where a rule
    // crossed it. It is a drawing of this sample, not a typeface.
  });
});
