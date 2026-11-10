import { beforeAll, describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { boxesOf } from "~/studio/shaped-boxes";
import { EMPTY_WORKING_FACE, sourceGlyph } from "~/typeface/changes";
import type { OpenFace } from "~/typeface/reading";
import { type SetLine, setText } from "~/typeface/typesetting";
import { fontBytes } from "../helpers/fixtures";

const boxes = (face: OpenFace, text: string, features = {}) =>
  boxesOf(text, setText(text, face, EMPTY_WORKING_FACE, { features }));

describe("a shaped run as boxes", () => {
  let lato: OpenFace;
  let devanagari: OpenFace;

  beforeAll(() => {
    lato = harfBuzzReader.open(fontBytes("lato"));
    devanagari = harfBuzzReader.open(fontBytes("devanagari"));
  });

  it("gives one box per glyph, laid end to end", () => {
    const run = boxes(lato, "an");
    expect(run.map((box) => box.text)).toEqual(["a", "n"]);
    expect(run.map((box) => box.clusterNumber)).toEqual([1, 2]);
    expect(run[0]?.x).toBe(0);
    expect(run[1]?.x).toBe(run[0]?.advance);
    expect(run.every((box) => box.clusterStart)).toBe(true);
  });

  it("shows a ligature as one box that holds both characters", () => {
    const run = boxes(lato, "fin");
    expect(run.map((box) => box.text)).toEqual(["fi", "n"]);
    expect(run.map((box) => box.cluster)).toEqual([0, 2]);
  });

  it("splits the ligature when its feature is switched off", () => {
    expect(boxes(lato, "fin", { liga: false }).map((box) => box.text)).toEqual([
      "f",
      "i",
      "n",
    ]);
  });

  it("keeps the glyphs of one syllable in one cluster", () => {
    // कि: the vowel sign is typed second and drawn first.
    const run = boxes(devanagari, "किन");
    expect(run).toHaveLength(3);
    expect(run.map((box) => box.text)).toEqual(["कि", "कि", "न"]);
    expect(run.map((box) => box.clusterStart)).toEqual([true, false, true]);
    expect(run.map((box) => box.clusterNumber)).toEqual([1, 1, 2]);
  });

  it("reports how far a glyph sits from the pen", () => {
    const line: SetLine = {
      direction: "ltr",
      glyphs: [
        {
          advance: 500,
          cluster: 0,
          missing: false,
          outline: { contours: [] },
          ref: sourceGlyph(4),
          x: 0,
          y: 0,
        },
        {
          advance: 0,
          cluster: 0,
          missing: false,
          outline: { contours: [] },
          ref: sourceGlyph(9),
          x: 380,
          y: 120,
        },
      ],
      width: 500,
    };
    const [, mark] = boxesOf("é", line);
    expect(mark).toMatchObject({ x: 500, xOffset: -120, yOffset: 120 });
  });

  it("marks a character the face cannot draw", () => {
    const [box] = boxes(lato, "क");
    expect(box?.missing).toBe(true);
  });
});
