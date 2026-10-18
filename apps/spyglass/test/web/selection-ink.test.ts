import { describe, expect, it, vi } from "vitest";
import type { SpyglassData, Territory } from "../../src/web/data/types";
import {
  dependencyLinks,
  nearestCoast,
  seaCurve,
} from "../../src/web/layout/dependency-links";
import { insidePolygons } from "../../src/web/layout/polygons";
import {
  selectionOffset,
  selectionRing,
} from "../../src/web/layout/selection-ring";
import { clipToSea } from "../../src/web/scene/selection-ink";
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

describe("selection ink", () => {
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

  it("cuts each name from the sea clip on its own, so no name over land opens the clip again", () => {
    const ctx = {
      beginPath: vi.fn(),
      clip: vi.fn(),
      closePath: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      rect: vi.fn(),
    };
    const label = { caption: "", height: 10, width: 40, x: 0, y: 0 };
    clipToSea(
      ctx as unknown as CanvasRenderingContext2D,
      data,
      [label, { ...label, x: 10 }] as never[],
      1
    );
    // Land first, then one clip per name: evenodd in one path would let a
    // name over land, or two overlapping names, through again.
    expect(ctx.clip).toHaveBeenCalledTimes(3);
    expect(ctx.clip).toHaveBeenCalledWith("evenodd");
  });
});
