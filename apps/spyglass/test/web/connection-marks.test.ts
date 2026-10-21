import { describe, expect, it } from "vitest";
import type { SpyglassFile, Territory } from "../../src/web/data/types";
import { inkStyle } from "../../src/web/ladder/ink-table";
import { connectionMarks } from "../../src/web/layout/connection-marks";

const file = (id: string, x: number): SpyglassFile => ({
  directory: "src",
  highFanIn: false,
  id,
  incoming: 0,
  internalFanIn: 0,
  kind: "source",
  outgoing: 0,
  path: `src/${id}.ts`,
  x,
  y: 0,
});

const island = (id: string, x: number, files: SpyglassFile[]): Territory => ({
  analyzed: true,
  coast: [],
  fileRoles: undefined,
  files,
  folder: "",
  highFanInCutoff: 0,
  hills: [],
  id,
  label: id,
  radius: 40,
  responsibilityGroups: undefined,
  shallows: [],
  x,
  y: 20,
});

const data = {
  fileEdges: [
    { source: "a", target: "b" },
    { source: "c", target: "a" },
    { source: "c", target: "b" },
    { source: "a", target: "missing" },
  ],
  territories: [
    island("west", 0, [file("a", 5)]),
    island("east", 300, [file("b", -5), file("c", 5)]),
  ],
};

describe("connection marks", () => {
  it("draws the selected file's imports both ways as dashed lines draped on the chart", () => {
    const marks = connectionMarks(data, "a");
    const traced = inkStyle("traced-import");
    expect(marks).toHaveLength(2);
    for (const mark of marks) {
      expect(mark).toMatchObject({
        alpha: 0.73,
        colour: traced.hue,
        dash: traced.dash,
        kind: "stroke",
        on: "chart",
        width: traced.weight,
      });
    }
    expect(marks[0]?.points).toEqual([5, 20, 295, 20]);
    expect(marks[1]?.points).toEqual([305, 20, 5, 20]);
  });

  it("draws nothing without a selected file", () => {
    expect(connectionMarks(data, null)).toEqual([]);
  });
});
