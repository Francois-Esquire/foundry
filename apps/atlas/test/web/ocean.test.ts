import { describe, expect, it } from "vitest";
import { insidePolygons } from "../../src/web/atmosphere";
import { shoreDistances } from "../../src/web/distance-field";
import { archipelagoHull } from "../../src/web/scene/archipelago";
import {
  depthSteps,
  oceanShade,
  openSeaSteps,
} from "../../src/web/scene/ocean";
import { loadAtlas } from "../helpers/reference-atlas";

describe("atlas ocean", () => {
  it("encloses every island in one deterministic archipelago hull", async () => {
    const data = await loadAtlas();
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
  it("steps softly deeper and cooler offshore, then caps deep water", () => {
    const deepest = depthSteps.at(-1) ?? 0;
    expect(oceanShade(0)).toEqual([223, 227, 211]);
    expect(oceanShade(deepest + 10)).toEqual([199, 210, 199]);
    expect(oceanShade(1000)).toEqual(oceanShade(deepest + 10));
    for (let d = 1; d <= deepest + 10; d += 0.5) {
      expect(
        oceanShade(d).every(
          (value, i) => value <= (oceanShade(d - 0.5)[i] ?? 0)
        )
      ).toBe(true);
    }
    // Layers: flat within a band, a soft change across each step.
    const [first = 0, second = 0] = depthSteps;
    const middle = (first + second) / 2;
    expect(oceanShade(middle - 1)).toEqual(oceanShade(middle + 1));
    expect(oceanShade(second + 3)[0]).toBeLessThan(oceanShade(second - 3)[0]);
    // Deep water is cooler: red falls further than blue.
    const [r0 = 0, , b0 = 0] = oceanShade(0);
    const [r1 = 0, , b1 = 0] = oceanShade(deepest + 10);
    expect(r0 - r1).toBeGreaterThan(b0 - b1);
  });
  it("layers open water beyond the rim out to a slightly darker ocean blue", () => {
    const deep = (depthSteps.at(-1) ?? 0) + 10;
    const edge = (openSeaSteps.at(-1) ?? 0) + 40;
    // Inside the rim nothing changes.
    expect(oceanShade(deep, 0)).toEqual(oceanShade(deep));
    expect(oceanShade(deep, edge)).toEqual([180, 196, 197]);
    for (let d = 5; d <= edge; d += 5) {
      expect(
        oceanShade(deep, d).every(
          (value, i) => value <= (oceanShade(deep, d - 5)[i] ?? 0)
        )
      ).toBe(true);
    }
    // Ocean blue: red falls further than blue, and only slightly overall.
    const [r0 = 0, , b0 = 0] = oceanShade(deep);
    const [r1 = 0, , b1 = 0] = oceanShade(deep, edge);
    expect(r0 - r1).toBeGreaterThan(b0 - b1);
    expect(r0 - r1).toBeLessThan(24);
  });
});
