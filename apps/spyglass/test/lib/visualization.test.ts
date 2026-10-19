import { describe, expect, it } from "vitest";
import { fileFootprint } from "../../src/lib/file-placement";
import {
  deriveFoundations,
  positionFoundations,
} from "../../src/lib/visualization/foundations";
import {
  chartSize,
  settlePackages,
} from "../../src/lib/visualization/geography";
import { prepareFoundationGroups } from "../../src/lib/visualization/groups";
import { landContours } from "../../src/lib/visualization/island-geometry";
import {
  prepareVisualization,
  visualizationInputKey,
} from "../../src/lib/visualization/prepare";
import {
  type DependencyFoundation,
  defaultVisualizationSettings,
  type IslandGeometry,
  type VisualizationInput,
} from "../../src/lib/visualization/types";

function input(): VisualizationInput {
  const packages = ["a", "b", "c"].map((id, index) => ({
    id,
    layer: index % 2,
    size: 2,
  }));
  return {
    inventory: {
      graph: {
        edges: packages.map(({ id }) => ({
          kind: "dependencies",
          name: "zod",
          range: "^4",
          resolution: "resolved",
          source: id,
          target: "lock:zod",
        })),
        nodes: [
          ...packages.map(({ id }) => ({
            id,
            kind: "workspace" as const,
            name: id,
          })),
          { id: "lock:zod", kind: "external", name: "zod", version: "4.0.0" },
        ],
        resolution: { issues: [], source: "bun.lock", status: "complete" },
        schemaVersion: 1,
      },
      packages: packages.map(({ id }) => ({
        analysis: "available",
        declaredDependencies: { dependencies: { zod: "^4" } },
        id,
        name: id,
        path: id,
        role: "workspace",
      })),
      schemaVersion: 1,
      skipped: [],
    },
    modules: packages.flatMap(({ id }) => [
      { id: `${id}/one.ts`, package: id, x: -9, y: 0 },
      { id: `${id}/two.ts`, package: id, x: 9, y: 4 },
    ]),
    packages,
    routes: [
      { from: "a", to: "b", weight: 5 },
      { from: "b", to: "c", weight: 3 },
      { from: "c", to: "a", weight: 8 },
    ],
  };
}

function foundation(
  id: string,
  memberIds: string[],
  radius = 55
): DependencyFoundation {
  const locations = new Map(
    [...[...new Set(memberIds)].sort()].map((member, index) => [
      member,
      { x: index * 180, y: (index % 2) * 40 },
    ])
  );
  return {
    id,
    lobes: memberIds.map((territoryId) => ({
      territoryId,
      ...(locations.get(territoryId) ?? { x: 0, y: 0 }),
      radius,
      weight: 1,
    })),
    members: memberIds.map((territoryId) => ({
      direct: true,
      distance: 1,
      territoryId,
      weight: 1,
    })),
    name: id,
    prominence: memberIds.length,
    versions: [],
    x: 0,
    y: 0,
  };
}

function extractedGeometry(
  source: VisualizationInput,
  influence: number
): IslandGeometry[] {
  const islands = source.packages.map((pkg) => {
    const radius = fileFootprint(pkg.size);
    const modules = source.modules
      .filter((module) => module.package === pkg.id)
      .sort((a, b) => a.id.localeCompare(b.id));
    const [shallows = [], coast = [], hills = []] = landContours(
      modules,
      radius
    );
    return { coast, hills, id: pkg.id, radius, shallows, x: 0, y: 0 };
  });
  const foundations = source.inventory
    ? deriveFoundations(
        source.inventory,
        islands.map(({ id }) => id)
      )
    : [];
  settlePackages(
    islands,
    Object.fromEntries(source.packages.map(({ id, layer }) => [id, layer])),
    defaultVisualizationSettings.islandClearance,
    source.routes,
    foundations,
    influence
  );
  return islands;
}

