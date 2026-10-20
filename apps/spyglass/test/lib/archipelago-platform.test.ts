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
  const count = escarpmentSteps.benches.length + 1;
  const step = (escarpment - escarpmentSteps.foot) / count;
  const slopeAt = (outward: number) =>
    Math.abs(
      platformFloor({ inward: 0, outward: outward + 0.5 }) -
        platformFloor({ inward: 0, outward: outward - 0.5 })
    );
  // A bench, late in each step, is flatter than the riser at its start.
  expect(slopeAt(step * 0.9)).toBeLessThan(slopeAt(step * 0.2) / 10);
  // Each bench stands at its own depth, and the foot at the trench floor.
  for (const [index, depth] of escarpmentSteps.benches.entries()) {
    expect(
      platformFloor({ inward: 0, outward: step * (index + 0.9) })
    ).toBeCloseTo(elevationAtDepth(depth), 9);
  }
  expect(platformFloor({ inward: 0, outward: escarpment })).toBe(
    geologyLevels.trenchFloor
  );
  expect(
    platformFloor({ inward: 0, outward: escarpment - escarpmentSteps.foot })
  ).toBe(geologyLevels.trenchFloor);
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

/** The fixture's islands as platform islands, each grouped by its frame. */
function fixtureIslands(
  data: Awaited<ReturnType<typeof loadSpyglass>>
): PlatformIsland[] {
  const frameOf = new Map(
    data.frames.flatMap((frame) =>
      frame.territories.map((id) => [id, frame.id] as const)
    )
  );
  return data.territories.map((territory) => ({
    coast: territory.coast,
    group: frameOf.get(territory.id) ?? "",
    id: territory.id,
    radius: territory.radius,
    x: territory.x,
    y: territory.y,
  }));
}

/**
 * The platform's outline roughness: the squared perimeter of land and of
 * platform shallower than 150 m, over its area, in cells. A circle scores
 * about 4π; every bay and lobe raises it.
 */
function outlineRoughness(
  terrain: StructuralTerrain,
  platform: ReturnType<typeof archipelagoPlatform>
): number {
  const shelf = elevationAtDepth(150);
  const { height, width } = terrain;
  const inside = (column: number, row: number) => {
    if (column < 0 || row < 0 || column >= width || row >= height) {
      return false;
    }
    const at = row * width + column;
    return (
      (terrain.signedDistance[at] ?? 0) < 0 ||
      ((platform.frame[at] ?? -1) >= 0 && (platform.seabed[at] ?? -1) > shelf)
    );
  };
  let area = 0;
  let perimeter = 0;
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      if (!inside(column, row)) {
        continue;
      }
      area += 1;
      for (const [dc, dr] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        if (!inside(column + dc, row + dr)) {
          perimeter += 1;
        }
      }
    }
  }
  return (perimeter * perimeter) / area;
}

it("runs the rim in bays, lobes and spurs, rougher than the smooth union", async () => {
  const data = await loadSpyglass();
  const { terrain } = chartWorld(data);
  const islands = fixtureIslands(data);
  const smooth = archipelagoPlatform({
    islands,
    settings: {
      ...defaultPlatformSettings,
      outline: { ...defaultPlatformSettings.outline, amplitude: 0 },
    },
    terrain,
  });
  const rough = archipelagoPlatform({ islands, terrain });
  expect(outlineRoughness(terrain, rough)).toBeGreaterThan(
    outlineRoughness(terrain, smooth) * 1.12
  );
  // No bay cuts into an apron: near every coast the seabed stays above the rim.
  const rim = elevationAtDepth(defaultPlatformSettings.platformDepth.outer);
  let near = 0;
  const cut: number[] = [];
  for (const [at, distance] of terrain.signedDistance.entries()) {
    if (distance >= 0 && distance < defaultPlatformSettings.apronReach) {
      near += 1;
      if (!((rough.seabed[at] ?? -1) >= rim) && cut.push(at) >= 5) {
        break;
      }
    }
  }
  expect(near).toBeGreaterThan(1000);
  expect(cut).toEqual([]);
});

it("draws the same outline from the same seed and another from another", () => {
  const islands = [island("a", "", -90), island("b", "", 90, 40)];
  const terrain = terrainOf(islands);
  const reseeded = { ...defaultPlatformSettings, seed: "other" };
  const first = archipelagoPlatform({ islands, terrain });
  const other = archipelagoPlatform({ islands, settings: reseeded, terrain });
  // Fill the cache with other contents, so the next build is fresh.
  for (const seed of ["one", "two", "three", "four"]) {
    archipelagoPlatform({
      islands,
      settings: { ...defaultPlatformSettings, seed },
      terrain,
    });
  }
  const again = archipelagoPlatform({ islands, terrain });
  expect(again).not.toBe(first);
  expect(again.seabed).toEqual(first.seabed);
  expect(other.seabed).not.toEqual(first.seabed);
});

