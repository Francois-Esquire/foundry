import { expect, it } from "vitest";
import { defaultCoastSettings } from "../../src/lib/visualization/coasts";
import {
  elevationAtDepth,
  nominalDepth,
  rampLandform,
} from "../../src/lib/visualization/geology";
import {
  defaultLagoonSettings,
  type Inlet,
  type LagoonSite,
} from "../../src/lib/visualization/lagoons";
import {
  structuralTerrain,
  type TerrainIsland,
} from "../../src/lib/visualization/terrain";
import {
  type WorldTerrain,
  worldTerrain,
} from "../../src/lib/visualization/world-terrain";
import { chartWorld } from "../../src/web/layout/chart-world";
import { geologyLattice } from "../../src/web/layout/geology-lattice";
import { loadSpyglass } from "../helpers/reference-spyglass";

function round(
  id: string,
  x: number,
  y: number,
  radius: number
): TerrainIsland {
  const ring: [number, number][] = Array.from({ length: 96 }, (_, i) => [
    Math.cos((i * Math.PI) / 48) * radius,
    Math.sin((i * Math.PI) / 48) * radius,
  ]);
  return { coast: [[ring]], id, radius, x, y };
}

const beachHeight = 0.024;
const atoll = round("atoll", 0, 0, 90);
const neighbour = round("neighbour", 150, 0, 40);
const site: LagoonSite = { beachHeight, islandId: "atoll", shore: 34 };

function build(landformKey = "ramp"): WorldTerrain {
  const terrain = structuralTerrain({
    contributions: [],
    extent: { height: 500, width: 600 },
    islands: [atoll, neighbour],
  });
  // An apron as the platform lays one: 5 m at the coast, deepening gently.
  const elevation = Float32Array.from(terrain.signedDistance, (distance, at) =>
    distance < 0
      ? (terrain.surface.elevation[at] ?? 0)
      : elevationAtDepth(5 + 0.25 * distance)
  );
  return worldTerrain({
    coasts: defaultCoastSettings,
    islands: [atoll, neighbour],
    lagoons: { settings: defaultLagoonSettings, sites: [site] },
    landform: rampLandform(40),
    landformKey,
    surface: { ...terrain.surface, elevation },
    terrain,
  });
}

/** Cells inside a coast below the water: an atoll's lagoon and inlets. */
function lagoonCells(world: WorldTerrain): number[] {
  return [...world.elevation.keys()].filter(
    (at) =>
      (world.signedDistance[at] ?? 0) < 0 && (world.elevation[at] ?? 0) < 0
  );
}

/** Whether water cells connect a lagoon cell to open sea, `clear` map units past any coast. */
function reachesSea(world: WorldTerrain, from: number, clear: number) {
  const seen = new Uint8Array(world.elevation.length);
  const stack = [from];
  seen[from] = 1;
  while (stack.length) {
    const at = stack.pop() as number;
    if ((world.signedDistance[at] ?? 0) > clear) {
      return true;
    }
    for (const next of [at - 1, at + 1, at - world.width, at + world.width]) {
      if (
        next >= 0 &&
        next < seen.length &&
        !seen[next] &&
        (world.elevation[next] ?? 0) < 0
      ) {
        seen[next] = 1;
        stack.push(next);
      }
    }
  }
  return false;
}

/** A map position `along` map units down an inlet's centre line. */
function alongInlet(inlet: Inlet, along: number): [number, number] {
  let index = 1;
  while (
    index < inlet.lengths.length - 1 &&
    (inlet.lengths[index] ?? 0) < along
  ) {
    index += 1;
  }
  const [ax = 0, ay = 0] = inlet.points[index - 1] ?? [];
  const [bx = 0, by = 0] = inlet.points[index] ?? [];
  const from = inlet.lengths[index - 1] ?? 0;
  const t = (along - from) / Math.max(1e-6, (inlet.lengths[index] ?? 0) - from);
  return [ax + (bx - ax) * t, ay + (by - ay) * t];
}

