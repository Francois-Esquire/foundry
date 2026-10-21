import { describe, expect, it } from "vitest";
import { shoreDistances } from "../../src/lib/visualization/distance-field";
import { archipelagoHull } from "../../src/web/layout/archipelago";
import { oceanField, rimField } from "../../src/web/layout/ocean-field";
import {
  openLevel,
  openSeaSteps,
  shadeLevels,
} from "../../src/web/layout/ocean-shade";
import { insidePolygons } from "../../src/web/layout/polygons";
import { loadSpyglass } from "../helpers/reference-spyglass";

describe("spyglass ocean", () => {
  it("encloses every island in one deterministic archipelago hull", async () => {
    const data = await loadSpyglass();
    const hull = archipelagoHull(data);
    expect(hull.length).toBeGreaterThan(2);
    expect(hull).toEqual(archipelagoHull(data));
    for (const p of data.territories) {
      for (const polygon of p.coast) {
        for (const [x, y] of polygon[0] ?? []) {
          expect(insidePolygons({ x: p.x + x, y: p.y + y }, [[hull]])).toBe(
            true
          );
        }
      }
    }
  });
  it("keeps channels shallower when another island is nearby", () => {
    const one = new Uint8Array(21 * 5);
    one[2 * 21 + 2] = 1;
    const two = one.slice();
    two[2 * 21 + 10] = 1;
    const open = shoreDistances(one, 21, 5);
    const channel = shoreDistances(two, 21, 5);
    expect(channel[2 * 21 + 8]).toBe(2);
    expect(open[2 * 21 + 8]).toBe(6);
    expect(channel[2 * 21 + 6]).toBe(4);
    expect(channel[2 * 21 + 2]).toBe(0);
    expect(channel).toEqual(shoreDistances(two, 21, 5));
    expect(open[4 * 21 + 5]).toBeCloseTo(Math.sqrt(13), 5);
  });
  it("layers open water beyond the rim out to the ocean blue", () => {
    const edge = (openSeaSteps.at(-1) ?? 0) + 40;
    // Inside the rim nothing changes.
    expect(openLevel(0)).toBe(0);
    expect(openLevel(edge)).toBe(1);
    for (let d = 5; d <= edge; d += 5) {
      expect(openLevel(d)).toBeGreaterThanOrEqual(openLevel(d - 5));
    }
    // The open steps are wide washes.
    const [first = 0] = openSeaSteps;
    expect(openLevel(first - 5)).toBeGreaterThan(0);
    expect(openLevel(first - 11)).toBe(0);
  });
  it("shades a field's cells by their distance beyond the silhouette, in the field's order", () => {
    const field = oceanField(
      {
        coverage: "test",
        fileEdges: [],
        folderCells: {},
        frames: [],
        height: 400,
        packageLayers: {},
        routes: [],
        territories: [],
        width: 400,
      },
      100,
      [],
      []
    );
    field.outside.fill(0);
    field.outside[1] = ((openSeaSteps.at(-1) ?? 0) + 40) * field.scale;
    const levels = shadeLevels(field);
    expect(levels).toHaveLength(field.distances.length);
    expect(Array.from(levels.slice(0, 3))).toEqual([0, 1, 0]);
  });
});

describe("the rim field", () => {
  it("measures the distance beyond a rim in cells over its own extent, 0 within", () => {
    // A square rim 20 units wide, centred, on a 40-unit extent at a cell a unit.
    const rim: [number, number][] = [
      [-10, -10],
      [10, -10],
      [10, 10],
      [-10, 10],
    ];
    const field = rimField([[rim]], { height: 40, width: 40 }, 40);
    expect([field.width, field.height, field.scale]).toEqual([40, 40, 1]);
    expect(field.extent).toEqual({ height: 40, width: 40 });
    const at = (x: number, y: number) =>
      field.outside[(y + 20) * field.width + (x + 20)] ?? Number.NaN;
    expect(at(0, 0)).toBe(0);
    expect(at(-9, 5)).toBe(0);
    // The first cell beyond the edge is one cell away, and each unit farther
    // is a cell more.
    expect(at(10, 0)).toBe(1);
    expect(at(12, 0)).toBe(3);
    expect(at(16, 0)).toBe(7);
    expect(at(0, -15)).toBe(5);
    // A silhouette is a terrain contour, already as smooth as the terrain:
    // it is filled as it is, so the corner is the square's own.
    expect(at(13, 13)).toBeCloseTo(Math.hypot(4, 4), 5);
  });
  it("keeps a silhouette's holes and separate pieces as open water", () => {
    const square = (half: number, x = 0): [number, number][] => [
      [x - half, -half],
      [x + half, -half],
      [x + half, half],
      [x - half, half],
    ];
    const field = rimField(
      [[square(10, -6), square(3, -6)], [square(3, 14)]],
      { height: 40, width: 40 },
      40
    );
    const at = (x: number, y: number) =>
      field.outside[(y + 20) * field.width + (x + 20)] ?? Number.NaN;
    expect(at(-12, 0)).toBe(0);
    // Enclosed deep water is a hole, measured from its own edge.
    expect(at(-6, 0)).toBeGreaterThan(0);
    // The separate piece is its own region, with water between.
    expect(at(14, 0)).toBe(0);
    expect(at(7, 0)).toBeGreaterThan(0);
  });
});