it("stands each island on a pale bank and sinks the platform into basins between them", async () => {
  const data = await loadSpyglass();
  const { platform, terrain, world } = chartWorld(data);
  const bank: number[] = [];
  const interior: number[] = [];
  const rendered: number[] = [];
  for (const [at, distance] of terrain.signedDistance.entries()) {
    if (distance < 0 || (platform.frame[at] ?? -1) < 0) {
      continue;
    }
    const depth = nominalDepth(platform.seabed[at] ?? 0);
    if (distance <= 10) {
      bank.push(depth);
    }
    // Past every apron but short of the escarpment: the platform's interior.
    if (distance > 60 && distance <= 140 && depth < 250) {
      interior.push(depth);
      rendered.push(nominalDepth(world.elevation[at] ?? 0));
    }
  }
  const quantile = (values: number[], share: number) =>
    [...values].sort((a, b) => a - b)[
      Math.floor(share * (values.length - 1))
    ] ?? 0;
  // A bank hugs every coast in the shallows.
  expect(bank.length).toBeGreaterThan(1000);
  expect(quantile(bank, 0.9)).toBeLessThan(20);
  // Between the islands the platform drops into basins, some deeper than others.
  expect(interior.length).toBeGreaterThan(5000);
  expect(quantile(interior, 0.5)).toBeGreaterThan(80);
  expect(quantile(interior, 0.9) - quantile(interior, 0.1)).toBeGreaterThan(30);
  expect(quantile(interior, 0.1)).toBeGreaterThan(quantile(bank, 0.9));
  // The terraces keep the spread as plates at different depths.
  expect(quantile(rendered, 0.9) - quantile(rendered, 0.1)).toBeGreaterThan(10);
});

it("lets each riser of the escarpment wander within its step", () => {
  const { escarpment, escarpmentSteps } = defaultPlatformSettings;
  const step =
    (escarpment - escarpmentSteps.foot) / (escarpmentSteps.benches.length + 1);
  const rim = platformFloor({ inward: 0, outward: 0 });
  // Early in the first step the riser has begun at the step's start, but
  // not where it stands at the step's end.
  const early = step * 0.2;
  expect(platformFloor({ inward: 0, outward: early })).toBeLessThan(rim);
  expect(
    platformFloor({ inward: 0, outward: early, risers: () => 1 })
  ).toBeCloseTo(rim, 9);
  // Wherever a riser stands, it reaches its bench by the step's end.
  for (const place of [0, 0.5, 1]) {
    expect(
      platformFloor({ inward: 0, outward: step * 0.999, risers: () => place })
    ).toBeCloseTo(elevationAtDepth(escarpmentSteps.benches[0] ?? 0), 3);
  }
});

it("blends every apron into the platform without a ring at one distance", async () => {
  const data = await loadSpyglass();
  const { world } = chartWorld(data);
  /** Offsets past each coast vertex where the depth along the outward ray steepens most. */
  const steps = (territory: (typeof data.territories)[number]) => {
    const offsets: number[] = [];
    for (const polygon of territory.coast) {
      const ring = polygon[0] ?? [];
      const stride = Math.max(1, Math.floor(ring.length / 24));
      for (let index = 0; index < ring.length; index += stride) {
        const [px = 0, py = 0] = ring[index] ?? [];
        const length = Math.hypot(px, py);
        const profile: number[] = [];
        for (let offset = 0; offset <= 80 && length > 0; offset += 1) {
          const x = territory.x + px + (px / length) * offset;
          const y = territory.y + py + (py / length) * offset;
          const elevation = world.sample(x, y);
          if (offset > 3 && elevation >= 0) {
            break;
          }
          profile.push(nominalDepth(elevation));
        }
        let steepest = -1;
        let most = 0.5;
        for (let at = 6; at < profile.length - 2; at += 1) {
          const slope = ((profile[at + 2] ?? 0) - (profile[at - 2] ?? 0)) / 4;
          if (slope > most) {
            most = slope;
            steepest = at;
          }
        }
        if (steepest >= 0) {
          offsets.push(steepest);
        }
      }
    }
    return offsets;
  };
  /** The largest share of offsets within three map units of any one offset. */
  const modalShare = (offsets: readonly number[]) => {
    let best = 0;
    for (let centre = 0; centre <= 80; centre += 1) {
      const near = offsets.filter((offset) => Math.abs(offset - centre) <= 3);
      best = Math.max(best, near.length / offsets.length);
    }
    return best;
  };
  const all: number[] = [];
  const shares: number[] = [];
  for (const territory of data.territories) {
    const offsets = steps(territory);
    all.push(...offsets);
    if (offsets.length >= 6) {
      shares.push(modalShare(offsets));
    }
  }
  expect(shares.length).toBeGreaterThan(10);
  // A ring puts most of an island's steepest steps at one offset.
  expect(
    shares.reduce((sum, share) => sum + share, 0) / shares.length
  ).toBeLessThan(0.5);
  // Nor do the islands share one offset among them.
  expect(modalShare(all)).toBeLessThan(0.3);
});
