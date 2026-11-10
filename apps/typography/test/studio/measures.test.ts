import { describe, expect, it } from "vitest";
import { withLeftBearing } from "~/studio/bearings";
import { isChanged, measureRows } from "~/studio/measures";
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

  it("tells a value the project changed from one that is still the source font's", () => {
    const rows = measureRows(SOURCE, withLeftBearing(SOURCE, 70));
    expect(rows.map((row) => [row.name, isChanged(row)])).toEqual([
      ["Advance", true],
      ["Left bearing", true],
      ["Right bearing", false],
      ["Points", false],
    ]);
    expect(measureRows(SOURCE, SOURCE).some(isChanged)).toBe(false);
  });

  it("counts every value of a glyph the project added as changed", () => {
    expect(measureRows(undefined, SOURCE).every(isChanged)).toBe(true);
  });

  it("has no bearings for a glyph with nothing drawn", () => {
    const space: GlyphShape = { advance: 250, outline: EMPTY_OUTLINE };
    const [, left] = measureRows(space, space);
    expect(left?.edit).toBeUndefined();
    expect(left?.difference).toBeUndefined();
  });
});
