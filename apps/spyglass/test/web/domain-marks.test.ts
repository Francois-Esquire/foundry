import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import type { SpyglassData, Territory } from "../../src/web/data/types";
import { domainMark, inkStyle, inks } from "../../src/web/ladder/ink-ladder";
import { domainExtent } from "../../src/web/layout/domain-extent";
import { domainMarks, toCoast } from "../../src/web/layout/domain-marks";
import { settleFiles } from "../../src/web/layout/folder-sectors";
import type { Glyph, Mark, Stroke } from "../../src/web/layout/marks";
import { singleFrame, withReadings } from "../helpers/frames";

const coast: [number, number][] = [
  [-80, -80],
  [80, -80],
  [80, 80],
  [-80, 80],
  [-80, -80],
];
const files = [
  "pkg/src/web/a.ts",
  "pkg/src/web/b.ts",
  "pkg/src/lib/c.ts",
  "pkg/src/lib/d.ts",
].map((path, i) => ({
  directory: path.slice(0, path.lastIndexOf("/")),
  highFanIn: false,
  id: path,
  incoming: 0,
  internalFanIn: 0,
  kind: "source",
  outgoing: 0,
  path,
  x: i * 10 - 15,
  y: 0,
}));
const island: Territory = {
  analyzed: true,
  coast: [[coast]],
  fileRoles: undefined,
  files,
  folder: "pkg",
  highFanInCutoff: 0,
  hills: [],
  id: "island",
  label: "Island",
  radius: 80,
  responsibilityGroups: undefined,
  shallows: [],
  x: 300,
  y: 200,
};
const base: SpyglassData = {
  coverage: "test",
  fileEdges: [],
  folderCells: { island: settleFiles(files, 80, "pkg") },
  frames: [singleFrame(["island"])],
  height: 500,
  packageLayers: {},
  routes: [],
  territories: [island],
  width: 500,
};

const declaring = (places: { kind: "file" | "folder"; place: string }[]) =>
  withReadings(base, {
    domains: {
      declared: [{ name: "shapes", parents: [], places, unmatched: [] }],
      placements: {},
    },
  });

const strokes = (marks: readonly Mark[]) =>
  marks.filter((mark): mark is Stroke => mark.kind === "stroke");
const glyphs = (marks: readonly Mark[]) =>
  marks.filter((mark): mark is Glyph => mark.kind === "glyph");

describe("domain marks", () => {
  it("bands the covered cells inside the coast at the ladder's weight and dash, and frames the file named alone", () => {
    const data = declaring([
      { kind: "folder", place: "pkg/src/lib" },
      { kind: "file", place: "pkg/src/web/a.ts" },
    ]);
    const extent = domainExtent(data, { frame: "", name: "shapes" });
    const marks = domainMarks(data, extent, null);
    const band = strokes(marks);
    expect(band.length).toBeGreaterThan(0);
    const pen = inkStyle("domain-outline");
    const tree = data.folderCells.island;
    assert(tree);
    const lib = tree.folders[0]?.folders.find(
      (cell) => cell.folder === "src/lib"
    )?.region;
    assert(lib);
    const box = tree.region;
    const reach = toCoast(lib, box, island.radius * 2);
    for (const stroke of band) {
      expect(stroke).toMatchObject({
        cap: "butt",
        colour: inks.domain,
        dash: pen.dash,
        on: island,
        width: pen.weight,
      });
      for (let i = 0; i + 1 < stroke.points.length; i += 2) {
        const x = (stroke.points[i] ?? 0) - island.x;
        const y = (stroke.points[i + 1] ?? 0) - island.y;
        // Inside the coast and inside the cell's reach, within rounding.
        expect(Math.abs(x)).toBeLessThanOrEqual(80 + 1e-6);
        expect(Math.abs(y)).toBeLessThanOrEqual(80 + 1e-6);
        expect(x).toBeGreaterThanOrEqual(reach.x0 - 1e-6);
        expect(x).toBeLessThanOrEqual(reach.x1 + 1e-6);
        expect(y).toBeGreaterThanOrEqual(reach.y0 - 1e-6);
        expect(y).toBeLessThanOrEqual(reach.y1 + 1e-6);
      }
    }
    // A stretch of the band runs along the coast where the cell reaches it.
    expect(
      band.some((stroke) =>
        stroke.points.some((value, i) => i % 2 === 0 && value - island.x === 80)
      ) ||
        band.some((stroke) =>
          stroke.points.some(
            (value, i) => i % 2 === 1 && value - island.y === 80
          )
        )
    ).toBe(true);
    const [square] = glyphs(marks);
    const filePen = inkStyle("domain-file");
    // Settling moved the files; the square sits where the named one settled.
    const named = island.files.find((file) => file.path === "pkg/src/web/a.ts");
    expect(glyphs(marks)).toHaveLength(1);
    expect(square).toMatchObject({
      colour: inks.domain,
      on: island,
      shape: "frame",
      size: 2 * domainMark.fileSquare + filePen.weight,
      upright: true,
      weight: filePen.weight,
      x: island.x + (named?.x ?? 0),
      y: island.y + (named?.y ?? 0),
    });
    // The same extent on a rebuild hands the renderer the same polylines.
    expect(strokes(domainMarks(data, extent, null))[0]?.points).toBe(
      band[0]?.points
    );
  });

  it("draws nothing without a chosen domain, nor on an island rearranged by responsibility", () => {
    const data = declaring([{ kind: "folder", place: "pkg/src/lib" }]);
    expect(domainMarks(data, null, null)).toEqual([]);
    const rearranged = { ...island, files: files.map((f) => ({ ...f })) };
    expect(
      domainMarks(data, domainExtent(data, { frame: "", name: "shapes" }), {
        territory: rearranged,
      })
    ).toEqual([]);
  });

  it("bands the whole coast of a package covered whole and sets a diamond inside its southern point", () => {
    const data = declaring([{ kind: "folder", place: "pkg" }]);
    const extent = domainExtent(data, { frame: "", name: "shapes" });
    expect(extent?.islands[0]?.whole).toBe(true);
    const marks = domainMarks(data, extent, null);
    const [ring] = strokes(marks);
    expect(strokes(marks)).toHaveLength(1);
    expect(ring?.points).toHaveLength(coast.length * 2);
    expect(ring?.points.slice(0, 2)).toEqual([island.x - 80, island.y - 80]);
    const [diamond] = glyphs(marks);
    expect(diamond).toMatchObject({
      colour: inkStyle("domain-package").hue,
      offset: [0, -domainMark.inset],
      shape: "diamond",
      size: 2 * domainMark.diamond,
      x: island.x + 80,
      y: island.y + 80,
    });
    // Whole, the island keeps its marks even when rearranged.
    expect(
      domainMarks(data, extent, {
        territory: { ...island, files: files.map((f) => ({ ...f })) },
      })
    ).toHaveLength(2);
  });
});
