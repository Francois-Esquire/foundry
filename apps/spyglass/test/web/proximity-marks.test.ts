import { describe, expect, it } from "vitest";
import type { SpyglassData, Territory } from "../../src/web/data/types";
import { closeMark, inks } from "../../src/web/ladder/ink-ladder";
import { inkStyle } from "../../src/web/ladder/ink-table";
import {
  alphaAt,
  type Glyph,
  type Mark,
  type Stroke,
} from "../../src/web/layout/marks";
import { proximityMarks } from "../../src/web/layout/proximity-marks";
import { singleFrame, withReadings } from "../helpers/frames";

/** A square ring from −half to half. */
const box = (half: number): [number, number][] => [
  [-half, -half],
  [half, -half],
  [half, half],
  [-half, half],
  [-half, -half],
];

const island: Territory = {
  analyzed: true,
  coast: [[box(40)]],
  fileRoles: undefined,
  files: ["one", "two", "shore"].map((id, index) => ({
    directory: index === 2 ? "src/b" : "src/a",
    highFanIn: false,
    id,
    incoming: 0,
    internalFanIn: 0,
    kind: "source",
    outgoing: 0,
    path: `src/${index === 2 ? "b" : "a"}/${id}.ts`,
    // "shore" lies past the coast.
    x: index === 2 ? 60 : index * 30 - 30,
    y: 0,
  })),
  folder: "",
  highFanInCutoff: 0,
  hills: [],
  id: "island",
  label: "Island",
  radius: 80,
  responsibilityGroups: undefined,
  shallows: [],
  x: 200,
  y: 100,
};

const data: SpyglassData = {
  coverage: "test",
  fileEdges: [],
  folderCells: {},
  frames: [singleFrame(["island"])],
  height: 500,
  packageLayers: {},
  routes: [],
  territories: [island],
  width: 500,
};

const coChange = (left: string, right: string) => ({
  coChangeCommits: 4,
  distance: 1,
  id: `${left}|${right}`,
  jaccard: 0.5,
  left,
  right,
  scope: "same-package" as const,
  staticPath: "none" as const,
});

const strokes = (marks: readonly Mark[]) =>
  marks.filter((mark): mark is Stroke => mark.kind === "stroke");
const glyphs = (marks: readonly Mark[]) =>
  marks.filter((mark): mark is Glyph => mark.kind === "glyph");

describe("proximity marks", () => {
  it("ties files that change together with a dashed line and a bead at each end, from island zoom only", () => {
    const related = withReadings(data, {
      proximity: {
        apart: {
          coChanges: [coChange("src/a/one.ts", "src/a/two.ts")],
          files: [],
        },
        close: [],
        labelled: ["island"],
      },
    });
    const marks = proximityMarks(related, null);
    expect(marks.every((mark) => mark.on === island)).toBe(true);
    const [tie] = strokes(marks);
    const pen = inkStyle("proximity-co-change");
    expect(tie).toMatchObject({
      cap: "round",
      colour: inks.proximity,
      dash: pen.dash,
      points: [170, 100, 200, 100],
      width: pen.weight,
    });
    const beads = glyphs(marks);
    expect(beads.map((bead) => [bead.shape, bead.x])).toEqual([
      ["dot", 170],
      ["dot", 200],
    ]);
    expect(beads[0]?.size).toBe(3.6);
    // The overview stays the departures'.
    expect(alphaAt(tie?.alpha ?? 0, 1)).toBe(0);
    expect(alphaAt(tie?.alpha ?? 0, 2.2)).toBe(1);
    expect(beads[0]?.alpha).toBe(tie?.alpha);
  });

  it("cuts a tie to the land and drops the bead that falls off it", () => {
    const related = withReadings(data, {
      proximity: {
        apart: {
          coChanges: [coChange("src/a/one.ts", "src/b/shore.ts")],
          files: [],
        },
        close: [],
        labelled: ["island"],
      },
    });
    const marks = proximityMarks(related, null);
    const [tie] = strokes(marks);
    expect(tie?.points).toEqual([170, 100, 240, 100]);
    expect(glyphs(marks).map((bead) => bead.x)).toEqual([170]);
  });

  it("marks a close folder with the ( ) glyph, round on screen, where its centroid lies on land", () => {
    const close = withReadings(data, {
      proximity: {
        apart: { coChanges: [], files: [] },
        close: [
          {
            folder: "src/a",
            groups: [
              { apart: [], files: ["src/a/one.ts"], responsibilities: ["a"] },
              { apart: [], files: ["src/a/one.ts"], responsibilities: ["b"] },
            ],
            package: "island",
            unresolved: 0,
          },
          {
            folder: "src/b",
            groups: [],
            package: "island",
            unresolved: 0,
          },
        ],
        labelled: ["island"],
      },
    });
    const marks = glyphs(proximityMarks(close, null));
    const sides = inkStyle("proximity-close");
    // src/b holds only "shore", past the coast: no mark there.
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({
      colour: sides.hue,
      shape: "closeMark",
      size: 2 * closeMark.radius,
      upright: true,
      weight: sides.weight,
      x: 185,
      y: 100,
    });
  });
});
