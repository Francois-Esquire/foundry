import { describe, expect, it } from "vitest";
import {
  contributionAt,
  contributionBoundary,
  defaultTerrainSettings,
  depthContours,
  falloff,
  landReading,
  structuralTerrain,
  type TerrainContributionSource,
  type TerrainInput,
  type TerrainIsland,
  terrainAt,
  terrainContributions,
  terrainLevels,
  terrainSilhouette,
  waterDepth,
} from "../../src/lib/visualization/terrain";

function island(id: string, x: number, y = 0, radius = 40): TerrainIsland {
  const ring: [number, number][] = Array.from({ length: 48 }, (_, i) => [
    Math.cos((i * Math.PI) / 24) * radius,
    Math.sin((i * Math.PI) / 24) * radius,
  ]);
  return { coast: [[ring]], id, radius, x, y };
}

function shared(
  memberIds: string[],
  dependencies = 1,
  id = `group:${memberIds.join("+")}`
): TerrainContributionSource {
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

function internal(
  supplierId: string,
  dependents: string[]
): TerrainContributionSource {
  return terrainContributions(
    [],
    [],
    [
      {
        id: `workspace:${supplierId}`,
        members: dependents.map((territoryId) => ({
          direct: true,
          distance: 1,
          territoryId,
          weight: 1,
        })),
        prominence: dependents.length,
        supplierId,
      },
    ]
  )[0] as TerrainContributionSource;
}

function terrain(
  islands: TerrainIsland[],
  contributions: TerrainContributionSource[] = [],
  extent = { height: 600, width: 1400 }
) {
  const input: TerrainInput = { contributions, extent, islands };
  return structuralTerrain(input);
}

const area = (
  field: ReturnType<typeof terrain>,
  polygons: [number, number][][][]
) =>
  polygons.reduce((sum, polygon) => {
    const ringArea = (ring: [number, number][]) =>
      Math.abs(
        ring.reduce((total, [x, y], i) => {
          const [nx, ny] = ring[(i + 1) % ring.length] ?? [x, y];
          return total + x * ny - nx * y;
        }, 0) / 2
      );
    const [outer = [], ...holes] = polygon;
    return (
      sum + ringArea(outer) - holes.reduce((h, ring) => h + ringArea(ring), 0)
    );
  }, 0) /
  field.cell ** 2;

describe("structural terrain", () => {
  it("leaves two islands without shared dependencies on open abyss", () => {
    const field = terrain([island("a", -200), island("b", 200)]);
    const middle = terrainAt(field, field.surface.elevation, 0, 0);
    // Only the exponential tail of each island's own descent remains.
    expect(middle).toBeCloseTo(terrainLevels.abyss, 2);
    expect(terrainAt(field, field.surface.shelf, 0, 0)).toBe(0);
    expect(terrainAt(field, field.surface.basement, 0, 0)).toBe(0);
    // Each island's own descent still makes a separate formation.
    expect(terrainSilhouette(field)).toHaveLength(2);
  });

  it("raises a pair's shelf nearer the surface as shared dependencies accumulate", () => {
    const islands = [island("a", -90), island("b", 90)];
    const one = terrain(islands, [shared(["a", "b"], 1)]);
    const several = terrain(islands, [shared(["a", "b"], 8)]);
    const at = (field: ReturnType<typeof terrain>) =>
      terrainAt(field, field.surface.elevation, 0, 0);
    expect(at(one)).toBeGreaterThan(terrainLevels.abyss + 0.1);
    expect(at(several)).toBeGreaterThan(at(one) + 0.15);
    expect(at(several)).toBeLessThan(terrainLevels.shelfTop);
    // Thickness keeps the count itself: eight times one dependency's.
    expect(terrainAt(several, several.surface.shelf, 0, 0)).toBeCloseTo(
      8 * terrainAt(one, one.surface.shelf, 0, 0),
      4
    );
  });

  it("keeps partially overlapping groups as separate contributions that add", () => {
    const islands = [island("a", -160), island("b", 0), island("c", 160)];
    const left = shared(["a", "b"], 2);
    const right = shared(["b", "c"], 3);
    const field = terrain(islands, [left, right]);
    expect(field.contributions.map(({ source }) => source.id)).toEqual(
      [left.id, right.id].sort()
    );
    const [first, second] = field.contributions;
    if (!(first && second)) {
      throw new Error("Missing contributions");
    }
    // At b, both groups are full; the shelf counts both groups' dependencies.
    expect(contributionAt(field, first, 0, 45)).toBeCloseTo(1, 3);
    expect(contributionAt(field, second, 0, 45)).toBeCloseTo(1, 3);
    expect(terrainAt(field, field.surface.shelf, 0, 45)).toBeCloseTo(5, 3);
    // Isolating one group, or one of its dependencies, shows only its share.
    const focused = field.compose({ focus: left.id });
    expect(field.compose({ focus: left.dependencyIds[1] })).toBe(
      field.compose({ focus: left.dependencyIds[1] })
    );
    expect(terrainAt(field, focused.shelf, 0, 45)).toBeCloseTo(2, 3);
    expect(terrainAt(field, focused.shelf, 160, 45)).toBe(0);
    // Each keeps its own boundary; one union would have erased which is which.
    expect(contributionBoundary(field, first).length).toBeGreaterThan(0);
    expect(contributionBoundary(field, first)).not.toEqual(
      contributionBoundary(field, second)
    );
  });

  it("drops steeply between nearby foundations of sharply different depths", () => {
    const islands = [
      island("deep-a", -260),
      island("deep-b", -140),
      island("shallow-a", 140),
      island("shallow-b", 260),
    ];
    const field = terrain(islands, [
      shared(["deep-a", "deep-b"], 1),
      shared(["shallow-a", "shallow-b"], 24),
    ]);
    const along = Array.from({ length: 61 }, (_, i) => {
      const x = -200 + i * (400 / 60);
      return terrainAt(field, field.surface.elevation, x, 70);
    });
    const high = terrainAt(field, field.surface.elevation, 200, 70);
    const low = terrainAt(field, field.surface.elevation, -200, 70);
    expect(high - low).toBeGreaterThan(0.25);
    // No bridge: between them the seabed falls below both shelves.
    expect(Math.min(...along)).toBeLessThan(low);
    // The shallow shelf's face drops most of its height within 40 units.
    const edge = along.findIndex(
      (elevation, i) => i > 30 && elevation > low + 0.8 * (high - low)
    );
    const foot = along.findLastIndex(
      (elevation, i) => i < edge && elevation < low + 0.2 * (high - low)
    );
    expect(edge).toBeGreaterThan(0);
    expect((edge - foot) * (400 / 60)).toBeLessThanOrEqual(40);
  });

  it("controls the face's steepness by the profile's exponent", () => {
    const gentle = { exponent: 1, plateau: 10, width: 40 };
    const steep = { ...gentle, exponent: 4 };
    expect(falloff(5, steep)).toBe(1);
    expect(falloff(50, gentle)).toBeCloseTo(Math.exp(-1), 10);
    expect(falloff(50, steep)).toBeCloseTo(Math.exp(-1), 10);
    // Steeper holds longer, then falls faster beyond the width.
    expect(falloff(30, steep)).toBeGreaterThan(falloff(30, gentle));
    expect(falloff(80, steep)).toBeLessThan(falloff(80, gentle));
  });

  it("keeps distant consumers of one dependency disconnected", () => {
    const field = terrain(
      [island("west", -1000), island("east", 1000)],
      [shared(["west", "east"], 6)],
      { height: 600, width: 2400 }
    );
    const [contribution] = field.contributions;
    if (!contribution) {
      throw new Error("Missing contribution");
    }
    expect(contributionBoundary(field, contribution)).toHaveLength(2);
    expect(terrainSilhouette(field)).toHaveLength(2);
    expect(terrainAt(field, field.surface.elevation, 0, 0)).toBe(
      terrainLevels.abyss
    );
  });

  it("raises a deeper basement for an internally foundational package with no shared code", () => {
    const islands = [
      island("lib", 0, 0, 30),
      island("a", -170, 0),
      island("b", 170, 0),
      island("c", 0, 170),
      island("unrelated", 0, -190),
    ];
    const foundation = internal("lib", ["a", "b", "c"]);
    expect(foundation.kind).toBe("internal");
    const field = terrain(islands, [foundation]);
    const near = terrainAt(field, field.surface.elevation, 85, 0);
    expect(terrainAt(field, field.surface.shelf, 85, 0)).toBe(0);
    expect(terrainAt(field, field.surface.basement, 85, 0)).toBeGreaterThan(1);
    expect(near).toBeGreaterThan(terrainLevels.abyss + 0.1);
    expect(near).toBeLessThanOrEqual(terrainLevels.basementTop);
    // The basement centres on the supplier and reaches more weakly under dependents.
    expect(terrainAt(field, field.surface.basement, 0, 45)).toBeGreaterThan(
      terrainAt(field, field.surface.basement, -170, 55)
    );
    // An unrelated island sits in a recess, not on the basement.
    const recess = terrainAt(field, field.surface.basement, 0, -190 + 50);
    expect(recess).toBeLessThan(
      terrainAt(field, field.surface.basement, 0, -190 + 120)
    );
  });

  it("reshapes the outer silhouette when the terrain's influence changes", () => {
    const islands = [island("a", -110), island("b", 110), island("c", 0, 200)];
    const field = terrain(islands, [shared(["a", "b"], 6)]);
    const bare = terrainSilhouette(
      field,
      field.compose({ foundations: false })
    );
    const full = terrainSilhouette(field);
    // Without the shelf, a and b are separate; with it they share one outline.
    expect(bare).toHaveLength(3);
    expect(full.length).toBeLessThan(bare.length);
    expect(area(field, full)).toBeGreaterThan(area(field, bare));
    const stronger = terrain(islands, [shared(["a", "b"], 30)]);
    expect(area(stronger, terrainSilhouette(stronger))).toBeGreaterThan(
      area(field, full)
    );
  });

  it("anchors every shoreline at the water level beneath any shelf", () => {
    const islands = [island("a", -80), island("b", 80), island("c", 0, 120)];
    const field = terrain(islands, [
      shared(["a", "b", "c"], 40),
      internal("a", ["b", "c"]),
    ]);
    let flooded = 0;
    let emerged = 0;
    let highestOffshore: number = terrainLevels.abyss;
    for (const [index, distance] of field.signedDistance.entries()) {
      const elevation = field.surface.elevation[index] ?? 0;
      if (distance > field.cell && elevation >= terrainLevels.waterLevel) {
        emerged += 1;
      }
      if (distance < 0 && elevation < terrainLevels.waterLevel) {
        flooded += 1;
      }
      if (distance > 60) {
        highestOffshore = Math.max(highestOffshore, elevation);
      }
    }
    expect([emerged, flooded]).toEqual([0, 0]);
    expect(highestOffshore).toBeLessThanOrEqual(terrainLevels.shelfTop);
  });

  it("reads the same geography as ocean or as land", () => {
    const islands = [island("a", -100), island("b", 100), island("c", 0, 220)];
    const field = terrain(islands, [
      shared(["a", "b"], 5),
      internal("a", ["b", "c"]),
    ]);
    const ocean = landReading(field.surface, terrainLevels.waterLevel);
    const lowered = landReading(field.surface, -0.7);
    const depth = waterDepth(field.surface, -0.7);
    let misplacedCoast = 0;
    let submerged = 0;
    let both = 0;
    let added = 0;
    for (const [index, height] of lowered.entries()) {
      const land = (ocean[index] ?? 0) > 0;
      if (land !== (field.signedDistance[index] ?? 0) < 0) {
        misplacedCoast += 1;
      }
      // Lowering the water only uncovers land; it never moves or reshapes it.
      if (land && height <= 0) {
        submerged += 1;
      }
      if (height > 0 && (depth[index] ?? 0) > 0) {
        both += 1;
      }
      if (height > 0 && !land) {
        added += 1;
      }
    }
    expect([misplacedCoast, submerged, both]).toEqual([0, 0, 0]);
    expect(added).toBeGreaterThan(0);
    // The land reading's coast is the ocean reading's depth contour at that level.
    const [contour] = depthContours(field, [-0.7]);
    expect(contour?.length).toBeGreaterThan(0);
  });

  it("is deterministic, cached by content, and invalidated by layout or relationship changes", () => {
    const islands = [island("a", -90), island("b", 90)];
    const groups = [shared(["a", "b"], 2)];
    const first = terrain(islands, groups);
    expect(terrain(structuredClone(islands), structuredClone(groups))).toBe(
      first
    );
    expect(first.compose()).toBe(first.surface);
    const moved = terrain([island("a", -80), island("b", 90)], groups);
    expect(moved.key).not.toBe(first.key);
    const more = terrain(islands, [shared(["a", "b"], 3)]);
    expect(more.key).not.toBe(first.key);
    // A cache miss rebuilds identical fields from identical content.
    const reordered = structuralTerrain(
      {
        contributions: groups,
        extent: { height: 600, width: 1400 },
        islands: [...islands].reverse(),
      },
      { ...defaultTerrainSettings }
    );
    expect(Array.from(reordered.surface.elevation)).toEqual(
      Array.from(first.surface.elevation)
    );
  });
});

describe("terrain sources", () => {
  it("weighs groups by their dependencies and internal foundations by their dependents", () => {
    const sources = terrainContributions(
      [
        {
          dependencyIds: ["dependency:zod", "dependency:yaml"],
          id: "group:a+b",
          memberIds: ["b", "a"],
        },
      ],
      [
        {
          id: "dependency:zod",
          members: [
            { direct: true, distance: 1, territoryId: "a", weight: 1 },
            { direct: false, distance: 2, territoryId: "b", weight: 0.45 },
          ],
        },
        {
          id: "dependency:yaml",
          members: [
            { direct: true, distance: 1, territoryId: "a", weight: 1 },
            { direct: true, distance: 1, territoryId: "b", weight: 1 },
          ],
        },
      ],
      [
        {
          id: "workspace:lib",
          members: [
            { direct: true, distance: 1, territoryId: "a", weight: 1 },
            { direct: false, distance: 2, territoryId: "b", weight: 0.45 },
          ],
          prominence: 2,
          supplierId: "lib",
        },
      ]
    );
    expect(sources.map(({ id, kind }) => [id, kind])).toEqual([
      ["group:a+b", "shared"],
      ["workspace:lib", "internal"],
    ]);
    const [group, foundation] = sources;
    expect(group?.weight).toBeCloseTo(0.725 + 1, 10);
    expect(group?.dependencyIds).toEqual(["dependency:zod", "dependency:yaml"]);
    expect(group?.members.map(({ territoryId }) => territoryId)).toEqual([
      "a",
      "b",
    ]);
    expect(foundation?.weight).toBeCloseTo(1.45, 10);
    expect(foundation?.members).toEqual([
      { amplitude: 1, supplier: true, territoryId: "lib" },
      {
        amplitude: defaultTerrainSettings.dependentShare,
        territoryId: "a",
      },
      {
        amplitude: 0.45 * defaultTerrainSettings.dependentShare,
        territoryId: "b",
      },
    ]);
  });
});
