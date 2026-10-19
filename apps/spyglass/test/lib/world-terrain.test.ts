import { expect, it } from "vitest";
import { archipelagoPlatform } from "../../src/lib/visualization/archipelago-platform";
import {
  elevationAtDepth,
  geologyLevels,
  type LandformSample,
  rampLandform,
  type SeabedContribution,
  seabedCeiling,
} from "../../src/lib/visualization/geology";
import {
  structuralTerrain,
  type TerrainContributionSource,
  type TerrainIsland,
  type TerrainSurface,
} from "../../src/lib/visualization/terrain";
import {
  defaultWorldTerrainSettings,
  type WorldTerrain,
  type WorldTerrainSettings,
  worldTerrain,
} from "../../src/lib/visualization/world-terrain";
import { chartTerrain } from "../../src/web/layout/chart-terrain";
import { loadSpyglass } from "../helpers/reference-spyglass";

function island(id: string, x: number, y = 0, radius = 40): TerrainIsland {
  const ring: [number, number][] = Array.from({ length: 48 }, (_, i) => [
    Math.cos((i * Math.PI) / 24) * radius,
    Math.sin((i * Math.PI) / 24) * radius,
  ]);
  return { coast: [[ring]], id, radius, x, y };
}

function shared(
  memberIds: string[],
  dependencies = 1
): TerrainContributionSource {
  const id = `group:${memberIds.join("+")}`;
  return {
    dependencyIds: Array.from(
      { length: dependencies },
      (_, i) => `dependency:${id}:${i}`
    ),
    id,
    kind: "shared",
    members: memberIds.map((territoryId) => ({ amplitude: 1, territoryId })),
    weight: dependencies,
  };
}

const islands = [island("a", -120), island("b", 120, 30, 50)];

function terrain() {
  return structuralTerrain({
    contributions: [shared(["a", "b"], 4)],
    extent: { height: 500, width: 900 },
    islands,
  });
}

/** The terrace pass on, the detail pass off. */
const withoutDetail: WorldTerrainSettings = {
  ...defaultWorldTerrainSettings,
  detail: { ...defaultWorldTerrainSettings.detail, strength: 0 },
};

/** Neither pass: sea cells are the seabed and its features only. */
const withoutPasses: WorldTerrainSettings = {
  ...withoutDetail,
  terrace: { ...defaultWorldTerrainSettings.terrace, strength: 0 },
};

/** A feature covering the whole grid with one value. */
function everywhere(
  field: ReturnType<typeof terrain>,
  value: number,
  id = `everywhere:${value}`
): SeabedContribution {
  return {
    column: 0,
    height: field.height,
    id,
    row: 0,
    values: new Float32Array(field.width * field.height).fill(value),
    width: field.width,
  };
}

