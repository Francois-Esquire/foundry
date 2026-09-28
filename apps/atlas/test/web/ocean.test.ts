import { describe, expect, it } from "vitest";

import { archipelagoHull } from "../../src/web/archipelago";
import { insidePolygons } from "../../src/web/atmosphere";
import { shoreDistances } from "../../src/web/distance-field";
import { oceanShade } from "../../src/web/ocean";
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
  it("darkens continuously with distance and caps deep water pigment", () => {
    expect(oceanShade(0)).toEqual([220, 224, 207]);
    expect(oceanShade(40)).toEqual([213, 219, 202]);
    expect(oceanShade(1000)).toEqual(oceanShade(40));
    for (let d = 1; d <= 40; d += 1) {
      expect(
        oceanShade(d).every((value, i) => value <= (oceanShade(d - 1)[i] ?? 0))
      ).toBe(true);
    }
  });
  it("adds a separate gradual deepening outside the archipelago rim", () => {
    expect(oceanShade(40, 0)).toEqual(oceanShade(40));
    expect(oceanShade(40, 1100)).toEqual([209, 214, 197]);
    expect(oceanShade(40, 120)).toEqual(oceanShade(40));
    expect(oceanShade(40, 550)[0]).toBeLessThan(oceanShade(40)[0]);
    expect(oceanShade(40, 1100)[0]).toBeLessThan(oceanShade(40, 550)[0]);
  });
});