/** The narrowest water across an inlet, map units, from where it leaves the lagoon to where it crosses the coast. */
function narrowestWater(world: WorldTerrain, inlet: Inlet): number {
  let narrowest = Number.POSITIVE_INFINITY;
  for (let along = inlet.lagoon; along <= inlet.coast; along += 1) {
    const [cx, cy] = alongInlet(inlet, along);
    const [nx, ny] = alongInlet(inlet, along + 1);
    const length = Math.hypot(nx - cx, ny - cy);
    const [px, py] = [-(ny - cy) / length, (nx - cx) / length];
    let width = 0;
    for (let offset = -20; offset <= 20; offset += 0.5) {
      width += world.sample(cx + px * offset, cy + py * offset) < 0 ? 0.5 : 0;
    }
    narrowest = Math.min(narrowest, width);
  }
  return narrowest;
}

function centre(world: WorldTerrain, at: number): [number, number] {
  return [
    world.left + ((at % world.width) + 0.5) * world.cell,
    world.top + (Math.floor(at / world.width) + 0.5) * world.cell,
  ];
}

it("carves an atoll's lagoon below the water inside its coast, shallow at the shore and deeper toward the middle", () => {
  const world = build();
  const cells = lagoonCells(world);
  const atollIndex = world.islandIds.indexOf("atoll");
  expect(cells.length).toBeGreaterThan(100);
  // Only the atoll is carved, and it keeps its lagoon's cells.
  expect(cells.every((at) => world.owner[at] === atollIndex)).toBe(true);
  const depths = cells.map((at) => nominalDepth(world.elevation[at] ?? 0));
  const { depth, floor } = defaultLagoonSettings;
  expect(Math.min(...depths)).toBeGreaterThanOrEqual(depth.edge - 0.01);
  expect(Math.max(...depths)).toBeLessThanOrEqual(
    Math.max(
      depth.centre + floor.amplitude,
      defaultLagoonSettings.inlet.depth
    ) + 0.01
  );
  expect(Math.max(...depths)).toBeGreaterThan(depth.centre - 1);
  // Shallow by the shore: cells beside the land are shallower than the middle.
  const shoreDepths = cells
    .filter((at) =>
      [at - 1, at + 1, at - world.width, at + world.width].some(
        (next) => (world.elevation[next] ?? 0) >= 0
      )
    )
    .map((at) => nominalDepth(world.elevation[at] ?? 0));
  const mean = (values: number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  expect(mean(shoreDepths)).toBeLessThan(0.5 * mean(depths));
});

it("meets the lagoon through an inner beach rather than a cliff", () => {
  const world = build();
  const atollIndex = world.islandIds.indexOf("atoll");
  const bank: number[] = [];
  for (const at of lagoonCells(world)) {
    for (const next of [at - 1, at + 1, at - world.width, at + world.width]) {
      if (
        world.owner[next] === atollIndex &&
        (world.elevation[next] ?? 0) >= 0
      ) {
        bank.push(world.elevation[next] ?? 0);
      }
    }
  }
  expect(bank.length).toBeGreaterThan(20);
  expect(Math.max(...bank)).toBeLessThanOrEqual(beachHeight + 1e-6);
});

it("opens the lagoon to the open sea through an inlet, aimed away from the neighbour", () => {
  const world = build();
  const [lagoon] = world.lagoons;
  // A lagoon this large takes a second inlet, a third of the compass round.
  expect(lagoon?.inlets.length).toBeGreaterThanOrEqual(1);
  expect(lagoon?.inlets.length).toBeLessThanOrEqual(2);
  const inlet = lagoon?.inlets[0];
  const [sx = 0, sy = 0] = inlet?.points[0] ?? [];
  const [ex = 0, ey = 0] = inlet?.points.at(-1) ?? [];
  // The neighbour lies east; the inlet runs anywhere but toward it.
  expect(
    (ex - sx) * (neighbour.x - sx) + (ey - sy) * (neighbour.y - sy)
  ).toBeLessThan(0);
  const deepest = lagoonCells(world).reduce((best, at) =>
    (world.elevation[at] ?? 0) < (world.elevation[best] ?? 0) ? at : best
  );
  expect(reachesSea(world, deepest, 3 * world.cell)).toBe(true);
});

it("keeps the inlet three cells wide and its floor continuous from the lagoon into the seabed", () => {
  const world = build();
  const inlet = world.lagoons[0]?.inlets[0];
  if (!inlet) {
    throw new Error("The atoll has no inlet.");
  }
  // From where it leaves the lagoon to where it crosses the coast, the
  // water across it is never narrower than 12 map units.
  expect(narrowestWater(world, inlet)).toBeGreaterThanOrEqual(12);
  const at = (along: number) => alongInlet(inlet, along);
  // From the lagoon across the coast to the apron beyond, the floor never
  // surfaces and never steps; past that the seabed's own slope takes over.
  const end = inlet.coast + 8;
  let previous = world.sample(...at(0));
  let steepest = 0;
  for (let along = 1; along <= end; along += 1) {
    const value = world.sample(...at(along));
    expect(value).toBeLessThan(0);
    steepest = Math.max(steepest, Math.abs(value - previous));
    previous = value;
  }
  expect(steepest).toBeLessThan(-elevationAtDepth(3));
});

it("leaves the lagoon's cells as the landform carves them: the terrace and detail passes are sea-only", () => {
  const world = build();
  for (const at of lagoonCells(world)) {
    const [x, y] = centre(world, at);
    const expected = world.landform({
      inland: -(world.signedDistance[at] ?? 0),
      islandId: "atoll",
      pieceDepth: world.pieceDepth[at] ?? 0,
      x,
      y,
    });
    expect(world.elevation[at]).toBeCloseTo(expected, 6);
  }
});

it("plans the same lagoon every build", () => {
  const first = build("first");
  const second = build("second");
  expect(second).not.toBe(first);
  expect(second.lagoons).toEqual(first.lagoons);
  expect(second.elevation).toEqual(first.elevation);
});

it("carves the reference atoll's lagoon and inlet, and the lattice draws them as water", async () => {
  const data = await loadSpyglass();
  const chart = chartWorld(data);
  const { world } = chart;
  const atolls = [...chart.landforms]
    .filter(([, { archetype }]) => archetype === "atoll")
    .map(([id]) => id)
    .sort();
  expect(world.lagoons.map(({ islandId }) => islandId)).toEqual(atolls);
  const cells = lagoonCells(world);
  expect(cells.length * world.cell ** 2).toBeGreaterThan(1000);
  const owners = new Set(
    cells.map((at) => world.islandIds[world.owner[at] ?? -1])
  );
  expect([...owners].sort()).toEqual(atolls);
  for (const lagoon of world.lagoons) {
    expect(lagoon.inlets.length).toBeGreaterThanOrEqual(1);
    for (const inlet of lagoon.inlets) {
      expect(narrowestWater(world, inlet)).toBeGreaterThanOrEqual(12);
    }
  }
  const deepest = cells.reduce((best, at) =>
    (world.elevation[at] ?? 0) < (world.elevation[best] ?? 0) ? at : best
  );
  expect(reachesSea(world, deepest, 3 * world.cell)).toBe(true);
  const lattice = geologyLattice({
    islands: chart.islands,
    landform: chart.landform,
    settings: { margin: 3, refine: 4, waterGap: 0.003 },
    world,
  });
  // A lattice vertex at a lagoon cell's centre is under water too.
  const lagoon = new Set(
    cells.filter((at) => (world.elevation[at] ?? 0) < -0.01)
  );
  let wet = 0;
  let checked = 0;
  for (const at of lagoon) {
    const id = at;
    checked += 1;
    wet += Number((lattice.elevation[id] ?? 0) < 0);
  }
  expect(checked).toBeGreaterThan(20);
  expect(wet / checked).toBeGreaterThan(0.95);
});
