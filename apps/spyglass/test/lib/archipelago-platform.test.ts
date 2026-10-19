import { expect, it } from "vitest";
import {
  archipelagoPlatform,
  defaultPlatformSettings,
  type PlatformIsland,
  platformFloor,
} from "../../src/lib/visualization/archipelago-platform";
import {
  elevationAtDepth,
  geologyLevels,
  nominalDepth,
  seabedCeiling,
} from "../../src/lib/visualization/geology";
import {
  type StructuralTerrain,
  structuralTerrain,
  type TerrainContributionSource,
} from "../../src/lib/visualization/terrain";
import { chartWorld } from "../../src/web/layout/chart-world";
import { loadSpyglass } from "../helpers/reference-spyglass";

type Point = [number, number];

function island(
  id: string,
  group: string,
  x: number,
  y = 0,
  radius = 30
): PlatformIsland {
  const ring: Point[] = Array.from({ length: 48 }, (_, i) => [
    Math.cos((i * Math.PI) / 24) * radius,
    Math.sin((i * Math.PI) / 24) * radius,
  ]);
  return { coast: [[ring]], group, id, radius, x, y };
}

function shared(memberIds: string[], dependencies: number) {
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
  } satisfies TerrainContributionSource;
}

function terrainOf(
  islands: readonly PlatformIsland[],
  contributions: TerrainContributionSource[] = []
): StructuralTerrain {
  return structuralTerrain({
    contributions,
    extent: { height: 400, width: 1000 },
    islands,
  });
}

/** The cell index under a map position. */
function cellAt(terrain: StructuralTerrain, x: number, y: number): number {
  const column = Math.floor((x - terrain.left) / terrain.cell);
  const row = Math.floor((y - terrain.top) / terrain.cell);
  return row * terrain.width + column;
}

/** A convex hull, anticlockwise in map coordinates, by the monotone chain. */
function convexHull(points: readonly Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Point, a: Point, b: Point) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const chain = (input: readonly Point[]) => {
    const out: Point[] = [];
    for (const point of input) {
      while (
        out.length >= 2 &&
        cross(out.at(-2) ?? point, out.at(-1) ?? point, point) <= 0
      ) {
        out.pop();
      }
      out.push(point);
    }
    return out.slice(0, -1);
  };
  return [...chain(sorted), ...chain([...sorted].reverse())];
}

function insideHull(hull: readonly Point[], [x, y]: Point): boolean {
  return hull.every((a, i) => {
    const b = hull[(i + 1) % hull.length] ?? a;
    return (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) >= 0;
  });
}

