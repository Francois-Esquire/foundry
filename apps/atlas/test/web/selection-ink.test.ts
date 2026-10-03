import { describe, expect, it } from "vitest";
import { insidePolygons } from "../../src/web/atmosphere";
import {
  dependencyLinks,
  selectionOffset,
  selectionRing,
} from "../../src/web/scene/selection-ink";
import type { AtlasData, Territory } from "../../src/web/types";

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
  color: "#fff",
  files: [],
  hills: [],
  id,
  label: id,
  neighborhoods: [],
  radius: 20,
  shallows: [],
  x,
  y: 0,
});
const data: AtlasData = {
  coverage: "test",
  fileEdges: [],
  generatedAt: "test",
  height: 400,
  routes: [
    { from: "a", sharedConcepts: 0, to: "b", weight: 9 },
    { from: "c", sharedConcepts: 0, to: "a", weight: 2 },
    { from: "b", sharedConcepts: 0, to: "c", weight: 4 },
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
});