/** Whether two fields hold the same values, compared without a deep-equality walk. */
function same(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

/** Float32 storage keeps about seven significant digits. */
const tolerance = 1e-6;

/** The first few cells where `holds` is false; checked per cell without an assertion each. */
function failing(
  world: Pick<WorldTerrain, "signedDistance">,
  holds: (at: number, distance: number) => boolean
): number[] {
  const cells: number[] = [];
  for (const [at, distance] of world.signedDistance.entries()) {
    if (!holds(at, distance) && cells.push(at) >= 5) {
      break;
    }
  }
  return cells;
}

/** Every cell's elevation is above water exactly where it is land, and only land is owned. */
function expectCoastsKept(world: WorldTerrain) {
  expect(world.signedDistance.some((distance) => distance < 0)).toBe(true);
  expect(
    failing(world, (at, distance) => {
      const elevation = world.elevation[at] ?? Number.NaN;
      const owner = world.owner[at] ?? Number.NaN;
      return distance < 0
        ? elevation > geologyLevels.waterLevel &&
            elevation <= geologyLevels.land &&
            owner >= 0
        : elevation < geologyLevels.waterLevel &&
            elevation >= geologyLevels.trenchFloor &&
            owner === -1;
    })
  ).toEqual([]);
}

it("matches the structural terrain with the default landform and no detail", () => {
  const field = terrain();
  const world = worldTerrain({
    islands,
    settings: withoutPasses,
    terrain: field,
  });
  const ramp = rampLandform(field.settings.land);
  expect(world).toMatchObject({
    cell: field.cell,
    height: field.height,
    left: field.left,
    top: field.top,
    width: field.width,
  });
  expect(world.signedDistance).toBe(field.signedDistance);
  expect(
    failing(world, (at, distance) => {
      const elevation = world.elevation[at] ?? Number.NaN;
      if (distance >= 0) {
        return elevation === field.surface.elevation[at];
      }
      const expected = ramp({ inland: -distance, islandId: "", x: 0, y: 0 });
      return (
        Math.abs(elevation - expected) < tolerance &&
        Math.abs(elevation - (field.surface.elevation[at] ?? 0)) < tolerance
      );
    })
  ).toEqual([]);
  expectCoastsKept(world);
});

it("gives land cells a custom landform, asked with the owning island", () => {
  const field = terrain();
  const asked: LandformSample[] = [];
  const landform = (sample: LandformSample) => {
    asked.push(sample);
    return sample.islandId === "a" ? 0.5 : 0.25;
  };
  const world = worldTerrain({
    islands,
    landform,
    landformKey: "test:per-island",
    settings: withoutPasses,
    terrain: field,
  });
  const land = field.signedDistance.filter((d) => d < 0).length;
  expect(asked).toHaveLength(land);
  // Island a lies west of the origin, b east of it.
  expect(
    asked.filter(({ islandId, x }) => islandId !== (x < 0 ? "a" : "b"))
  ).toEqual([]);
  expect(asked.filter(({ inland }) => !(inland > 0))).toEqual([]);
  expect(
    asked.filter(
      ({ islandId, x, y }) =>
        Math.abs(world.sample(x, y) - (islandId === "a" ? 0.5 : 0.25)) >
        tolerance
    )
  ).toEqual([]);
  expect(world.islandIds).toEqual(["a", "b"]);
  expectCoastsKept(world);
});

it("asks a landform at each land cell's centre, with its distance inland", () => {
  const field = terrain();
  const asked: LandformSample[] = [];
  worldTerrain({
    islands,
    landform: (sample) => {
      asked.push(sample);
      return 0.5;
    },
    landformKey: "test:positions",
    settings: withoutPasses,
    terrain: field,
  });
  expect(
    asked.filter(({ inland, x, y }) => {
      const column = Math.floor((x - field.left) / field.cell);
      const row = Math.floor((y - field.top) / field.cell);
      const centre = field.left + (column + 0.5) * field.cell;
      const distance = field.signedDistance[row * field.width + column] ?? 0;
      return Math.abs(x - centre) > tolerance || inland !== -distance;
    })
  ).toEqual([]);
});

it("gives an island without a coast the land nearest its footprint", () => {
  // The structural terrain draws a coastless island as a circle of its radius.
  const coastless: TerrainIsland = {
    coast: [],
    id: "c",
    radius: 30,
    x: 0,
    y: -150,
  };
  const all = [...islands, coastless];
  const field = structuralTerrain({
    contributions: [],
    extent: { height: 500, width: 900 },
    islands: all,
  });
  const world = worldTerrain({
    islands: all,
    settings: withoutPasses,
    terrain: field,
  });
  const c = world.islandIds.indexOf("c");
  expect(c).toBeGreaterThanOrEqual(0);
  let owned = 0;
  expect(
    failing(world, (at, distance) => {
      if (distance >= 0) {
        return true;
      }
      const y = field.top + (Math.floor(at / field.width) + 0.5) * field.cell;
      if (y < -100) {
        owned += 1;
        return world.owner[at] === c;
      }
      return world.owner[at] !== c;
    })
  ).toEqual([]);
  expect(owned).toBeGreaterThan(0);
  expectCoastsKept(world);
});

it("keeps a landform from making a coast: land is held between the water and full height", () => {
  const field = terrain();
  const world = worldTerrain({
    islands,
    landform: ({ islandId }) => (islandId === "a" ? -0.5 : 3),
    landformKey: "test:out-of-range",
    settings: withoutPasses,
    terrain: field,
  });
  expect(
    failing(world, (at, distance) => {
      if (distance >= 0) {
        return true;
      }
      const west = field.left + ((at % field.width) + 0.5) * field.cell < 0;
      return (
        world.elevation[at] ===
        (west ? geologyLevels.waterLevel : geologyLevels.land)
      );
    })
  ).toEqual([]);
});

it("adds seabed features to sea cells only, between the trench floor and the ceiling", () => {
  const field = terrain();
  const plain = worldTerrain({
    islands,
    settings: withoutPasses,
    terrain: field,
  });
  const raised = worldTerrain({
    contributions: [everywhere(field, 10)],
    islands,
    settings: withoutPasses,
    terrain: field,
  });
  const carved = worldTerrain({
    contributions: [everywhere(field, -10)],
    islands,
    settings: withoutPasses,
    terrain: field,
  });
  const nudged = worldTerrain({
    contributions: [
      everywhere(field, -0.05, "a"),
      everywhere(field, 0.02, "b"),
    ],
    islands,
    settings: withoutPasses,
    terrain: field,
  });
  expect(
    failing(field, (at, distance) => {
      const base = field.surface.elevation[at] ?? 0;
      const near = (value: number | undefined, expected: number) =>
        Math.abs((value ?? Number.NaN) - expected) < tolerance;
      if (distance < 0) {
        return (
          raised.elevation[at] === plain.elevation[at] &&
          carved.elevation[at] === plain.elevation[at] &&
          nudged.elevation[at] === plain.elevation[at]
        );
      }
      return (
        near(raised.elevation[at], Math.max(base, seabedCeiling)) &&
        near(carved.elevation[at], geologyLevels.trenchFloor) &&
        near(
          nudged.elevation[at],
          Math.max(geologyLevels.trenchFloor, base - 0.03)
        )
      );
    })
  ).toEqual([]);
  expectCoastsKept(raised);
  expectCoastsKept(carved);
  expectCoastsKept(nudged);
});

it("clips a feature's crop to the grid and ignores what falls outside it", () => {
  const field = terrain();
  const plain = worldTerrain({
    islands,
    settings: withoutPasses,
    terrain: field,
  });
  const corner = worldTerrain({
    contributions: [
      {
        column: -3,
        height: 6,
        id: "corner",
        row: -3,
        values: new Float32Array(36).fill(0.1),
        width: 6,
      },
    ],
    islands,
    settings: withoutPasses,
    terrain: field,
  });
  const changed = corner.elevation.filter(
    (value, at) => value !== plain.elevation[at]
  ).length;
  expect(changed).toBe(9);
  expect(corner.elevation[0]).toBeCloseTo(
    (field.surface.elevation[0] ?? 0) + 0.1,
    6
  );
});

it("adds seabed detail to deep water without flipping a cell, raising past the ceiling, or touching the shallows", () => {
  const field = terrain();
  const plain = worldTerrain({
    islands,
    settings: withoutDetail,
    terrain: field,
  });
  const detailed = worldTerrain({ islands, terrain: field });
  const { clearAbove } = defaultWorldTerrainSettings.detail;
  expect(
    failing(field, (at, distance) => {
      const base = plain.elevation[at] ?? 0;
      const value = detailed.elevation[at] ?? 0;
      if (distance < 0 || base >= clearAbove) {
        return value === base;
      }
      return value <= Math.max(base, seabedCeiling);
    })
  ).toEqual([]);
  const changed = detailed.elevation.filter(
    (value, at) => value !== plain.elevation[at]
  ).length;
  expect(changed).toBeGreaterThan(field.width * field.height * 0.5);
  expectCoastsKept(detailed);
});

it("keeps detail off a seabed raised into the shallows by a feature", () => {
  const field = terrain();
  const raised = worldTerrain({
    contributions: [everywhere(field, 10)],
    islands,
    settings: withoutPasses,
    terrain: field,
  });
  const detailed = worldTerrain({
    contributions: [everywhere(field, 10)],
    islands,
    terrain: field,
  });
  expect(same(detailed.elevation, raised.elevation)).toBe(true);
});

/** The structural surface with its sea cells replaced by a ramp from 20 m in the west to the abyss in the east. */
function rampSurface(field: ReturnType<typeof terrain>): TerrainSurface {
  const elevation = Float32Array.from(field.surface.elevation);
  const shallow = elevationAtDepth(20);
  for (const [at, distance] of field.signedDistance.entries()) {
    if (distance >= 0) {
      const t = (at % field.width) / (field.width - 1);
      elevation[at] = shallow + (geologyLevels.abyss - shallow) * t;
    }
  }
  return { ...field.surface, elevation };
}

it("steps the seabed into plates: flat treads between levels, short risers across them", () => {
  const field = terrain();
  const surface = rampSurface(field);
  const smooth = worldTerrain({
    islands,
    settings: withoutPasses,
    surface,
    terrain: field,
  });
  const stepped = worldTerrain({
    islands,
    settings: withoutDetail,
    surface,
    terrain: field,
  });
  const knots = defaultWorldTerrainSettings.terrace.levels
    .map(elevationAtDepth)
    .sort((a, b) => a - b);
  /** The span of levels an elevation lies in, and how far up it, 0 to 1. */
  const spanOf = (elevation: number) => {
    const index = knots.findIndex(
      (knot, at) => elevation >= knot && elevation <= (knots[at + 1] ?? knot)
    );
    const lower = knots[index] ?? 0;
    const upper = knots[index + 1] ?? 0;
    return { index, t: (elevation - lower) / (upper - lower) };
  };
  let tread = 0;
  let treads = 0;
  let riser = 0;
  let risers = 0;
  expect(
    failing(field, (at, distance) => {
      const before = smooth.elevation[at] ?? 0;
      const after = stepped.elevation[at] ?? 0;
      if (distance < 0) {
        return after === before;
      }
      const span = spanOf(before);
      if (span.index < 0) {
        return after === before;
      }
      // Far from both coasts, the ramp's east-west slope is all there is.
      const column = at % field.width;
      if (distance > 80 && column > 0 && column < field.width - 1) {
        const slope = Math.abs(
          (stepped.elevation[at + 1] ?? 0) - (stepped.elevation[at - 1] ?? 0)
        );
        if (Math.abs(span.t - 0.5) < 0.15) {
          tread += slope;
          treads += 1;
        } else if (Math.min(span.t, 1 - span.t) < 0.05) {
          riser += slope;
          risers += 1;
        }
      }
      return (
        spanOf(after).index === span.index &&
        after <= seabedCeiling &&
        after < geologyLevels.waterLevel
      );
    })
  ).toEqual([]);
  expect(treads).toBeGreaterThan(100);
  expect(risers).toBeGreaterThan(100);
  expect(tread / treads).toBeLessThan(riser / risers / 4);
});

it("starts the sea from the platformed seabed and adds features to it", () => {
  const field = terrain();
  const platform = archipelagoPlatform({
    islands: islands.map((item) => ({ ...item, group: "" })),
    terrain: field,
  });
  const world = worldTerrain({
    islands,
    platform,
    settings: withoutPasses,
    terrain: field,
  });
  const nudged = worldTerrain({
    contributions: [everywhere(field, -0.05)],
    islands,
    platform,
    settings: withoutPasses,
    terrain: field,
  });
  expect(world.key).not.toBe(
    worldTerrain({ islands, settings: withoutPasses, terrain: field }).key
  );
  expect(
    failing(field, (at, distance) => {
      const seabed = platform.seabed[at] ?? Number.NaN;
      if (distance < 0) {
        return nudged.elevation[at] === world.elevation[at];
      }
      return (
        world.elevation[at] === seabed &&
        Math.abs(
          (nudged.elevation[at] ?? 0) -
            Math.max(geologyLevels.trenchFloor, seabed - 0.05)
        ) < tolerance
      );
    })
  ).toEqual([]);
  expect(
    platform.seabed.some(
      (value, at) => value > (field.surface.elevation[at] ?? 0)
    )
  ).toBe(true);
  expectCoastsKept(world);
  expectCoastsKept(nudged);
});

it("is deterministic and cached by content", () => {
  const field = terrain();
  const settings = { ...defaultWorldTerrainSettings, cacheEntries: 1 };
  const reseed = {
    ...settings,
    detail: { ...settings.detail, seed: "other" },
  };
  const first = worldTerrain({ islands, settings, terrain: field });
  expect(worldTerrain({ islands, settings, terrain: field })).toBe(first);
  // Another content evicts the first, so the next build is fresh.
  const reseeded = worldTerrain({ islands, settings: reseed, terrain: field });
  const second = worldTerrain({ islands, settings, terrain: field });
  expect(second).not.toBe(first);
  expect(second.key).toBe(first.key);
  expect(same(second.elevation, first.elevation)).toBe(true);
  expect(same(second.owner, first.owner)).toBe(true);
  expect(reseeded.key).not.toBe(first.key);
  expect(same(reseeded.elevation, first.elevation)).toBe(false);
});

it("samples and differentiates the grid it holds", () => {
  const field = terrain();
  const world = worldTerrain({ islands, terrain: field });
  const h = field.cell;
  for (const [column, row] of [
    [3, 4],
    [40, 60],
    [Math.floor(field.width / 2), Math.floor(field.height / 2)],
    [field.width - 5, field.height - 7],
  ] as const) {
    const x = field.left + (column + 0.5) * field.cell;
    const y = field.top + (row + 0.5) * field.cell;
    expect(world.sample(x, y)).toBeCloseTo(
      world.elevation[row * field.width + column] ?? Number.NaN,
      6
    );
    const [gx, gy] = world.gradient(x, y);
    expect(gx).toBeCloseTo(
      (world.sample(x + h, y) - world.sample(x - h, y)) / (2 * h),
      9
    );
    expect(gy).toBeCloseTo(
      (world.sample(x, y + h) - world.sample(x, y - h)) / (2 * h),
      9
    );
  }
  // The coast descends seaward: east of island b the gradient points back west.
  const [east] = world.gradient(120 + 60, 30);
  expect(east).toBeLessThan(0);
});

it("builds the reference chart's world terrain quickly with coasts kept", async () => {
  const data = await loadSpyglass();
  const field = chartTerrain(data);
  const started = performance.now();
  const world = worldTerrain({ islands: data.territories, terrain: field });
  const elapsed = performance.now() - started;
  expect(elapsed).toBeLessThan(2000);
  expectCoastsKept(world);
  const plain = worldTerrain({
    islands: data.territories,
    settings: withoutPasses,
    terrain: field,
  });
  const ramp = rampLandform(field.settings.land);
  expect(
    failing(field, (at, distance) => {
      const base = field.surface.elevation[at] ?? 0;
      if (distance < 0) {
        const expected = ramp({ inland: -distance, islandId: "", x: 0, y: 0 });
        return Math.abs((plain.elevation[at] ?? 0) - expected) < tolerance;
      }
      return (
        plain.elevation[at] === base &&
        (world.elevation[at] ?? 0) <= Math.max(base, seabedCeiling)
      );
    })
  ).toEqual([]);
  // Every territory owns land of its own.
  const owned = new Set(world.owner.filter((owner) => owner >= 0));
  expect(owned.size).toBe(data.territories.length);
  expect([...world.islandIds].sort()).toEqual(
    data.territories.map((territory) => territory.id).sort()
  );
});
