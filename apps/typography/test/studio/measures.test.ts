import { describe, expect, it } from "vitest";
import { withLeftBearing } from "~/studio/bearings";
import { measureRows } from "~/studio/measures";
import { EMPTY_OUTLINE } from "~/typeface/outline";
import type { GlyphShape } from "~/typeface/reading";
import { TRIANGLE } from "../helpers/fixtures";

const SOURCE: GlyphShape = { advance: 1000, outline: TRIANGLE };

describe("the measure table", () => {
  it("lists each measure in the source and in the edit, with the difference", () => {
    const rows = measureRows(SOURCE, withLeftBearing(SOURCE, 70));
    expect(rows).toEqual([
      {
        difference: -30,
        edit: 970,
        letter: "A",
        measure: "advance",
        name: "Advance",
        source: 1000,
      },
      {
        difference: -30,
        edit: 70,
        letter: "B",
        measure: "left",
        name: "Left bearing",
        source: 100,
      },
      {
        difference: 0,
        edit: 100,
        letter: "C",
        measure: "right",
        name: "Right bearing",
        source: 100,
      },
      { difference: 0, edit: 3, name: "Points", source: 3 },
    ]);
  });

  it("has no source column for a glyph the project added", () => {
    const [advance] = measureRows(undefined, SOURCE);
    expect(advance).toMatchObject({ edit: 1000 });
    expect(advance?.source).toBeUndefined();
    expect(advance?.difference).toBeUndefined();
  });

  it("has no bearings for a glyph with nothing drawn", () => {
    const space: GlyphShape = { advance: 250, outline: EMPTY_OUTLINE };
    const [, left] = measureRows(space, space);
    expect(left?.edit).toBeUndefined();
    expect(left?.difference).toBeUndefined();
  });
});
