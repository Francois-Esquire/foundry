import { beforeAll, describe, expect, it } from "vitest";
import {
  contourSegments,
  type FieldLattice,
  heightFieldDistances,
  islandLattice,
  lipschitzReport,
  type SdfIsland,
  sdfIsland,
  segmentDistance,
} from "../../src/lib/visualization/sdf-island";
import { meshSdf } from "../../src/lib/visualization/sdf-mesh";
import { type ChartWorld, chartWorld } from "../../src/web/layout/chart-world";
import { loadSpyglass } from "../helpers/reference-spyglass";

let chart: ChartWorld;
let plateau: SdfIsland;
let atoll: SdfIsland;

/** The deepest island of a formation. */
function deepest(archetype: string): string {
  const [found] = [...chart.landforms]
    .filter(([, landform]) => landform.archetype === archetype)
    .sort(([, a], [, b]) => b.params.depth - a.params.depth);
  if (!found) {
    throw new Error(`No ${archetype} in the reference chart.`);
  }
  return found[0];
}

beforeAll(async () => {
  chart = chartWorld(await loadSpyglass());
  plateau = sdfIsland(chart.world, chart.landforms, deepest("plateau"));
  atoll = sdfIsland(chart.world, chart.landforms, deepest("atoll"));
});

/** Every lattice sample's world position and index where `keep` holds. */
function samplesWhere(
  island: SdfIsland,
  keep: (land: number, index: number) => boolean
) {
  const { fields } = island;
  const out: { index: number; x: number; y: number }[] = [];
  for (let row = 0; row < fields.rows; row += 3) {
    for (let column = 0; column < fields.columns; column += 3) {
      const index = row * fields.columns + column;
      if (keep(island.heightField[index] ?? 0, index)) {
        out.push({
          index,
          x: fields.left + column * fields.spacing,
          y: -(fields.top + row * fields.spacing),
        });
      }
    }
  }
  return out;
}

describe("an island's signed distance", () => {
  it("is outside over the land and the water, inside under them", () => {
    for (const island of [plateau, atoll]) {
      const land = samplesWhere(island, (height) => height > 1);
      expect(land.length).toBeGreaterThan(100);
      for (const { x, y } of land) {
        const surface = island.surfaceHeight(x, y);
        expect(island.distance(x, y, surface + 1)).toBeGreaterThan(0);
        expect(island.distance(x, y, surface - 1)).toBeLessThan(0);
      }
      const { fields } = island;
      // The field's corner lies well out at sea.
      const x = fields.left + 1;
      const y = -(fields.top + 1);
      expect(island.distance(x, y, 0.5)).toBeGreaterThan(0);
      expect(
        island.distance(x, y, island.surfaceHeight(x, y) - 0.5)
      ).toBeLessThan(0);
    }
  });

  it("leaves an atoll's lagoon open water down to its floor", () => {
    // Inside the coast, below the water: the lagoon's floor.
    const lagoon = samplesWhere(atoll, (height) => height < -0.3);
    const inside = lagoon.filter(({ x, y }) => {
      const floor = atoll.surfaceHeight(x, y);
      return floor < -0.3 && atoll.distance(x, y, 0) > 0.25;
    });
    expect(inside.length).toBeGreaterThan(20);
    for (const { x, y } of inside) {
      expect(
        atoll.distance(x, y, atoll.surfaceHeight(x, y) - 0.5)
      ).toBeLessThan(0);
    }
  });

  it("keeps a tread's height where the landform is level", () => {
    // Treads stand at the landform's own height, cut but not moved.
    let checked = 0;
    for (const island of [plateau, atoll]) {
      const before = checked;
      for (const { x, y, index } of samplesWhere(
        island,
        (height) => height > 3
      )) {
        const height = island.heightField[index] ?? 0;
        const surface = island.surfaceHeight(x, y);
        const tread = island.profile.treads.find(
          (each) =>
            height >= each.low * 14 - 1e-6 && height <= each.high * 14 + 1e-6
        );
        // Away from any wall, the slab's top is the landform.
        if (tread && Math.abs(island.distance(x, y, height)) < 1e-3) {
          expect(surface).toBeCloseTo(height, 3);
          checked += 1;
        }
      }
      expect(checked).toBeGreaterThan(before);
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("has a gradient within a few hundredths of unit length near its surface, unlike the height field", () => {
    for (const island of [plateau, atoll]) {
      const lattice = islandLattice(island);
      const bounds = {
        high: lattice.origin.map(
          (origin, axis) =>
            origin + ((lattice.size[axis] ?? 1) - 1) * lattice.spacing
        ),
        low: [...lattice.origin],
      };
      const options = { band: 1, samples: 3000, step: 0.02 };
      const slabs = lipschitzReport(island.distance, bounds, options);
      expect(slabs.meanError).toBeLessThan(0.02);
      expect(slabs.p99).toBeLessThan(1.05);
      expect(slabs.max).toBeLessThan(1.25);
      const naive = lipschitzReport(
        heightFieldDistances(island).naive,
        bounds,
        options
      );
      expect(naive.p99).toBeGreaterThan(2);
    }
  });

  it("meshes onto its own surface, dual contouring within a tenth of a lattice step", () => {
    const lattice = islandLattice(plateau);
    const { chunks, stats } = meshSdf(plateau, lattice, {
      chunk: 32,
      method: "dual-contouring",
      skip: true,
    });
    expect(stats.triangles).toBeGreaterThan(10_000);
    const errors: number[] = [];
    for (const chunk of chunks) {
      for (let index = 0; index < chunk.positions.length; index += 3) {
        errors.push(
          Math.abs(
            plateau.distance(
              chunk.positions[index] ?? 0,
              chunk.positions[index + 1] ?? 0,
              chunk.positions[index + 2] ?? 0
            )
          )
        );
      }
    }
    errors.sort((a, b) => a - b);
    expect(errors[Math.floor(errors.length * 0.99)]).toBeLessThan(
      0.1 * lattice.spacing
    );
  });
});

describe("re-distancing a contour", () => {
  it("measures the exact distance to a traced circle", () => {
    const lattice: FieldLattice = {
      columns: 81,
      left: -10,
      rows: 81,
      spacing: 0.25,
      top: -10,
    };
    const values = new Float32Array(81 * 81);
    for (let row = 0; row < 81; row += 1) {
      for (let column = 0; column < 81; column += 1) {
        const x = -10 + column * 0.25;
        const y = -10 + row * 0.25;
        // A cone, not a distance: its slope is 3, so its values are not distances.
        values[row * 81 + column] = 3 * (6 - Math.hypot(x, y));
      }
    }
    const segments = contourSegments(lattice, values, 0);
    const distance = segmentDistance(
      lattice,
      segments,
      4,
      (index) => (values[index] ?? 0) >= 0
    );
    let worst = 0;
    for (let row = 0; row < 81; row += 1) {
      for (let column = 0; column < 81; column += 1) {
        const exact = Math.hypot(-10 + column * 0.25, -10 + row * 0.25) - 6;
        if (Math.abs(exact) < 3.5) {
          worst = Math.max(
            worst,
            Math.abs((distance[row * 81 + column] ?? 0) - exact)
          );
        }
      }
    }
    expect(worst).toBeLessThan(0.01);
  });
});
