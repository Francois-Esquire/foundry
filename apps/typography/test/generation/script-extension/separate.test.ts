import { describe, expect, it } from "vitest";
import type { HeadlineLines } from "~/generation/script-extension/headline-lines";
import { separateSyllable } from "~/generation/script-extension/separate";
import {
  type Bounds,
  type Outline,
  outlineBounds,
  transformOutline,
} from "~/typeface/outline";
import { rectangle } from "./helpers/subset";

const LINES: HeadlineLines = {
  bodyTop: 1000,
  headlineThickness: 150,
  headlineTop: 1150,
  rule: "",
};

const HEADLINE = rectangle(0, 1000, 1000, 1150);
const BASE_STEM = rectangle(300, 0, 450, 1000);
const SIGN_STEM = rectangle(750, 0, 900, 1000);
/** The unit the cuts are good to: a few pixels of the working picture. */
const CLOSE = 8;

const boundsOf = (outline: Outline | undefined): Bounds => {
  const bounds = outline && outlineBounds(outline);
  if (!bounds) {
    throw new Error("The piece has no outline.");
  }
  return bounds;
};

const near = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(CLOSE);

describe("separating the parts of a syllable", () => {
  it("takes a vowel sign after the base with its share of the headline", () => {
    const { failures, pieces } = separateSyllable(
      { contours: [HEADLINE, BASE_STEM, SIGN_STEM] },
      [{ kind: "vowel-sign-after", name: "sign" }],
      LINES
    );
    expect(failures).toEqual([]);
    const bounds = boundsOf(pieces[0]?.outline);
    // The cut runs down the middle of the paper between the two stems.
    near(bounds.xMin, 600);
    near(bounds.xMax, 1000);
    near(bounds.yMin, 0);
    near(bounds.yMax, 1150);
  });

  it("takes a vowel sign before the base with its hook over the headline", () => {
    // A slanted stroke rising to the right: not level, so not a headline.
    const hook: Outline["contours"][number] = {
      segments: [
        { kind: "line", to: { x: 250, y: 1150 } },
        { kind: "line", to: { x: 700, y: 1300 } },
        { kind: "line", to: { x: 550, y: 1300 } },
      ],
      start: { x: 100, y: 1150 },
    };
    const { pieces } = separateSyllable(
      {
        contours: [HEADLINE, rectangle(100, 0, 250, 1000), SIGN_STEM, hook],
      },
      [{ kind: "vowel-sign-before", name: "sign" }],
      LINES
    );
    const bounds = boundsOf(pieces[0]?.outline);
    near(bounds.xMin, 0);
    // The hook reaches past the cut at 500, over the base.
    near(bounds.xMax, 700);
    near(bounds.yMax, 1300);
  });

  it("takes a mark above the headline and records where the base's stem stood", () => {
    const dot = rectangle(420, 1300, 560, 1440);
    const { pieces } = separateSyllable(
      { contours: [HEADLINE, BASE_STEM, dot] },
      [{ kind: "mark-above", name: "dot" }],
      LINES
    );
    const [piece] = pieces;
    const bounds = boundsOf(piece?.outline);
    near(bounds.yMin, 1300);
    near(bounds.xMin, 420);
    // The stem's middle is at 375, which is 45 left of the dot's ink.
    near(piece?.attachment ?? 0, -45);
  });

  it("gives a mark that stands on the headline a tab down into it", () => {
    const flag = rectangle(320, 1150, 430, 1400);
    const { pieces } = separateSyllable(
      { contours: [HEADLINE, BASE_STEM, flag] },
      [{ kind: "mark-above", name: "flag" }],
      LINES
    );
    const bounds = boundsOf(pieces[0]?.outline);
    expect(bounds.yMin).toBeLessThan(1150 - 20);
    expect(bounds.yMin).toBeGreaterThan(1000);
    near(bounds.xMax - bounds.xMin, 110);
  });

  it("takes a mark below the baseline, clear of the base or touching it", () => {
    const clear = separateSyllable(
      { contours: [HEADLINE, BASE_STEM, rectangle(340, -300, 600, -80)] },
      [{ kind: "mark-below", name: "below" }],
      LINES
    );
    near(boundsOf(clear.pieces[0]?.outline).yMax, -80);
    const touching = separateSyllable(
      { contours: [HEADLINE, rectangle(300, -300, 450, 1000)] },
      [{ kind: "mark-below", name: "below" }],
      LINES
    );
    const bounds = boundsOf(touching.pieces[0]?.outline);
    near(bounds.yMin, -300);
    expect(bounds.yMax).toBeLessThan(0);
  });

  it("cuts a half form where the joining stroke meets the known base", () => {
    // A bar from the half form's stem runs into a base whose body starts at 600.
    const { pieces } = separateSyllable(
      {
        contours: [
          HEADLINE,
          rectangle(150, 400, 300, 1000),
          rectangle(150, 400, 700, 550),
          rectangle(600, 0, 950, 700),
        ],
      },
      [{ baseWidth: 400, kind: "half-form", name: "half" }],
      LINES
    );
    const bounds = boundsOf(pieces[0]?.outline);
    near(bounds.xMin, 0);
    near(bounds.xMax, 600);
  });

  it("puts every piece on the model's lines, whatever size the syllable was drawn at", () => {
    const small = transformOutline(
      { contours: [HEADLINE, BASE_STEM, SIGN_STEM] },
      { dx: 40, dy: 0, xx: 0.9, xy: 0, yx: 0, yy: 0.9 }
    );
    const { pieces } = separateSyllable(
      small,
      [{ kind: "vowel-sign-after", name: "sign" }],
      LINES
    );
    const bounds = boundsOf(pieces[0]?.outline);
    near(bounds.yMax, 1150);
    near(bounds.xMax, 1000);
  });

  it("says why when a part cannot be separated", () => {
    const joined = separateSyllable(
      { contours: [HEADLINE, rectangle(300, 0, 900, 1000)] },
      [{ kind: "vowel-sign-after", name: "sign" }],
      LINES
    );
    expect(joined.pieces).toEqual([]);
    expect(joined.failures[0]?.reason).toContain("no clear paper");
    const unknownBase = separateSyllable(
      { contours: [HEADLINE, BASE_STEM] },
      [{ kind: "half-form", name: "half" }],
      LINES
    );
    expect(unknownBase.failures[0]?.reason).toContain("has not been made");
    const noHeadline = separateSyllable(
      { contours: [rectangle(0, 0, 100, 1000)] },
      [{ kind: "mark-above", name: "dot" }],
      LINES
    );
    expect(noHeadline.failures[0]?.reason).toContain("No headline");
  });
});
