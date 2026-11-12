/**
 * The sixth milestone end to end: the same accented letters generated for
 * three weights of Sofia Sans, accepted, and built both ways. Three static
 * fonts whose new glyphs get heavier with the weight, and one variable font
 * rebuilt from the three as masters, in which the new glyphs interpolate.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { measureInk } from "~/generation/style/measure";
import type {
  BuiltFont,
  BuiltVariableFont,
  FontBuilder,
} from "~/packaging/building";
import { nodeFontBuilder } from "~/packaging/engine/node";
import { resolveVariableBuild } from "~/packaging/variable-build";
import type { Face } from "~/typeface/face";
import {
  candidateStatuses,
  type TypefaceProject,
  workingFaceOf,
} from "~/typeface/project";
import type { OpenFace } from "~/typeface/reading";
import { fontBytes } from "../../helpers/fixtures";
import {
  furthestApart,
  furthestFromHalfway,
} from "../../packaging/helpers/masters";
import {
  ACCENTED,
  acceptEverything,
  charactersOf,
  FAMILY_WEIGHTS,
  generateSofiaFamily,
} from "./helpers/sofia-family";

const BUILD_TIMEOUT = 240_000;
const FAMILY_NAME = "Sofia Extended";
/** Rounding to whole font units, once in each master and once when interpolating. */
const ROUNDING = 1;
const LETTERS = [...ACCENTED];

const glyphOf = (face: OpenFace, letter: string) => {
  const glyph = face.glyphForCharacter(letter.codePointAt(0) ?? 0);
  if (glyph === undefined) {
    throw new Error(`The face does not map ${letter}.`);
  }
  return glyph;
};

const inkOf = (face: OpenFace, letter: string, weight?: number) => {
  const location = weight === undefined ? undefined : { wght: weight };
  const { outline } = face.glyph(glyphOf(face, letter), location);
  return measureInk(outline, face.description.metrics.unitsPerEm)?.area ?? 0;
};

