import { describe, expect, it } from "vitest";
import type { Territory } from "../../src/web/data/types";
import { inkStyle, inks } from "../../src/web/ladder/ink-ladder";
import { focusMarks } from "../../src/web/layout/focus-marks";

const island: Territory = {
  analyzed: true,
  coast: [],
  fileRoles: undefined,
  files: [
    {
      directory: "src",
      highFanIn: false,
      id: "one",
      incoming: 0,
      internalFanIn: 0,
      kind: "source",
      outgoing: 0,
      path: "src/one.ts",
      x: 12,
      y: -8,
    },
  ],
  folder: "",
  highFanInCutoff: 0,
  hills: [],
  id: "island",
  label: "Island",
  radius: 40,
  responsibilityGroups: undefined,
  shallows: [],
  x: 100,
  y: 50,
};

describe("focus marks", () => {
  it("rings the selected file with a paper halo under the selection's ring and a square at its centre, round on screen", () => {
    const marks = focusMarks([island], "island", "one");
    expect(marks).toHaveLength(3);
    for (const mark of marks) {
      expect(mark).toMatchObject({
        alpha: 1,
        on: island,
        upright: true,
        x: 112,
        y: 42,
      });
    }
    const [halo, ring, centre] = marks;
    expect(halo).toMatchObject({
      colour: inks.focusHalo,
      shape: "hoop",
      size: 18,
      weight: inkStyle("focus-halo").weight,
    });
    expect(ring).toMatchObject({
      colour: inks.selection,
      shape: "hoop",
      size: 18,
      weight: 2,
    });
    expect(centre).toMatchObject({
      colour: inks.selection,
      shape: "square",
      size: 4,
    });
  });

  it("draws nothing without a selected file on the selected island", () => {
    expect(focusMarks([island], "island", null)).toEqual([]);
    expect(focusMarks([island], "other", "one")).toEqual([]);
    expect(focusMarks([island], "island", "missing")).toEqual([]);
  });
});
