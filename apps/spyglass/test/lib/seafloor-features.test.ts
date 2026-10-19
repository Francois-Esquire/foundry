import { expect, it } from "vitest";
import {
  geologyLevels,
  type SeabedContribution,
  sampleGrid,
  seabedCeiling,
} from "../../src/lib/visualization/geology";
import {
  crossSection,
  defaultSeafloorSettings,
  type Seafloor,
  type SeafloorIsland,
  type SeafloorLink,
  type SeafloorSummit,
  seafloorFeatures,
  smoothPositive,
} from "../../src/lib/visualization/seafloor-features";
import {
  type StructuralTerrain,
  structuralTerrain,
  type TerrainContributionSource,
  terrainLevels,
} from "../../src/lib/visualization/terrain";

function island(
  id: string,
  x: number,
  y = 0,
  radius = 40,
  group?: string
): SeafloorIsland {
  const ring: [number, number][] = Array.from({ length: 48 }, (_, i) => [
    Math.cos((i * Math.PI) / 24) * radius,
    Math.sin((i * Math.PI) / 24) * radius,
  ]);
  return { coast: [[ring]], id, radius, x, y, ...(group && { group }) };
}

function shared(
  memberIds: string[],
  dependencies = 2
): TerrainContributionSource {
  return {
    dependencyIds: Array.from(
      { length: dependencies },
      (_, i) => `dependency:${memberIds.join("+")}:${i}`
    ),
    id: `group:${memberIds.join("+")}`,
    kind: "shared",
    members: memberIds.map((territoryId) => ({ amplitude: 1, territoryId })),
    weight: dependencies,
  };
}

function world(
  islands: SeafloorIsland[],
  options: {
    contributions?: TerrainContributionSource[];
    links?: SeafloorLink[];
    summits?: SeafloorSummit[];
  } = {},
  settings = defaultSeafloorSettings
) {
  const terrain = structuralTerrain({
    contributions: options.contributions ?? [],
    extent: { height: 700, width: 1100 },
    islands,
  });
  const seafloor = seafloorFeatures(
    {
      islands,
      links: options.links ?? [],
      summits: options.summits ?? [],
      terrain,
    },
    settings
  );
  return { seafloor, terrain };
}

/** A contribution's value at a map position: 0 outside its crop. */
function valueAt(
  terrain: StructuralTerrain,
  contribution: SeabedContribution,
  x: number,
  y: number
): number {
  const column =
    Math.floor((x - terrain.left) / terrain.cell) - contribution.column;
  const row = Math.floor((y - terrain.top) / terrain.cell) - contribution.row;
  if (
    column < 0 ||
    row < 0 ||
    column >= contribution.width ||
    row >= contribution.height
  ) {
    return 0;
  }
  return contribution.values[row * contribution.width + column] ?? 0;
}

/** The seabed with every contribution added to sea cells and clamped, as the contract composes. */
function compose(terrain: StructuralTerrain, seafloor: Seafloor): Float32Array {
  const elevation = Float32Array.from(terrain.surface.elevation);
  const added = new Float32Array(elevation.length);
  for (const contribution of seafloor.contributions) {
    for (let r = 0; r < contribution.height; r += 1) {
      for (let c = 0; c < contribution.width; c += 1) {
        const index =
          (contribution.row + r) * terrain.width + contribution.column + c;
        added[index] =
          (added[index] ?? 0) +
          (contribution.values[r * contribution.width + c] ?? 0);
      }
    }
  }
  for (let index = 0; index < elevation.length; index += 1) {
    if ((terrain.signedDistance[index] ?? 0) >= 0) {
      elevation[index] = Math.min(
        seabedCeiling,
        Math.max(
          geologyLevels.trenchFloor,
          (elevation[index] ?? 0) + (added[index] ?? 0)
        )
      );
    }
  }
  return elevation;
}

function byKind(seafloor: Seafloor, kind: string) {
  return seafloor.features.filter((feature) => feature.kind === kind);
}

function contributionOf(seafloor: Seafloor, id: string): SeabedContribution {
  const contribution = seafloor.contributions.find((item) => item.id === id);
  if (!contribution) {
    throw new Error(`No contribution for ${id}`);
  }
  return contribution;
}

/** Nine islands in a loose lattice, some related, two archipelagos, two summits. */
function busyWorld(settings = defaultSeafloorSettings) {
  const islands = [
    island("a", -360, -120, 40, "west"),
    island("b", -220, -120, 36, "west"),
    island("c", -360, 30, 34, "west"),
    island("d", -220, 40, 44, "west"),
    island("e", -300, 170, 30, "west"),
    island("f", 220, -100, 40, "east"),
    island("g", 360, -90, 38, "east"),
    island("h", 260, 70, 42, "east"),
    island("i", 380, 120, 30, "east"),
  ];
  return world(
    islands,
    {
      contributions: [shared(["a", "b"], 4), shared(["f", "g", "h"], 3)],
      links: [
        { from: "a", to: "c", weight: 30 },
        { from: "d", to: "b", weight: 12 },
        { from: "h", to: "i", weight: 18 },
        { from: "c", to: "e", weight: 2 },
      ],
      summits: [
        { id: "former:x", label: "x", members: ["x"], x: -140, y: 180 },
        { id: "former:y", label: "y", members: ["y"], x: 140, y: -260 },
      ],
    },
    settings
  );
}