describe("prepared foundation groups", () => {
  it("bakes nested contour planes without forcing a path across distant open water", () => {
    const source = foundation("distant", ["a", "b"]);
    const [a, b] = source.lobes;
    if (!(a && b)) {
      throw new Error("Missing lobes");
    }
    a.x = -1000;
    b.x = 1000;
    const [group] = prepareFoundationGroups([source]);
    expect(group?.slices).toHaveLength(6);
    expect(group?.footprint).toHaveLength(2);
    for (const polygon of group?.footprint ?? []) {
      // Every connected component belongs to a shelf; no artificial bridge crosses x=0.
      const xs = polygon.flat().map(([x]) => x);
      expect(Math.max(...xs) < 0 || Math.min(...xs) > 0).toBe(true);
    }
    const span = (polygons: NonNullable<typeof group>["footprint"]) => {
      const ys = polygons.flat(2).map(([, y]) => y);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(span(group?.slices?.[0] ?? [])).toBeGreaterThan(
      span(group?.slices?.at(-1) ?? [])
    );
  });
  it("coalesces exact membership and retains partially overlapping identities", () => {
    const first = foundation("zod", ["a", "b"]);
    const equivalent = foundation("schema", ["b", "a"], 75);
    const overlap = foundation("react", ["b", "c"]);
    const groups = prepareFoundationGroups([overlap, equivalent, first]);
    expect(groups).toHaveLength(2);
    expect(
      groups.map(({ memberIds, dependencyIds }) => ({
        dependencyIds,
        memberIds,
      }))
    ).toEqual([
      { dependencyIds: ["schema", "zod"], memberIds: ["a", "b"] },
      { dependencyIds: ["react"], memberIds: ["b", "c"] },
    ]);
    expect(groups.every((group) => group.footprint.length > 0)).toBe(true);
    expect(groups[0]?.footprint).toEqual(
      prepareFoundationGroups([equivalent])[0]?.footprint
    );
  });
  it("keeps every group beyond twelve and creates deterministic ids and footprints", () => {
    const foundations = Array.from({ length: 16 }, (_, index) =>
      foundation(`dependency-${index}`, ["anchor", `member-${index}`])
    );
    const saved = structuredClone(foundations);
    const groups = prepareFoundationGroups(foundations);
    expect(groups).toHaveLength(16);
    expect(new Set(groups.map(({ id }) => id)).size).toBe(16);
    expect(groups.flatMap(({ dependencyIds }) => dependencyIds).sort()).toEqual(
      foundations.map(({ id }) => id).sort()
    );
    expect(
      prepareFoundationGroups(
        [...foundations].reverse().map((field) => ({
          ...field,
          lobes: [...field.lobes].reverse(),
          members: [...field.members].reverse(),
        }))
      )
    ).toEqual(groups);
    expect(
      groups
        .flatMap(({ footprint }) => footprint.flat(2))
        .every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
    ).toBe(true);
    expect(foundations).toEqual(saved);
  });
  it("bakes a connected finite boundary around the shared consumers", () => {
    const source = foundation("shared", ["a", "b", "c"]);
    const [group] = prepareFoundationGroups([source]);
    expect(group?.footprint).toHaveLength(1);
    const points = group?.footprint.flat(2) ?? [];
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    for (const lobe of source.lobes) {
      expect(Math.min(...xs)).toBeLessThan(lobe.x);
      expect(Math.max(...xs)).toBeGreaterThan(lobe.x);
      expect(Math.min(...ys)).toBeLessThan(lobe.y);
      expect(Math.max(...ys)).toBeGreaterThan(lobe.y);
    }
    const ring = group?.footprint[0]?.[0] ?? [];
    expect(ring[0]).toEqual(ring.at(-1));
  });
  it("ignores unique memberships and safely handles no foundations", () => {
    expect(prepareFoundationGroups([])).toEqual([]);
    expect(
      prepareFoundationGroups([
        foundation("unique", ["a"]),
        foundation("duplicate", ["a", "a"]),
      ])
    ).toEqual([]);
  });
});

describe("visualization preparation and cache identity", () => {
  it("matches the extracted geometry pipeline without mutating its source", () => {
    const source = input();
    const saved = structuredClone(source);
    const actual = prepareVisualization(source);
    const islands = extractedGeometry(source, 1);
    const foundations = positionFoundations(
      source.inventory
        ? deriveFoundations(
            source.inventory,
            islands.map(({ id }) => id)
          )
        : [],
      islands
    );
    expect(actual.islands).toEqual(islands);
    expect(actual.foundations).toEqual(foundations);
    expect(actual.groups).toEqual(
      prepareFoundationGroups(foundations, islands)
    );
    expect({ height: actual.height, width: actual.width }).toEqual(
      chartSize(islands)
    );
    expect(source).toEqual(saved);
  });
  it("preserves the original zero-influence geometry", () => {
    const source = input();
    const settings = {
      ...defaultVisualizationSettings,
      foundationInfluence: 0,
    };
    expect(prepareVisualization(source, settings).islands).toEqual(
      extractedGeometry({ ...source, inventory: undefined }, 0)
    );
  });
  it("reuses identical content and normalized settings while invalidating schema and policy changes", () => {
    const source = input();
    const saved = prepareVisualization(source);
    expect(
      prepareVisualization(
        structuredClone(source),
        defaultVisualizationSettings,
        saved
      )
    ).toBe(saved);
    expect(
      prepareVisualization(source, {
        ...defaultVisualizationSettings,
        foundationInfluence: 9,
      })
    ).toEqual(
      prepareVisualization(source, {
        ...defaultVisualizationSettings,
        foundationInfluence: 4,
      })
    );
    const oldPolicy = structuredClone(saved);
    Reflect.set(oldPolicy, "policyVersion", 0);
    expect(
      prepareVisualization(source, defaultVisualizationSettings, oldPolicy)
    ).not.toBe(oldPolicy);
    const oldSchema = structuredClone(saved);
    Reflect.set(oldSchema, "schemaVersion", 0);
    expect(
      prepareVisualization(source, defaultVisualizationSettings, oldSchema)
    ).not.toBe(oldSchema);
    expect(
      prepareVisualization(
        source,
        { ...defaultVisualizationSettings, islandClearance: 80 },
        saved
      )
    ).not.toBe(saved);
    expect(
      prepareVisualization(
        source,
        { ...defaultVisualizationSettings, foundationInfluence: 0 },
        saved
      )
    ).not.toBe(saved);
  });
  it.each(["graph", "usage", "modules", "routes", "packages"] as const)(
    "invalidates saved geometry when %s changes",
    (field) => {
      const source = input();
      const saved = prepareVisualization(source);
      const changed = structuredClone(source);
      if (field === "graph") {
        changed.inventory?.graph?.nodes.push({
          id: "new",
          kind: "external",
          name: "new",
          version: "1",
        });
      }
      if (field === "usage") {
        const edge = changed.inventory?.graph?.edges[0];
        if (edge) {
          edge.usage = {
            importingFiles: ["a/one.ts"],
            runtimeFiles: ["a/one.ts"],
            typeOnlyFiles: [],
          };
        }
      }
      if (field === "modules") {
        changed.modules.push({ id: "a/new.ts", package: "a", x: 40, y: 10 });
      }
      if (field === "routes") {
        changed.routes.push({ from: "a", to: "c", weight: 100 });
      }
      if (field === "packages") {
        changed.packages.push({ id: "new", layer: 0, size: 1 });
      }
      expect(visualizationInputKey(changed)).not.toBe(saved.inputKey);
      const prepared = prepareVisualization(
        changed,
        defaultVisualizationSettings,
        saved
      );
      expect(prepared).not.toBe(saved);
      expect(prepared.inputKey).toBe(visualizationInputKey(changed));
    }
  );
  it("canonicalizes nested object keys and module ordering without changing identity", () => {
    const source = input();
    const reorderKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        return value.map(reorderKeys);
      }
      if (typeof value !== "object" || value === null) {
        return value;
      }
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, entry]) => [key, reorderKeys(entry)])
      );
    };
    const reordered = reorderKeys(source) as VisualizationInput;
    reordered.modules.reverse();
    const saved = prepareVisualization(source);
    expect(visualizationInputKey(reordered)).toBe(saved.inputKey);
    expect(
      prepareVisualization(reordered, defaultVisualizationSettings, saved)
    ).toBe(saved);
  });
  it("never reuses a key for inputs that produce different zero-influence geography", () => {
    const source = input();
    const reordered = structuredClone(source);
    reordered.packages.reverse();
    reordered.routes.reverse();
    reordered.modules.reverse();
    const settings = {
      ...defaultVisualizationSettings,
      foundationInfluence: 0,
    };
    const before = prepareVisualization(source, settings);
    const fresh = prepareVisualization(reordered, settings);
    const cached = prepareVisualization(reordered, settings, before);
    expect(cached.islands.map(({ id, x, y }) => ({ id, x, y }))).toEqual(
      fresh.islands.map(({ id, x, y }) => ({ id, x, y }))
    );
    expect(cached.inputKey).toBe(fresh.inputKey);
  });
  it("distinguishes a representative range of geometry inputs without accidental collisions", () => {
    const source = input();
    const keys = Array.from({ length: 500 }, (_, index) =>
      visualizationInputKey({
        ...source,
        routes: [{ from: "a", to: "b", weight: index }],
      })
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
