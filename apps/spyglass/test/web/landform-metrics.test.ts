import { expect, it } from "vitest";
import { geologyLevels } from "../../src/lib/visualization/geology";
import { landformFor } from "../../src/lib/visualization/landforms";
import type { Territory } from "../../src/web/data/types";
import {
  defaultLandformMetricsSettings,
  islandLandforms,
  landformMetrics,
  landformParams,
} from "../../src/web/layout/landform-metrics";
import { insidePolygons } from "../../src/web/layout/polygons";
import { loadSpyglass } from "../helpers/reference-spyglass";

/** Map units from a local point to the island's nearest coast edge. */
function coastDistance(island: Territory, x: number, y: number): number {
  let distance = Number.POSITIVE_INFINITY;
  for (const ring of island.coast.flat()) {
    for (let index = 0; index < ring.length; index += 1) {
      const [ax = 0, ay = 0] = ring[index] ?? [];
      const [bx = 0, by = 0] = ring[(index + 1) % ring.length] ?? [];
      const dx = bx - ax;
      const dy = by - ay;
      const t = Math.max(
        0,
        Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1))
      );
      distance = Math.min(
        distance,
        Math.hypot(x - ax - t * dx, y - ay - t * dy)
      );
    }
  }
  return distance;
}

it("gives the fixture a varied but plausible spread of formations", async () => {
  const data = await loadSpyglass();
  const islands = islandLandforms(data);
  expect(islands.size).toBe(data.territories.length);
  const counts = new Map<string, number>();
  for (const { archetype } of islands.values()) {
    counts.set(archetype, (counts.get(archetype) ?? 0) + 1);
  }
  expect(counts.size).toBeGreaterThanOrEqual(4);
  for (const count of counts.values()) {
    expect(count).toBeLessThanOrEqual(data.territories.length / 2);
  }
});

it("reads true formations from the fixture's packages", async () => {
  const data = await loadSpyglass();
  const islands = islandLandforms(data);
  // The spyglass's land breaks into a dozen pieces; lib's coast is long and narrow.
  expect(islands.get("@foundry/spyglass")?.archetype).toBe("cluster");
  expect(islands.get("@foundry/lib")?.archetype).toBe("ridge");
  // Core is three files: it barely breaks the surface.
  expect(islands.get("@foundry/core")?.archetype).toBe("seamount");
});

it("measures plain, finite metrics for every island", async () => {
  const data = await loadSpyglass();
  for (const island of data.territories) {
    const metrics = landformMetrics(island);
    for (const value of Object.values(metrics)) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(metrics.files).toBe(island.files.length);
    expect(metrics.coastPieces).toBe(island.coast.length);
    expect(metrics.elongation).toBeGreaterThanOrEqual(1);
    expect(metrics.hubDominance).toBeGreaterThanOrEqual(1);
  }
});

it("hands on geometry in map positions, its depth the island's own", async () => {
  const data = await loadSpyglass();
  for (const island of data.territories) {
    const params = landformParams(island);
    const local = { x: params.x - island.x, y: params.y - island.y };
    expect(Math.hypot(local.x, local.y)).toBeLessThan(island.radius);
    expect(params.depth).toBeGreaterThan(5);
    expect(params.depth).toBeLessThan(island.radius);
    expect(params.length).toBeGreaterThanOrEqual(params.breadth);
    expect(Math.hypot(...params.axis)).toBeCloseTo(1, 6);
    for (const peak of params.peaks) {
      expect(
        insidePolygons(
          { x: peak.x - island.x, y: peak.y - island.y },
          island.coast
        )
      ).toBe(true);
      expect(peak.weight).toBeGreaterThan(0);
      expect(peak.weight).toBeLessThanOrEqual(1);
    }
  }
});

it("hands on the coast's bays as outlets: on the coast, deepest first, spaced apart", async () => {
  const data = await loadSpyglass();
  const rules = defaultLandformMetricsSettings.outlets;
  let bays = 0;
  for (const island of data.territories) {
    const outlets = landformParams(island).outlets ?? [];
    bays += outlets.length;
    expect(outlets.length).toBeLessThanOrEqual(rules.most);
    for (const [index, outlet] of outlets.entries()) {
      expect(
        coastDistance(island, outlet.x - island.x, outlet.y - island.y)
      ).toBeLessThan(1e-6);
      expect(outlet.depth).toBeGreaterThanOrEqual(rules.depth);
      expect(outlet.depth).toBeLessThanOrEqual(
        outlets[index - 1]?.depth ?? Number.POSITIVE_INFINITY
      );
      for (const other of outlets.slice(0, index)) {
        expect(
          Math.hypot(outlet.x - other.x, outlet.y - other.y)
        ).toBeGreaterThanOrEqual(rules.spacing);
      }
    }
  }
  // The fixture's coasts are bayed, so most islands have somewhere to drain.
  expect(bays).toBeGreaterThan(data.territories.length);
});

it("keeps every fixture island's land at 0 on its coast and within land inside", async () => {
  const data = await loadSpyglass();
  const landform = landformFor(islandLandforms(data));
  for (const island of data.territories) {
    for (const [x, y] of island.coast.flat(2)) {
      const sample = {
        inland: 0,
        islandId: island.id,
        x: island.x + x,
        y: island.y + y,
      };
      expect(landform(sample)).toBe(0);
    }
    for (let x = -island.radius; x <= island.radius; x += 6) {
      for (let y = -island.radius; y <= island.radius; y += 6) {
        if (insidePolygons({ x, y }, island.coast)) {
          const height = landform({
            inland: coastDistance(island, x, y),
            islandId: island.id,
            x: island.x + x,
            y: island.y + y,
          });
          expect(height).toBeGreaterThanOrEqual(0);
          expect(height).toBeLessThanOrEqual(geologyLevels.land);
        }
      }
    }
  }
});

it("reads the same formations on every call", async () => {
  const data = await loadSpyglass();
  expect(islandLandforms(data)).toEqual(islandLandforms(data));
});
