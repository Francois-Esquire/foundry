import { describe, expect, it } from "vitest";
import type { SpyglassData, Territory } from "../../src/web/data/types";
import { enteredAt, inkStyle, inks } from "../../src/web/ladder/ink-ladder";
import {
  dependencyLinks,
  nearestCoast,
  seaCurve,
  seaCurvePoints,
} from "../../src/web/layout/dependency-links";
import { alphaAt } from "../../src/web/layout/marks";
import { insidePolygons } from "../../src/web/layout/polygons";
import { selectionMarks } from "../../src/web/layout/selection-marks";
import {
  selectionOffset,
  selectionRing,
} from "../../src/web/layout/selection-ring";
import { singleFrame } from "../helpers/frames";

const square = (half: number): Territory["coast"] => [
  [
    [
      [-half, -half],
      [half, -half],
      [half, half],
      [-half, half],
      [-half, -half],
    ],
  ],
];
const island = (id: string, x: number): Territory => ({
  analyzed: true,
  coast: square(20),
  fileRoles: undefined,
  files: [],
  folder: "",
  highFanInCutoff: 0,
  hills: [],
  id,
  label: id,
  radius: 20,
  responsibilityGroups: undefined,
  shallows: [],
  x,
  y: 0,
});
const data: SpyglassData = {
  coverage: "test",
  fileEdges: [],
  folderCells: {},
  frames: [singleFrame([])],
  height: 400,
  packageLayers: {},
  routes: [
    {
      consumerFiles: [],
      from: "a",
      sharedConcepts: 0,
      supplierFiles: [],
      to: "b",
      weight: 9,
    },
    {
      consumerFiles: [],
      from: "c",
      sharedConcepts: 0,
      supplierFiles: [],
      to: "a",
      weight: 2,
    },
    {
      consumerFiles: [],
      from: "b",
      sharedConcepts: 0,
      supplierFiles: [],
      to: "c",
      weight: 4,
    },
  ],
  territories: [island("a", 0), island("b", 150), island("c", -150)],
  width: 600,
};

describe("selection ring and links", () => {
  it("surrounds the selected island just offshore of its own coast", () => {
    const [territory] = data.territories;
    if (!territory) {
      throw new Error("Missing island");
    }
    const rings = selectionRing(territory);
    expect(rings).toHaveLength(1);
    for (const [x, y] of rings[0] ?? []) {
      expect(insidePolygons({ x, y }, territory.coast)).toBe(false);
      const outside = Math.max(Math.abs(x), Math.abs(y)) - 20;
      // Corners round off; along the sides the ring keeps its offset.
      expect(outside).toBeGreaterThan(selectionOffset - 2);
      expect(outside).toBeLessThan(selectionOffset + 1);
    }
    expect(selectionRing(territory)).toBe(rings);
  });

  it("links only the selected package, marking imports and dependents", () => {
    const links = dependencyLinks(data, "a");
    expect(
      links.map((link) => [link.route.from, link.route.to, link.outgoing])
    ).toEqual([
      ["a", "b", true],
      ["c", "a", false],
    ]);
    for (const link of links) {
      for (const [x, y] of [link.start, link.end]) {
        for (const territory of data.territories) {
          expect(
            insidePolygons(
              { x: x - territory.x, y: y - territory.y },
              territory.coast
            )
          ).toBe(false);
        }
      }
    }
    // Lines start at the selected island and end at the other package.
    expect(links[0]?.start[0]).toBeLessThan(links[0]?.end[0] ?? 0);
    expect(links[1]?.start[0]).toBeGreaterThan(links[1]?.end[0] ?? 0);
    expect(dependencyLinks(data, "a")).toBe(links);
  });

  it("finds the coast point nearest a point, for a line that leaves from land", () => {
    const [, b] = data.territories;
    expect(b && nearestCoast([0, 0], b)).toEqual([130, -20]);
  });

  it("bows a sea curve sideways and holds each end back by its own clearance", () => {
    const curve = seaCurve([0, 0], [100, 0], { end: 7, start: 0 });
    expect(curve.start).toEqual([0, 0]);
    expect(curve.end).toEqual([93, 0]);
    // The middle bows by 0.12 of the length between the held-back ends.
    expect(curve.control[0]).toBeCloseTo(46.5);
    expect(curve.control[1]).toBeCloseTo(0.12 * 93);
  });

  it("flattens a sea curve to a polyline from its start to its end, kept by the curve", () => {
    const curve = seaCurve([0, 0], [100, 0], { end: 7, start: 0 });
    const points = seaCurvePoints(curve);
    expect(points.slice(0, 2)).toEqual([0, 0]);
    expect(points.slice(-2)).toEqual([93, 0]);
    expect(points.length / 2).toBe(21);
    // The middle of the polyline lies on the bowed side of the chord.
    expect(points[21]).toBeCloseTo(0.12 * 93 * 0.5);
    expect(seaCurvePoints(curve)).toBe(points);
  });
});

describe("selection marks", () => {
  it("draws nothing without a selection, and the ring and lines for one", () => {
    expect(selectionMarks(data, null)).toEqual([]);
    const marks = selectionMarks(data, "a");
    const strokes = marks.filter((mark) => mark.kind === "stroke");
    const beads = marks.filter((mark) => mark.kind === "glyph");
    // Two lines, and the ring laid twice: once for overview, once entered.
    expect(strokes).toHaveLength(4);
    expect(beads).toHaveLength(2);
    expect(marks.every((mark) => mark.on === undefined)).toBe(true);
    expect(beads.every((bead) => bead.shape === "dot")).toBe(true);
    expect(beads.every((bead) => bead.colour === inks.selection)).toBe(true);
  });

  it("dashes the imports and dots the dependents, weighted by the route, in the selection's ink", () => {
    const [imports, importers] = selectionMarks(data, "a").filter(
      (mark) => mark.kind === "stroke"
    );
    expect(imports?.dash).toEqual(inkStyle("selection-imports").dash);
    expect(importers?.dash).toEqual(inkStyle("selection-importers").dash);
    expect(imports?.colour).toBe(inks.selection);
    // The strongest route takes the widest pen.
    expect(imports?.width).toBe(1.8);
    expect(importers?.width ?? 0).toBeLessThan(1.8);
    expect(importers?.width ?? 0).toBeGreaterThan(0.9);
    const [link] = dependencyLinks(data, "a");
    expect(link && imports?.points).toBe(link && seaCurvePoints(link));
  });

  it("shows the ring in the selection's ink at overview and the entered ring's once entered", () => {
    const rings = selectionMarks(data, "a")
      .filter((mark) => mark.kind === "stroke")
      .slice(2);
    const [overview, entered] = rings;
    expect(overview?.colour).toBe(inks.selection);
    expect(overview?.width).toBe(inkStyle("selection").weight);
    expect(entered?.colour).toBe(inks.enteredRing);
    expect(entered?.width).toBe(inkStyle("entered-ring").weight);
    expect(alphaAt(overview?.alpha ?? 0, enteredAt - 0.1)).toBe(1);
    expect(alphaAt(overview?.alpha ?? 0, enteredAt)).toBe(0);
    expect(alphaAt(entered?.alpha ?? 0, enteredAt - 0.1)).toBe(0);
    expect(alphaAt(entered?.alpha ?? 0, enteredAt)).toBe(1);
    expect(overview?.points).toBe(entered?.points);
    // The same selection hands the renderer the same polylines.
    expect(
      selectionMarks(data, "a").filter((mark) => mark.kind === "stroke")[2]
        ?.points
    ).toBe(overview?.points);
  });
});