it("raises a ridge between two related islands, under the shelves", () => {
  const { seafloor, terrain } = world([island("a", -70), island("b", 70)], {
    links: [{ from: "a", to: "b", weight: 20 }],
  });
  const [ridge] = byKind(seafloor, "ridge");
  expect(ridge?.id).toBe("ridge:a+b");
  expect(ridge?.members).toEqual(["a", "b"]);
  expect(byKind(seafloor, "channel")).toHaveLength(0);
  expect(ridge?.geometry.type).toBe("polyline");
  expect(ridge?.elevation).toBeLessThan(terrainLevels.shelfTop);
  const contribution = contributionOf(seafloor, "ridge:a+b");
  expect(valueAt(terrain, contribution, 0, 0)).toBeGreaterThan(0.05);
  // The crest is raised on the saddle, not beside it.
  expect(valueAt(terrain, contribution, 0, 0)).toBeGreaterThan(
    valueAt(terrain, contribution, 0, 60)
  );
  const composed = compose(terrain, seafloor);
  expect(sampleGrid(terrain, composed, 0, 0)).toBeLessThan(
    terrainLevels.shelfTop
  );
});

it("raises a ridge where islands share a shelf but no route", () => {
  const { seafloor } = world([island("a", -80), island("b", 80)], {
    contributions: [shared(["a", "b"], 1)],
  });
  expect(byKind(seafloor, "ridge").map((feature) => feature.id)).toEqual([
    "ridge:a+b",
  ]);
});

it("carves a channel between two unrelated nearby islands", () => {
  const { seafloor, terrain } = world([island("a", -70), island("b", 70)]);
  expect(byKind(seafloor, "ridge")).toHaveLength(0);
  const [channel] = byKind(seafloor, "channel");
  expect(channel?.id).toBe("channel:a+b");
  const contribution = contributionOf(seafloor, "channel:a+b");
  expect(valueAt(terrain, contribution, 0, 0)).toBeLessThan(-0.02);
  // It runs across the strait, midway between the coasts.
  const points =
    channel?.geometry.type === "polyline" ? channel.geometry.points : [];
  expect(points.length).toBeGreaterThan(2);
  for (const [x] of points) {
    expect(Math.abs(x)).toBeLessThan(terrain.cell * 2);
  }
  const ys = points.map(([, y]) => y);
  expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(40);
  // A channel stays above the abyss; trenches carve below it.
  expect(channel?.elevation).toBeGreaterThanOrEqual(geologyLevels.abyss);
});

it("leaves out a feature that would barely change the seabed", () => {
  const subtle = structuredClone(defaultSeafloorSettings);
  subtle.minRelief = 1;
  const { seafloor } = world([island("a", -70), island("b", 70)], {}, subtle);
  expect(seafloor.features).toHaveLength(0);
  expect(seafloor.contributions).toHaveLength(0);
});

it("leaves far-apart unrelated islands to the open abyss", () => {
  const { seafloor } = world([island("a", -300), island("b", 300)]);
  expect(seafloor.features).toHaveLength(0);
  expect(seafloor.contributions).toHaveLength(0);
});

it("keeps ids and values the same for any input order", () => {
  const islands = busyWorld().seafloor;
  const reordered = (() => {
    const base = [
      island("i", 380, 120, 30, "east"),
      island("h", 260, 70, 42, "east"),
      island("g", 360, -90, 38, "east"),
      island("f", 220, -100, 40, "east"),
      island("e", -300, 170, 30, "west"),
      island("d", -220, 40, 44, "west"),
      island("c", -360, 30, 34, "west"),
      island("b", -220, -120, 36, "west"),
      island("a", -360, -120, 40, "west"),
    ];
    return world(base, {
      contributions: [shared(["a", "b"], 4), shared(["f", "g", "h"], 3)],
      links: [
        { from: "e", to: "c", weight: 2 },
        { from: "i", to: "h", weight: 18 },
        { from: "b", to: "d", weight: 12 },
        { from: "c", to: "a", weight: 30 },
      ],
      summits: [
        { id: "former:y", label: "y", members: ["y"], x: 140, y: -260 },
        { id: "former:x", label: "x", members: ["x"], x: -140, y: 180 },
      ],
    }).seafloor;
  })();
  expect(reordered.features.map((feature) => feature.id)).toEqual(
    islands.features.map((feature) => feature.id)
  );
  expect(reordered.contributions).toEqual(islands.contributions);
});

