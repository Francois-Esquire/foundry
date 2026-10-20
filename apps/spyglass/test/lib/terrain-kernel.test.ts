import { beforeAll, describe, expect, it } from "vitest";
import { landformFor } from "../../src/lib/visualization/landforms";
import {
  fbm,
  gradientNoise,
  latticeHash,
  noiseSeed,
} from "../../src/lib/visualization/noise";
import {
  float32Math,
  numberMath,
} from "../../src/lib/visualization/terrain-kernel";
import {
  islandStride,
  kernelLandform,
  packLandforms,
} from "../../src/lib/visualization/terrain-kernel-landform";
import { kernelNoise } from "../../src/lib/visualization/terrain-kernel-noise";
import { kernelTerrace } from "../../src/lib/visualization/terrain-kernel-terrace";
import { defaultWorldTerrainSettings } from "../../src/lib/visualization/world-terrain";
import { type ChartWorld, chartWorld } from "../../src/web/layout/chart-world";
import { loadSpyglass } from "../helpers/reference-spyglass";

/** A deterministic spread of points, negative and positive, off the lattice. */
function points(count: number, scale: number): [number, number][] {
  return Array.from({ length: count }, (_, index) => [
    (((index * 7919) % 1000) / 1000 - 0.5) * scale + 0.137 * index,
    (((index * 104_729) % 997) / 997 - 0.5) * scale - 0.071 * index,
  ]);
}

const exact = kernelNoise(numberMath);
const single = kernelNoise(float32Math);
const seeds = ["swell", "spyglass:seabed", "mesa"].map(noiseSeed);

it("hashes lattice points exactly as noise.ts does, negative columns included", () => {
  for (const [x, y] of points(200, 4000)) {
    for (const seed of seeds) {
      const column = Math.floor(x);
      const row = Math.floor(y);
      expect(
        exact.hashBits(
          numberMath.floorBits(x),
          numberMath.floorBits(y),
          numberMath.uint(seed)
        )
      ).toBe(latticeHash(column, row, seed));
    }
  }
});

it("computes gradient noise and fBm exactly as noise.ts does", () => {
  const fractal = { gain: 0.5, lacunarity: 2, octaves: 4 };
  for (const [x, y] of points(300, 300)) {
    for (const seed of seeds) {
      // Equal as numbers: an axis gradient's zero term may carry the other sign.
      expect(
        Math.abs(exact.gradient(x, y, seed) - gradientNoise(x, y, seed))
      ).toBe(0);
      expect(
        Math.abs(exact.fbm(x, y, seed, fractal) - fbm(x, y, seed, fractal))
      ).toBe(0);
    }
  }
});

it("keeps single-precision noise within a thousandth of the CPU's at map scale", () => {
  const fractal = { gain: 0.5, lacunarity: 2, octaves: 2 };
  let worst = 0;
  // Map units over the wavelengths the landforms use: coordinates up to about 100 lattice cells.
  for (const [x, y] of points(400, 200)) {
    for (const seed of seeds) {
      worst = Math.max(
        worst,
        Math.abs(single.fbm(x, y, seed, fractal) - fbm(x, y, seed, fractal))
      );
    }
  }
  expect(worst).toBeLessThan(1e-3);
});