describe("Sofia Sans extended across three weights", () => {
  const sofia = fontBytes("sofia");
  const source = harfBuzzReader.open(sofia);
  let builder: FontBuilder;
  let project: TypefaceProject;
  let instances: readonly Face[];
  let statics: readonly {
    readonly built: BuiltFont;
    readonly face: OpenFace;
  }[];
  let variable: BuiltVariableFont;
  let rebuilt: OpenFace;

  beforeAll(async () => {
    builder = await nodeFontBuilder();
    const { generation } = await generateSofiaFamily(sofia);
    project = acceptEverything(generation);
    instances = generation.instances.map(({ face }) => face);
    const builds: { built: BuiltFont; face: OpenFace }[] = [];
    for (const instance of instances) {
      const working = workingFaceOf(project, instance.id);
      const built = await builder.build({
        added: working.added,
        faceIndex: instance.index,
        familyName: FAMILY_NAME,
        featureCode: working.featureCode,
        location: instance.pinned?.location,
        overrides: working.overrides,
        source: sofia,
        styleName: instance.pinned?.styleName,
      });
      builds.push({ built, face: harfBuzzReader.open(built.bytes) });
    }
    statics = builds;
    const resolution = resolveVariableBuild(
      project,
      instances.map((instance) => instance.id),
      { familyName: FAMILY_NAME }
    );
    if (!resolution.request) {
      throw new Error(
        resolution.problems.map((problem) => problem.message).join(" ")
      );
    }
    variable = await builder.buildVariable(resolution.request);
    rebuilt = harfBuzzReader.open(variable.bytes);
    console.info(
      "Sofia Sans, three generated masters, in Node (ms):",
      variable.timings
    );
  }, BUILD_TIMEOUT);

  describe("three static fonts", () => {
    it("accepts every candidate into its own pinned instance", () => {
      expect(instances.map((face) => face.pinned?.styleName)).toEqual([
        "Light",
        "Regular",
        "ExtraBold",
      ]);
      for (const instance of instances) {
        const working = workingFaceOf(project, instance.id);
        expect(working.added.map((glyph) => glyph.characters[0])).toEqual(
          charactersOf(ACCENTED)
        );
      }
      expect(
        [...candidateStatuses(project).values()].every(
          (status) => status === "accepted"
        )
      ).toBe(true);
    });

    it("builds each instance as a static font that has the new letters", () => {
      for (const [index, { built, face }] of statics.entries()) {
        expect(face.description.axes).toEqual([]);
        expect(face.description.familyName).toBe(FAMILY_NAME);
        expect(face.description.weightClass).toBe(FAMILY_WEIGHTS[index]);
        expect(built.glyphCount).toBe(
          source.description.glyphCount + LETTERS.length
        );
        for (const letter of LETTERS) {
          expect(source.glyphForCharacter(letter.codePointAt(0) ?? 0)).toBe(
            undefined
          );
          expect(
            face.shape(letter).glyphs.map((glyph) => glyph.glyphId)
          ).toEqual([glyphOf(face, letter)]);
        }
      }
    });

    it("draws the new letters heavier as the weight goes up", () => {
      for (const letter of LETTERS) {
        const [light, regular, heavy] = statics.map(({ face }) =>
          inkOf(face, letter)
        );
        expect(light).toBeGreaterThan(0);
        expect(regular).toBeGreaterThan((light ?? 0) * 1.1);
        expect(heavy).toBeGreaterThan((regular ?? 0) * 1.3);
      }
    });

    it("builds each new letter on the instance's own base letter", () => {
      for (const [index, { face }] of statics.entries()) {
        const weight = FAMILY_WEIGHTS[index] ?? 0;
        const base = source.glyph(glyphOf(source, "c"), { wght: weight });
        const accented = face.glyph(glyphOf(face, "ĉ"));
        expect(accented.advance).toBe(Math.round(base.advance));
        expect(accented.outline.contours.length).toBeGreaterThan(
          base.outline.contours.length
        );
      }
    });

    it("passes the engine's validation", async () => {
      for (const { built } of statics) {
        expect((await builder.validate(built.bytes)).issues).toEqual([]);
      }
    });
  });

  describe("one variable font rebuilt from the three as masters", () => {
    it("has a weight axis from the lightest master to the heaviest", () => {
      const axis = {
        default: 400,
        max: 800,
        min: 300,
        name: "Weight",
        tag: "wght",
      };
      expect(variable.axis).toEqual(axis);
      expect(rebuilt.description.axes).toEqual([axis]);
      expect(rebuilt.description.familyName).toBe(FAMILY_NAME);
      expect(rebuilt.description.instances.map((named) => named.name)).toEqual([
        "Light",
        "Regular",
        "ExtraBold",
      ]);
    });

    it("draws each new letter as the static font does, at each master", () => {
      for (const [index, { face }] of statics.entries()) {
        const weight = FAMILY_WEIGHTS[index] ?? 0;
        for (const letter of LETTERS) {
          expect(
            furthestApart(
              rebuilt.glyph(glyphOf(rebuilt, letter), { wght: weight }),
              face.glyph(glyphOf(face, letter))
            )
          ).toBeLessThanOrEqual(ROUNDING);
        }
      }
    });

    it("interpolates the new letters between masters", () => {
      for (const letter of LETTERS) {
        const at = (weight: number) =>
          rebuilt.glyph(glyphOf(rebuilt, letter), { wght: weight });
        expect(
          furthestFromHalfway(at(350), at(300), at(400))
        ).toBeLessThanOrEqual(ROUNDING);
        expect(
          furthestFromHalfway(at(600), at(400), at(800))
        ).toBeLessThanOrEqual(ROUNDING);
        expect(furthestApart(at(600), at(400))).toBeGreaterThan(5);
        const inks = [300, 350, 400, 500, 600, 700, 800].map((weight) =>
          inkOf(rebuilt, letter, weight)
        );
        expect(inks).toEqual(inks.toSorted((a, b) => a - b));
        expect(new Set(inks).size).toBe(inks.length);
      }
    });

    it("keeps the source font's own glyphs", () => {
      expect(variable.glyphCount).toBe(
        source.description.glyphCount + LETTERS.length
      );
      expect(variable.characterCount).toBe(
        source.description.characterCount + LETTERS.length
      );
      for (const letter of ["a", "R", "é", "ф", "ω"]) {
        for (const weight of FAMILY_WEIGHTS) {
          const location = { wght: weight };
          expect(
            furthestApart(
              rebuilt.glyph(glyphOf(rebuilt, letter), location),
              source.glyph(glyphOf(source, letter), location)
            )
          ).toBeLessThanOrEqual(ROUNDING);
        }
      }
    });

    it("keeps the source font's shaping", () => {
      expect(rebuilt.description.layout).toEqual(source.description.layout);
      for (const weight of FAMILY_WEIGHTS) {
        const options = { location: { wght: weight } };
        for (const text of ["office", "AVATAR", "Tо"]) {
          const mine = rebuilt.shape(text, options).glyphs;
          const theirs = source.shape(text, options).glyphs;
          expect(mine.map((glyph) => glyph.glyphId)).toEqual(
            theirs.map((glyph) => glyph.glyphId)
          );
          expect(
            Math.max(
              ...mine.map((glyph, index) =>
                Math.abs(glyph.xAdvance - (theirs[index]?.xAdvance ?? 0))
              )
            )
          ).toBeLessThanOrEqual(ROUNDING);
        }
      }
      // Sofia Sans joins f and f, and leaves the i alone.
      expect(rebuilt.shape("office").glyphs).toHaveLength(5);
      expect(
        rebuilt.shape(ACCENTED).glyphs.map((glyph) => glyph.glyphId)
      ).toEqual(LETTERS.map((letter) => glyphOf(rebuilt, letter)));
    });

    it("passes the engine's validation", async () => {
      const report = await builder.validate(variable.bytes);
      expect(report.issues).toEqual([]);
      expect(report.loadable).toBe(true);
    });
  });
});