/** The largest 4-connected region of cells where `holds` is true, as a mask. */
function largestRegion(
  width: number,
  height: number,
  holds: (at: number) => boolean
): Uint8Array {
  const label = new Int32Array(width * height).fill(-1);
  let best = -1;
  let bestSize = 0;
  let next = 0;
  for (let start = 0; start < width * height; start += 1) {
    if (label[start] !== -1 || !holds(start)) {
      continue;
    }
    const stack = [start];
    label[start] = next;
    let size = 0;
    while (stack.length) {
      const at = stack.pop() ?? 0;
      size += 1;
      const column = at % width;
      for (const neighbour of [
        column > 0 ? at - 1 : -1,
        column < width - 1 ? at + 1 : -1,
        at - width,
        at + width,
      ]) {
        if (
          neighbour >= 0 &&
          neighbour < width * height &&
          label[neighbour] === -1 &&
          holds(neighbour)
        ) {
          label[neighbour] = next;
          stack.push(neighbour);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = next;
    }
    next += 1;
  }
  return Uint8Array.from(label, (value) => (value === best ? 1 : 0));
}

it("stands the fixture's islands on one shallow platform", async () => {
  const data = await loadSpyglass();
  const { world } = chartWorld(data);
  const shallow = elevationAtDepth(100);
  const region = largestRegion(
    world.width,
    world.height,
    (at) => (world.elevation[at] ?? -1) >= shallow
  );
  const islandsOn = new Set<number>();
  for (const [at, owner] of world.owner.entries()) {
    if (owner >= 0 && region[at]) {
      islandsOn.add(owner);
    }
  }
  expect(islandsOn.size / data.territories.length).toBeGreaterThanOrEqual(0.8);
  const hull = convexHull(
    data.territories.flatMap((territory) =>
      territory.coast.flatMap((polygon) =>
        (polygon[0] ?? []).map(
          ([x, y]): Point => [territory.x + x, territory.y + y]
        )
      )
    )
  );
  const depths: number[] = [];
  for (const [at, distance] of world.signedDistance.entries()) {
    const x = world.left + ((at % world.width) + 0.5) * world.cell;
    const y = world.top + (Math.floor(at / world.width) + 0.5) * world.cell;
    if (distance >= 0 && insideHull(hull, [x, y])) {
      depths.push(nominalDepth(world.elevation[at] ?? -1));
    }
  }
  depths.sort((a, b) => a - b);
  expect(depths.length).toBeGreaterThan(1000);
  expect(depths[Math.floor(depths.length / 2)]).toBeLessThan(100);
});

it("raises only sea cells, never past the apron's coast level, and leaves water beyond the platform at the abyss", async () => {
  const data = await loadSpyglass();
  const { platform, terrain } = chartWorld(data);
  const cap = elevationAtDepth(defaultPlatformSettings.apronDepth.coast);
  const failures: number[] = [];
  let beyond = 0;
  for (const [at, distance] of terrain.signedDistance.entries()) {
    const base = terrain.surface.elevation[at] ?? Number.NaN;
    const value = platform.seabed[at] ?? Number.NaN;
    const kept =
      distance < 0 || (platform.frame[at] ?? -1) < 0
        ? value === base
        : value >= base && value <= Math.max(base, cap) && value < 0;
    if (!kept && failures.push(at) >= 5) {
      break;
    }
    if (
      distance >
      defaultPlatformSettings.reach + defaultPlatformSettings.escarpment
    ) {
      beyond += 1;
      if (!(nominalDepth(value) > 1990) && failures.push(at) >= 5) {
        break;
      }
    }
  }
  expect(failures).toEqual([]);
  expect(beyond).toBeGreaterThan(1000);
  expect(cap).toBeLessThan(seabedCeiling);
});

it("gives each frame its own platform, falling to the abyss between frames", () => {
  // Two frames, each of two islands 100 units apart, with 240 units of
  // open water between the frames, as a collection's rims would set them.
  const islands = [
    island("p1", "p", -320),
    island("p2", "p", -160),
    island("q1", "q", 140),
    island("q2", "q", 300),
  ];
  const terrain = terrainOf(islands);
  const platform = archipelagoPlatform({ islands, terrain });
  expect(platform.groups).toEqual(["p", "q"]);
  // The midline keeps the islands' own descent, all but at the abyss.
  const midline = cellAt(terrain, -10, 0);
  expect(platform.frame[midline]).toBe(-1);
  expect(platform.seabed[midline]).toBe(terrain.surface.elevation[midline]);
  expect(nominalDepth(platform.seabed[midline] ?? 0)).toBeGreaterThan(1900);
  // Within a frame, the water between its islands is on the platform.
  for (const [x, frame] of [
    [-240, 0],
    [220, 1],
  ] as const) {
    const at = cellAt(terrain, x, 0);
    expect(platform.frame[at]).toBe(frame);
    expect(nominalDepth(platform.seabed[at] ?? -1)).toBeLessThan(100);
  }
  // The same islands as one frame share one platform across the gap.
  const joined = archipelagoPlatform({
    islands: islands.map((item) => ({ ...item, group: "" })),
    terrain,
  });
  expect(nominalDepth(joined.seabed[midline] ?? -1)).toBeLessThan(
    nominalDepth(platform.seabed[midline] ?? -1)
  );
});

it("stands shared shelves on the platform, shallower than the bare platform", () => {
  // The midpoint lies past both aprons, on the platform itself.
  const islands = [
    island("a", "", -100),
    island("b", "", 100),
    island("c", "", 0, 200),
  ];
  const bare = archipelagoPlatform({ islands, terrain: terrainOf(islands) });
  const shelved = archipelagoPlatform({
    islands,
    terrain: terrainOf(islands, [shared(["a", "b"], 6)]),
  });
  const between = cellAt(terrainOf(islands), 0, 0);
  expect(nominalDepth(shelved.seabed[between] ?? -1)).toBeLessThan(
    nominalDepth(bare.seabed[between] ?? -1) - 5
  );
  expect(shelved.seabed[between]).toBeLessThan(seabedCeiling);
});

it("falls from the rim to the deep in benches", () => {
  const { escarpment, escarpmentSteps } = defaultPlatformSettings;
  const rim = platformFloor({ inward: 0, outward: 0 });
  const step = escarpment / escarpmentSteps.count;
  const slopeAt = (outward: number) =>
    Math.abs(
      platformFloor({ inward: 0, outward: outward + 0.5 }) -
        platformFloor({ inward: 0, outward: outward - 0.5 })
    );
  // A bench, late in each step, is flatter than the riser at its start.
  expect(slopeAt(step * 0.9)).toBeLessThan(slopeAt(step * 0.2) / 10);
  expect(platformFloor({ inward: 0, outward: escarpment })).toBe(
    geologyLevels.trenchFloor
  );
  expect(rim).toBeCloseTo(
    elevationAtDepth(defaultPlatformSettings.platformDepth.outer),
    9
  );
});

it("is deterministic and cached by content", () => {
  const islands = [island("a", "", -60), island("b", "", 60)];
  const terrain = terrainOf(islands);
  const first = archipelagoPlatform({ islands, terrain });
  expect(archipelagoPlatform({ islands, terrain })).toBe(first);
  const regrouped = archipelagoPlatform({
    islands: [islands[0] as PlatformIsland, { ...island("b", "x", 60) }],
    terrain,
  });
  expect(regrouped.key).not.toBe(first.key);
});
