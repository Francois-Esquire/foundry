import { beforeAll, describe, expect, it } from "vitest";
import { type GenerationRun, runGeneration } from "~/generation/pipeline/run";
import {
  planCharacters,
  planOblique,
  planSmallCapitals,
} from "~/generation/plan/plan";
import { proceduralStrategy } from "~/generation/strategies/procedural/procedural";
import {
  analyseStyle,
  type StyleReference,
} from "~/generation/style/reference";
import { sourceGlyph } from "~/typeface/changes";
import { outlineBounds } from "~/typeface/outline";
import {
  acceptCandidate,
  addSource,
  emptyProject,
  propose,
  workingFaceOf,
} from "~/typeface/project";
import { fixtureFace } from "../helpers/faces";
import { fixedClock, fixedRun, stamp } from "../helpers/fixed";
import { withoutCharacters } from "./helpers/faces";
import { glyphOf } from "./helpers/glyphs";

const lato = fixtureFace("lato");
const FACE_ID = "lato-regular";
const CLOCK = () => new Date("2026-11-10T12:00:00.000Z");
const code = (character: string) => character.codePointAt(0) ?? 0;

/**
 * A holdout: the face is shown without one character, the strategy builds
 * it, and the result is compared with the glyph the real face has. The
 * strategy is also told not to read that character, so the answer cannot leak.
 */
const holdOut = (
  style: StyleReference,
  character: string,
  learnFromComposites: boolean
): Promise<GenerationRun> => {
  const hidden = withoutCharacters(lato, [code(character)]);
  const { targets } = planCharacters(hidden, [code(character)]);
  return runGeneration({
    clock: CLOCK,
    face: hidden,
    faceId: FACE_ID,
    holdouts: new Map(
      targets.map((target) => [target.key, glyphOf(lato, target.text)])
    ),
    newId: () => "run-1",
    strategy: proceduralStrategy({
      clock: CLOCK,
      exclude: [code(character)],
      learnFromComposites,
    }),
    style,
    targets,
  });
};

