import { beforeAll, describe, expect, it } from "vitest";
import type { GlyphDraft } from "~/generation/draft";
import { evaluateGlyph } from "~/generation/evaluation/evaluate";
import { isCorrectable } from "~/generation/evaluation/evaluation";
import {
  type HeightModel,
  latinHeightModel,
  uniformHeightModel,
} from "~/generation/normalise/height-model";
import { planCharacters } from "~/generation/plan/plan";
import { refineGlyph } from "~/generation/refinement/refine";
import {
  analyseStyle,
  type StyleReference,
} from "~/generation/style/reference";
import { reverseContour } from "~/generation/vector/direction";
import {
  type Outline,
  outlineBounds,
  transformOutline,
  translateOutline,
} from "~/typeface/outline";
import { withoutCharacters } from "./helpers/faces";
import { fixtureFace, glyphOf } from "./helpers/glyphs";

const lato = fixtureFace("lato");
const code = (character: string) => character.codePointAt(0) ?? 0;

describe("evaluation", () => {
  let style: StyleReference;
  let heights: HeightModel;

  beforeAll(() => {
    style = analyseStyle(lato);
    heights = latinHeightModel(style);
  });

  const zoneFor = (character: string) => {
    const hidden = withoutCharacters(lato, [code(character)]);
    const target = planCharacters(hidden, [code(character)]).targets.at(-1);
    return target && heights(target);
  };

  const draftOf = (character: string, outline?: Outline): GlyphDraft => {
    const glyph = glyphOf(lato, character);
    return {
      advance: glyph.advance,
      key: character,
      madeBy: "The face's own glyph, used as a test subject.",
      outline: outline ?? glyph.outline,
      weaknesses: [],
    };
  };

  const judge = (draft: GlyphDraft, character = draft.key) =>
    evaluateGlyph(draft, { style, zone: zoneFor(character) });

  const kinds = (draft: GlyphDraft) =>
    judge(draft).defects.map((defect) => defect.kind);

  it("passes the face's own letters, figures and punctuation", () => {
    // The tolerances are only worth something if the glyphs that define the
    // style pass them.
    const own = [
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789éñüçÅ.,;:!?&@",
    ];
    const failing = own.filter(
      (character) => judge(draftOf(character)).verdict !== "pass"
    );
    expect(failing).toEqual([]);
  });

  it("reports each style check as a measured value with a tolerance", () => {
    const evaluation = judge(draftOf("n"));
    expect(evaluation.styleChecks.map((check) => check.name)).toEqual([
      "stem thickness",
      "top of a lowercase",
      "foot of a lowercase",
      "left sidebearing beside a straight edge",
      "right sidebearing beside a straight edge",
      "ink density",
    ]);
    const [stem] = evaluation.styleChecks;
    expect(stem?.pass).toBe(true);
    expect(stem?.expected).toBeCloseTo(style.stems.vertical);
    expect(stem?.tolerance).toBeCloseTo(0.2 * style.stems.vertical);
    expect(
      Math.abs((stem?.measured ?? 0) - (stem?.expected ?? 0))
    ).toBeLessThan(stem?.tolerance ?? 0);
    expect(evaluation.scores).toMatchObject({ geometry: 1, style: 1 });
  });

  it("fails an outline with coordinates that are not numbers", () => {
    const broken = transformOutline(glyphOf(lato, "n").outline, {
      dx: Number.NaN,
      dy: 0,
      xx: 1,
      xy: 0,
      yx: 0,
      yy: 1,
    });
    const evaluation = judge(draftOf("n", broken));
    expect(evaluation.verdict).toBe("fail");
    expect(evaluation.defects.map((defect) => defect.kind)).toEqual([
      "not-finite",
    ]);
    expect(evaluation.defects.some(isCorrectable)).toBe(false);
  });

  it("fails an empty outline", () => {
    expect(judge(draftOf("n", { contours: [] })).verdict).toBe("fail");
  });

  it("catches a counter that runs the same way as its shape, and refinement turns it", () => {
    const { contours } = glyphOf(lato, "O").outline;
    const [outer, counter] = contours;
    const filled: Outline = {
      contours: outer && counter ? [outer, reverseContour(counter)] : [],
    };
    const draft = draftOf("O", filled);
    const evaluation = judge(draft);
    expect(evaluation.defects.map((defect) => defect.kind)).toContain(
      "direction"
    );
    // With the counter filled in, the O is also far too dense.
    expect(evaluation.defects.map((defect) => defect.kind)).toContain(
      "ink-density"
    );
    const refined = refineGlyph(draft, evaluation, {
      style,
      zone: zoneFor("O"),
    });
    expect(refined.applied).toEqual(["fix-direction"]);
    expect(judge(refined.draft).verdict).toBe("pass");
  });

  it("does not mistake overlapping strokes for misdirected counters", () => {
    // Sofia Sans is drawn with overlapping contours: the bar of its A is a
    // separate contour laid across the legs, running the same way they do.
    const sofia = fixtureFace("sofia");
    const glyph = glyphOf(sofia, "A");
    expect(glyph.outline.contours).toHaveLength(2);
    const evaluation = evaluateGlyph(
      { ...draftOf("n"), advance: glyph.advance, outline: glyph.outline },
      { style: analyseStyle(sofia) }
    );
    expect(evaluation.defects.map((defect) => defect.kind)).not.toContain(
      "direction"
    );
  });

  it("catches debris, an open contour and too many points", () => {
    const { outline } = glyphOf(lato, "n");
    const speck: Outline = {
      contours: [
        ...outline.contours,
        {
          segments: [
            { kind: "line", to: { x: 1204, y: 400 } },
            { kind: "line", to: { x: 1204, y: 404 } },
          ],
          start: { x: 1200, y: 400 },
        },
      ],
    };
    const dusty = draftOf("n", speck);
    expect(kinds(dusty)).toContain("debris");
    const cleaned = refineGlyph(dusty, judge(dusty), {
      style,
      zone: zoneFor("n"),
    });
    expect(cleaned.applied).toContain("remove-debris");
    expect(cleaned.draft.outline.contours).toHaveLength(
      outline.contours.length
    );

    const [first] = outline.contours;
    const open: Outline = {
      contours: first
        ? [{ segments: first.segments.slice(0, -1), start: first.start }]
        : [],
    };
    expect(kinds(draftOf("n", open))).toContain("open-contour");

    const jagged: Outline = {
      contours: [
        {
          segments: Array.from({ length: 400 }, (_, index) => ({
            kind: "line" as const,
            to: {
              x: 500 + 400 * Math.cos((index + 1) * 0.0157),
              y: 500 + 400 * Math.sin((index + 1) * 0.0157),
            },
          })),
          start: { x: 900, y: 500 },
        },
      ],
    };
    const pointCount = judge(draftOf("o", jagged)).defects.find(
      (defect) => defect.kind === "point-count"
    );
    expect(pointCount).toBeDefined();
    expect(pointCount && isCorrectable(pointCount)).toBe(false);
  });

  it("catches wrong heights and spacing, and refinement refits and respaces", () => {
    const { outline } = glyphOf(lato, "x");
    const oversized = draftOf(
      "x",
      translateOutline(
        transformOutline(outline, {
          dx: 0,
          dy: 0,
          xx: 1.3,
          xy: 0,
          yx: 0,
          yy: 1.3,
        }),
        400,
        -90
      )
    );
    const evaluation = judge(oversized);
    expect(evaluation.verdict).toBe("review");
    // Scaled up by 30% and moved, the glyph is wrong in several ways at once.
    // Heights and spacing have corrections. Stem weight and density have
    // none of their own, and come right once the height is refitted.
    expect(
      evaluation.defects.map((defect) => [defect.kind, isCorrectable(defect)])
    ).toEqual([
      ["stem-thickness", false],
      ["heights", true],
      ["heights", true],
      ["spacing", true],
      ["spacing", true],
      ["ink-density", false],
    ]);
    const refined = refineGlyph(oversized, evaluation, {
      style,
      zone: zoneFor("x"),
    });
    expect(refined.applied).toEqual(["refit-heights", "respace"]);
    const bounds = outlineBounds(refined.draft.outline);
    expect(bounds?.yMin).toBe(0);
    expect(bounds?.yMax).toBe(Math.round(style.metrics.xHeight));
    expect(judge(refined.draft).verdict).toBe("pass");
  });

  it("catches ink outside the face's vertical metrics", () => {
    const tall = draftOf(
      "n",
      translateOutline(glyphOf(lato, "n").outline, 0, 1400)
    );
    expect(
      evaluateGlyph(tall, { style }).defects.map((defect) => defect.kind)
    ).toContain("outside-metrics");
  });

  it("takes its lines from the height model it is given", () => {
    // A script with one hanging line: every letter between 0 and 622.
    const devanagari = fixtureFace("devanagari");
    const model = uniformHeightModel({
      bottom: 0,
      name: "Devanagari letter",
      top: 622,
    });
    const [target] = planCharacters(
      withoutCharacters(devanagari, [0x09_15]),
      [0x09_15]
    ).targets;
    const ka = devanagari.glyph(devanagari.glyphForCharacter(0x09_15) ?? 0);
    const evaluation = evaluateGlyph(
      {
        advance: ka.advance,
        key: "ka",
        madeBy: "The face's own glyph, used as a test subject.",
        outline: ka.outline,
        weaknesses: [],
      },
      {
        style: analyseStyle(devanagari, {
          characters: [0x09_15, 0x09_16, 0x09_17, 0x09_18, 0x09_1a, 0x09_1c],
        }),
        zone: target && model(target),
      }
    );
    const heightChecks = evaluation.styleChecks.filter((check) =>
      check.name.includes("Devanagari letter")
    );
    expect(heightChecks.map((check) => check.pass)).toEqual([true, true]);
  });

  it("scores a holdout by shape agreement, aligned and in place", () => {
    const glyph = glyphOf(lato, "a");
    const shifted = {
      ...draftOf("a"),
      outline: translateOutline(glyph.outline, 60, 0),
    };
    const evaluation = evaluateGlyph(shifted, { holdout: glyph, style });
    expect(evaluation.scores.shape).toBeGreaterThan(0.98);
    expect(evaluation.scores.shapeInPlace).toBeLessThan(0.8);
  });
});
