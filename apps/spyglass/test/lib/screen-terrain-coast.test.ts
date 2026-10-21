import { beforeAll, expect, it } from "vitest";
import {
  type CoastBins,
  type CoastSegments,
  coastBins,
  coastDistance,
  coastSegments,
} from "../../src/lib/visualization/screen-terrain-coast";
import type { TerrainIsland } from "../../src/lib/visualization/terrain";
import { chartWorld } from "../../src/web/layout/chart-world";
import { loadSpyglass } from "../helpers/reference-spyglass";

let islands: readonly TerrainIsland[];
let segments: CoastSegments;
let bins: CoastBins;
let ids: readonly string[];

beforeAll(async () => {
  const { world } = chartWorld(await loadSpyglass());
  ({ islands, islandIds: ids } = world);
  segments = coastSegments(islands, ids);
  bins = coastBins(islands, ids, segments, {
    cell: 8,
    height: Math.ceil((world.height * world.cell) / 8),
    left: world.left,
    top: world.top,
    width: Math.ceil((world.width * world.cell) / 8),
  });
});

/** Brute force: even-odd over every ring, and the nearest of every segment. */
function bruteForce(x: number, y: number) {
  let inside = false;
  let nearest = Number.POSITIVE_INFINITY;
  let owner = -1;
  for (const island of islands) {
    for (const polygon of island.coast) {
      for (const ring of polygon) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
          const [ax = 0, ay = 0] = ring[i] ?? [];
          const [bx = 0, by = 0] = ring[j] ?? [];
          const px = x - island.x;
          const py = y - island.y;
          if (
            ay > py !== by > py &&
            px < ((bx - ax) * (py - ay)) / (by - ay) + ax
          ) {
            inside = !inside;
          }
        }
      }
    }
  }
  for (let index = 0; index < segments.island.length; index += 1) {
    const at = index * 4;
    const ax = segments.points[at] ?? 0;
    const ay = segments.points[at + 1] ?? 0;
    const dx = (segments.points[at + 2] ?? 0) - ax;
    const dy = (segments.points[at + 3] ?? 0) - ay;
    const length = dx * dx + dy * dy;
    const t =
      length > 0
        ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / length))
        : 0;
    const distance = Math.hypot(x - ax - t * dx, y - ay - t * dy);
    if (distance < nearest) {
      nearest = distance;
      owner = segments.island[index] ?? -1;
    }
  }
  return { inside, nearest, owner };
}

it("measures the coast exactly and tells land from sea, as brute force does", () => {
  let land = 0;
  let checked = 0;
  for (const island of islands) {
    for (let step = 0; step < 900; step += 1) {
      // A jittered lattice over the island's neighbourhood, off every bin edge.
      const x = island.x + ((step % 30) - 14.5) * 4.13 + 0.217;
      const y = island.y + (Math.floor(step / 30) - 14.5) * 4.07 + 0.131;
      const expected = bruteForce(x, y);
      if (expected.nearest < 1e-4) {
        continue;
      }
      const sample = coastDistance(bins, segments, x, y);
      checked += 1;
      expect(sample.distance < 0).toBe(expected.inside);
      if (expected.inside) {
        land += 1;
        expect(-sample.distance).toBeCloseTo(expected.nearest, 9);
        expect(sample.owner).toBe(expected.owner);
      } else if (Number.isFinite(sample.distance)) {
        // At sea the bin need not list the nearest coast, only one at least as far.
        expect(sample.distance).toBeGreaterThanOrEqual(expected.nearest - 1e-9);
      }
    }
  }
  expect(checked).toBeGreaterThan(10_000);
  expect(land).toBeGreaterThan(1000);
});

it("lists few segments a bin", () => {
  let most = 0;
  let total = 0;
  let listed = 0;
  for (let at = 0; at < bins.bins.length / 3; at += 1) {
    const count = bins.bins[at * 3 + 1] ?? 0;
    most = Math.max(most, count);
    total += count;
    listed += count > 0 ? 1 : 0;
  }
  expect(total / listed).toBeLessThan(200);
  expect(most).toBeLessThan(2000);
});