describe("the procedural strategy", () => {
  let style: StyleReference;

  beforeAll(() => {
    style = analyseStyle(lato);
  });

  it("builds é from e and the acute, matching the face's own é", async () => {
    const run = await holdOut(style, "é", true);
    const [candidate] = run.candidates;
    const evaluation = run.evaluations.get(candidate?.id ?? "");
    // In place, not aligned: a misplaced accent must count against the result.
    // The base is the face's own e, so all disagreement is the accent's
    // position. 0.95 allows the accent to sit about a tenth of its width off.
    expect(evaluation?.scores.shapeInPlace).toBeGreaterThan(0.95);
    expect(evaluation?.verdict).toBe("pass");
    expect(evaluation?.madeBy).toContain("Composite of U+0065 with U+0301");
    expect(evaluation?.madeBy).toContain("placed as the face places it in");
    // é itself is never one of the examples the placement was learned from.
    expect(evaluation?.madeBy).not.toContain("é");
    expect(candidate).toMatchObject({
      advance: glyphOf(lato, "e").advance,
      characters: [0xe9],
      faceId: FACE_ID,
      id: "run-1:u+00e9",
      name: "uni00E9",
      provenance: {
        createdAt: "2026-11-10T12:00:00.000Z",
        origin: "generated",
        runId: "run-1",
        strategy: "procedural",
      },
    });
    expect(candidate?.provenance).not.toHaveProperty("model");
    expect(candidate?.replaces).toBeUndefined();
  });

  it("places the accent from geometry alone when the face has no accented letters to learn from", async () => {
    const run = await holdOut(style, "é", false);
    const [evaluation] = run.evaluations.values();
    // The harder and more common case: nothing but the bounds of the base,
    // the lines of the face and the accent's own axis.
    expect(evaluation?.scores.shapeInPlace).toBeGreaterThan(0.93);
    expect(evaluation?.madeBy).toContain("centred over the base");
  });

  it.each([
    ["è", 0.93],
    ["ñ", 0.97],
    ["í", 0.95],
    ["ů", 0.95],
    ["É", 0.9],
  ])("builds %s from geometry alone above %f", async (character, floor) => {
    const run = await holdOut(style, character, false);
    const [evaluation] = run.evaluations.values();
    expect(evaluation?.scores.shapeInPlace).toBeGreaterThan(floor);
  });

  it("puts an accent on the dotless i when the face has one", async () => {
    const run = await holdOut(style, "ï", true);
    const [evaluation] = run.evaluations.values();
    expect(evaluation?.madeBy).toContain("Composite of U+0131");
    const outline = run.candidates[0]?.outline;
    // The dotless stem and two dots: the dot of the i is gone.
    expect(outline?.contours).toHaveLength(3);
  });

  it("says what it cannot build and builds nothing in its place", async () => {
    const { targets } = planCharacters(lato, [0x09_15, code("é")]);
    expect(targets.map((target) => target.key)).toEqual(["u+0915"]);
    const run = await runGeneration({
      ...fixedRun,
      face: lato,
      faceId: FACE_ID,
      strategy: proceduralStrategy({ clock: fixedClock }),
      style,
      targets,
    });
    expect(run.candidates).toEqual([]);
    expect(run.record.unmade).toEqual([
      {
        key: "u+0915",
        reason:
          "No rule builds this glyph from existing ones. It needs a strategy that draws.",
      },
    ]);
  });

  it("derives an oblique by shear and names the weakness of doing so", async () => {
    const { targets } = planOblique(lato, [code("H")], 12);
    const run = await runGeneration({
      ...fixedRun,
      face: lato,
      faceId: FACE_ID,
      strategy: proceduralStrategy({ clock: fixedClock }),
      style,
      targets,
    });
    const [candidate] = run.candidates;
    const upright = glyphOf(lato, "H");
    const before = outlineBounds(upright.outline);
    const after = outlineBounds(candidate?.outline ?? { contours: [] });
    const lean = Math.tan((12 * Math.PI) / 180) * (before?.yMax ?? 0);
    expect(after?.xMin).toBe(before?.xMin);
    expect(after?.xMax).toBeCloseTo((before?.xMax ?? 0) + lean, -1);
    expect(candidate?.advance).toBe(upright.advance);
    expect(candidate?.replaces).toEqual(
      sourceGlyph(lato.glyphForCharacter(code("H")) ?? 0)
    );
    const evaluation = run.evaluations.get(candidate?.id ?? "");
    expect(evaluation?.madeBy).toContain("sheared 12 degrees");
    expect(evaluation?.weaknesses.join(" ")).toContain("thins strokes");
  });

  it("derives a small capital, and the evaluation catches its thin stems", async () => {
    const { targets } = planSmallCapitals(lato, [code("h")]);
    const run = await runGeneration({
      ...fixedRun,
      face: lato,
      faceId: FACE_ID,
      strategy: proceduralStrategy({ clock: fixedClock }),
      style,
      targets,
    });
    const [candidate] = run.candidates;
    expect(candidate?.characters).toEqual([]);
    expect(candidate?.name).toBe("uni0068.sc");
    const bounds = outlineBounds(candidate?.outline ?? { contours: [] });
    expect(bounds?.yMax).toBeCloseTo(style.metrics.xHeight, -1);
    const evaluation = run.evaluations.get(candidate?.id ?? "");
    expect(evaluation?.weaknesses.join(" ")).toContain(
      "Stems are not compensated"
    );
    expect(evaluation?.defects.map((defect) => defect.kind)).toContain(
      "stem-thickness"
    );
    expect(evaluation?.verdict).toBe("review");
    expect(run.record.notes.join(" ")).toContain("maps to no character");
  });

  it("produces candidates the project can propose and accept", async () => {
    const run = await holdOut(style, "é", true);
    const hidden = withoutCharacters(lato, [0xe9]);
    const source = {
      bytes: new Uint8Array([1]),
      fileName: "Lato-Regular.ttf",
      id: "lato",
      importedAt: "2026-11-10T00:00:00.000Z",
    };
    const imported = addSource(emptyProject(), source, [hidden.description]);
    const faceId = imported.faces[0]?.id ?? "";
    const proposed = propose(
      imported,
      run.candidates.map((candidate) => ({ ...candidate, faceId }))
    );
    const accepted = acceptCandidate(
      proposed,
      run.candidates[0]?.id ?? "",
      stamp()
    );
    const [added] = workingFaceOf(accepted, faceId).added;
    expect(added?.characters).toEqual([0xe9]);
    expect(added?.provenance).toMatchObject({ strategy: "procedural" });
  });
});