it("crops every contribution inside the grid, finite, and zero on land", () => {
  const { seafloor, terrain } = busyWorld();
  expect(seafloor.contributions.length).toBe(seafloor.features.length);
  for (const contribution of seafloor.contributions) {
    expect(contribution.column).toBeGreaterThanOrEqual(0);
    expect(contribution.row).toBeGreaterThanOrEqual(0);
    expect(contribution.column + contribution.width).toBeLessThanOrEqual(
      terrain.width
    );
    expect(contribution.row + contribution.height).toBeLessThanOrEqual(
      terrain.height
    );
    expect(contribution.values).toHaveLength(
      contribution.width * contribution.height
    );
    // Tight: a crop smaller than a quarter of the grid.
    expect(contribution.width * contribution.height).toBeLessThan(
      (terrain.width * terrain.height) / 4
    );
    for (let r = 0; r < contribution.height; r += 1) {
      for (let c = 0; c < contribution.width; c += 1) {
        const value = contribution.values[r * contribution.width + c] ?? 0;
        expect(Number.isFinite(value)).toBe(true);
        const index =
          (contribution.row + r) * terrain.width + contribution.column + c;
        if ((terrain.signedDistance[index] ?? 0) < 0) {
          expect(value).toBe(0);
        }
      }
    }
  }
});

it("composes under the ceiling, leaves land alone, and respects every cap", () => {
  const { seafloor, terrain } = busyWorld();
  for (const kind of ["ridge", "channel", "seamount", "trench"] as const) {
    expect(byKind(seafloor, kind).length).toBeLessThanOrEqual(
      defaultSeafloorSettings[kind].cap
    );
  }
  expect(byKind(seafloor, "ridge").length).toBeGreaterThan(0);
  const composed = compose(terrain, seafloor);
  for (let index = 0; index < composed.length; index += 1) {
    const before = terrain.surface.elevation[index] ?? 0;
    if ((terrain.signedDistance[index] ?? 0) < 0) {
      expect(composed[index]).toBe(before);
    } else {
      expect(composed[index]).toBeLessThan(seabedCeiling);
    }
  }
});

it("stops each kind at its cap, strongest first", () => {
  const capped = structuredClone(defaultSeafloorSettings);
  capped.ridge.cap = 1;
  capped.channel.cap = 1;
  capped.seamount.cap = 1;
  capped.trench.cap = 0;
  const all = busyWorld().seafloor;
  const { seafloor } = busyWorld(capped);
  expect(byKind(all, "channel").length).toBeGreaterThan(1);
  expect(byKind(seafloor, "ridge")).toHaveLength(1);
  expect(byKind(seafloor, "channel")).toHaveLength(1);
  expect(byKind(seafloor, "seamount")).toHaveLength(1);
  expect(byKind(seafloor, "trench")).toHaveLength(0);
  const strongest = Math.max(
    ...byKind(all, "ridge").map((feature) => feature.strength)
  );
  expect(byKind(seafloor, "ridge")[0]?.strength).toBe(strongest);
});

it("raises a seamount for a summit and carves a trench between archipelagos", () => {
  const { seafloor, terrain } = busyWorld();
  const seamount = seafloor.features.find(
    (feature) => feature.id === "seamount:former:x"
  );
  expect(seamount?.geometry).toEqual({ point: [-140, 180], type: "point" });
  expect(seamount?.members).toEqual(["x"]);
  expect(
    valueAt(terrain, contributionOf(seafloor, "seamount:former:x"), -140, 180)
  ).toBeGreaterThan(0.05);
  const [trench] = byKind(seafloor, "trench");
  expect(trench?.id).toBe("trench:east+west");
  expect(trench?.elevation).toBeLessThan(geologyLevels.abyss);
  expect(
    Math.min(...contributionOf(seafloor, "trench:east+west").values)
  ).toBeLessThan(0);
  // Channels never cross between archipelagos; that seam is the trench's.
  for (const channel of byKind(seafloor, "channel")) {
    const [a = "", b = ""] = channel.members;
    expect("abcde".includes(a)).toBe("abcde".includes(b));
  }
});

it("scales every feature by the global intensity", () => {
  const off = structuredClone(defaultSeafloorSettings);
  off.intensity = 0;
  expect(busyWorld(off).seafloor.features).toHaveLength(0);
});

it("shapes cross-sections smoothly, wider on the leaning side", () => {
  const profile = { asymmetry: 0.5, width: 10 };
  expect(crossSection(0, profile)).toBe(1);
  expect(crossSection(10, profile)).toBeGreaterThan(crossSection(-10, profile));
  expect(crossSection(1e-3, profile)).toBeCloseTo(
    crossSection(-1e-3, profile),
    6
  );
  expect(crossSection(3, { ...profile, plateau: 4 })).toBe(1);
  expect(smoothPositive(-1, 0.1)).toBe(0);
  expect(smoothPositive(1, 0.1)).toBe(1);
  expect(smoothPositive(0, 0.1)).toBeCloseTo(0.025, 6);
});