describe("the landform kernel over the reference chart", () => {
  let chart: ChartWorld;
  let packed: number[];
  let reference: ReturnType<typeof landformFor>;
  beforeAll(async () => {
    chart = chartWorld(await loadSpyglass());
    packed = packLandforms(chart.landforms, chart.world.islandIds);
    reference = landformFor(chart.landforms);
  });

  /** Samples over every island's land: its world cells inside the coast, nudged off the cell centres. */
  function samples() {
    const { world } = chart;
    const found: {
      inland: number;
      island: number;
      pieceDepth: number;
      x: number;
      y: number;
    }[] = [];
    for (let at = 0; at < world.elevation.length; at += 3) {
      const distance = world.signedDistance[at] ?? 0;
      const island = world.owner[at] ?? -1;
      if (distance < 0 && island >= 0) {
        found.push({
          inland: -distance + 0.37,
          island,
          pieceDepth: world.pieceDepth[at] ?? 0,
          x: world.left + ((at % world.width) + 0.31) * world.cell,
          y: world.top + (Math.floor(at / world.width) + 0.77) * world.cell,
        });
      }
    }
    return found;
  }

  it("steps the seabed exactly as the world terrain's terrace pass does", () => {
    const { world } = chart;
    const { featured, width, height, cell } = world;
    // `world-terrain`'s `slopeAt`: central differences over the pass's reference, clamped at the edge.
    const slopeAt = (column: number, row: number) => {
      const west = Math.max(0, column - 1);
      const east = Math.min(width - 1, column + 1);
      const north = Math.max(0, row - 1);
      const south = Math.min(height - 1, row + 1);
      const dx =
        ((featured[row * width + east] ?? 0) -
          (featured[row * width + west] ?? 0)) /
        (Math.max(1, east - west) * cell);
      const dy =
        ((featured[south * width + column] ?? 0) -
          (featured[north * width + column] ?? 0)) /
        (Math.max(1, south - north) * cell);
      return Math.hypot(dx, dy);
    };
    let stepped = 0;
    let worst = 0;
    for (let at = 0; at < featured.length; at += 1) {
      if ((world.signedDistance[at] ?? 0) < 0) {
        continue;
      }
      const before = featured[at] ?? 0;
      const kernel = Math.fround(
        kernelTerrace(
          numberMath,
          before,
          slopeAt(at % width, Math.floor(at / width)),
          defaultWorldTerrainSettings.terrace
        )
      );
      const terraced = (world.elevation[at] ?? 0) - (world.detail[at] ?? 0);
      worst = Math.max(worst, Math.abs(kernel - terraced));
      stepped += kernel === before ? 0 : 1;
    }
    expect(stepped).toBeGreaterThan(10_000);
    // The terraced value is recovered as the elevation less the detail, in single precision.
    expect(worst).toBeLessThan(1e-6);
  });

  it("covers every formation in the reference chart", () => {
    const formations = new Set(
      [...chart.landforms.values()].map(({ archetype }) => archetype)
    );
    expect([...formations].sort()).toEqual([
      "atoll",
      "cluster",
      "plateau",
      "ridge",
      "seamount",
      "volcanic",
    ]);
  });

  it("gives every island's land exactly as landformFor does", () => {
    const list = samples();
    expect(list.length).toBeGreaterThan(1000);
    let mismatches = 0;
    let worst = 0;
    for (const sample of list) {
      const read = (slot: number) =>
        packed[sample.island * islandStride + slot] ?? 0;
      const kernel = kernelLandform(numberMath, exact, read, sample);
      const expected = reference({
        ...sample,
        islandId: chart.world.islandIds[sample.island] ?? "",
      });
      worst = Math.max(worst, Math.abs(kernel - expected));
      if (kernel !== expected) {
        mismatches += 1;
      }
    }
    expect(worst).toBeLessThan(1e-12);
    expect(mismatches).toBe(0);
  });

  it("strays under a hundredth of full land in single precision, the GPU's", () => {
    const float32 = Float32Array.from(packed);
    let worst = 0;
    let total = 0;
    const list = samples();
    for (const sample of list) {
      const read = (slot: number) =>
        float32[sample.island * islandStride + slot] ?? 0;
      const kernel = kernelLandform(float32Math, single, read, {
        inland: Math.fround(sample.inland),
        pieceDepth: Math.fround(sample.pieceDepth),
        x: Math.fround(sample.x),
        y: Math.fround(sample.y),
      });
      const expected = reference({
        ...sample,
        islandId: chart.world.islandIds[sample.island] ?? "",
      });
      const error = Math.abs(kernel - expected);
      worst = Math.max(worst, error);
      total += error;
    }
    // Escarpments are steep: a ULP of position moves a riser a hair, so the worst
    // sample may sit on one; the mean says the surfaces agree.
    expect(total / list.length).toBeLessThan(1e-5);
    expect(worst).toBeLessThan(1e-2);
  });
});
