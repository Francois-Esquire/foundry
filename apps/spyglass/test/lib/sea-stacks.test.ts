import { expect, it } from "vitest";
import type {
  DependencyEdge,
  DependencyNode,
} from "../../src/lib/dependency-graph-types";
import type { DependencyInventory } from "../../src/lib/dependency-inventory-types";
import {
  defaultSeaStackSettings,
  ownDependencies,
  type SeaStack,
  type SeaStackIsland,
  type SeaStackSource,
  seaStacks,
} from "../../src/lib/visualization/sea-stacks";
import type { Polygon } from "../../src/lib/visualization/types";
import { chartSeaStacks } from "../../src/web/layout/chart-sea-stacks";
import { loadSpyglass } from "../helpers/reference-spyglass";

const workspace = (id: string): DependencyNode => ({
  id,
  kind: "workspace",
  name: id,
});
const external = (id: string): DependencyNode => ({
  id,
  kind: "external",
  name: id,
  version: "1.0.0",
});
function edge(
  source: string,
  target: string,
  options: Partial<DependencyEdge> = {}
): DependencyEdge {
  return {
    kind: "dependencies",
    name: target,
    range: "*",
    resolution: "resolved",
    source,
    target,
    ...options,
  };
}
const files = (runtime: number, typeOnly = 0) => ({
  importingFiles: [],
  runtimeFiles: Array.from({ length: runtime }, (_, i) => `r${i}.ts`),
  typeOnlyFiles: Array.from({ length: typeOnly }, (_, i) => `t${i}.ts`),
});

function inventory(
  nodes: DependencyNode[],
  edges: DependencyEdge[]
): DependencyInventory {
  return {
    graph: {
      edges,
      nodes,
      resolution: { issues: [], status: "complete" },
      schemaVersion: 1,
    },
    packages: nodes
      .filter((node) => node.kind === "workspace")
      .map((node) => ({
        analysis: "available",
        declaredDependencies: {},
        id: node.id,
        name: node.name,
        path: node.id,
        role: "workspace",
      })),
    schemaVersion: 1,
    skipped: [],
  };
}

function island(id: string, x: number, y = 0, radius = 40): SeaStackIsland {
  const ring: [number, number][] = Array.from({ length: 48 }, (_, i) => [
    Math.cos((i * Math.PI) / 24) * radius,
    Math.sin((i * Math.PI) / 24) * radius * 0.7,
  ]);
  return { coast: [[ring]], id, radius, x, y };
}

function stackSource(islandId: string, name: string, reliance: number) {
  return {
    islandId,
    label: name,
    members: [islandId, `dependency:${name}`],
    reliance,
  } satisfies SeaStackSource;
}

/** Map units from a point to an island's coast, negative on its land. */
function coastDistance(
  shore: { coast: readonly Polygon[]; x: number; y: number },
  x: number,
  y: number
): number {
  let nearest = Number.POSITIVE_INFINITY;
  let inside = false;
  for (const polygon of shore.coast) {
    let crossings = 0;
    for (const ring of polygon) {
      for (let i = 0; i < ring.length; i += 1) {
        const [ax = 0, ay = 0] = ring[i] ?? [];
        const [bx = 0, by = 0] = ring[(i + 1) % ring.length] ?? [];
        const [px, py] = [x - shore.x, y - shore.y];
        const dx = bx - ax;
        const dy = by - ay;
        const span = dx * dx + dy * dy;
        const t =
          span > 0
            ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / span))
            : 0;
        nearest = Math.min(
          nearest,
          Math.hypot(px - ax - dx * t, py - ay - dy * t)
        );
        if (ay > py !== by > py && ax + ((py - ay) / (by - ay)) * dx > px) {
          crossings += 1;
        }
      }
    }
    inside ||= crossings % 2 === 1;
  }
  return inside ? -nearest : nearest;
}

/** Every stack clear of every coast and every other stack, off its own island, on its shelf ring. */
function expectClear(
  stacks: readonly SeaStack[],
  islands: readonly {
    coast: readonly Polygon[];
    id: string;
    x: number;
    y: number;
  }[]
) {
  const settings = defaultSeaStackSettings;
  for (const stack of stacks) {
    const distances = islands.map((each) => ({
      distance: coastDistance(each, stack.x, stack.y),
      id: each.id,
    }));
    const own = distances.find(({ id }) => id === stack.islandId);
    expect(own).toBeDefined();
    for (const { distance } of distances) {
      expect(distance).toBeGreaterThanOrEqual(
        stack.radius + settings.clearance.coast - 1e-6
      );
      expect(distance).toBeGreaterThanOrEqual((own?.distance ?? 0) - 1e-6);
    }
    expect(own?.distance).toBeLessThanOrEqual(settings.ring.outer + 1e-6);
    for (const other of stacks) {
      if (other !== stack) {
        expect(
          Math.hypot(other.x - stack.x, other.y - stack.y)
        ).toBeGreaterThanOrEqual(
          other.radius + stack.radius + settings.clearance.stack - 1e-6
        );
      }
    }
  }
}

it("finds each package's own runtime dependencies and how much it relies on each", () => {
  const data = inventory(
    [
      workspace("a"),
      workspace("b"),
      workspace("c"),
      external("solo"),
      external("shared"),
      external("deep"),
      external("tool"),
      external("types"),
      external("unused"),
      external("unknown"),
    ],
    [
      edge("a", "solo", { usage: files(3) }),
      edge("solo", "deep"),
      edge("a", "shared", { usage: files(9) }),
      edge("b", "shared"),
      edge("a", "tool", { kind: "devDependencies", usage: files(5) }),
      edge("a", "c", { range: "workspace:*" }),
      edge("b", "types", { usage: files(0, 2) }),
      edge("b", "unused", { usage: files(0) }),
      edge("b", "unknown"),
    ]
  );
  const { reliance } = defaultSeaStackSettings;
  expect(ownDependencies(data, ["a", "b"])).toEqual([
    {
      name: "solo",
      reliance: reliance.runtime.base + ((1 - reliance.runtime.base) * 3) / 7,
      territoryId: "a",
    },
    { name: "types", reliance: reliance.typeOnly, territoryId: "b" },
    { name: "unknown", reliance: reliance.unmeasured, territoryId: "b" },
    { name: "unused", reliance: reliance.declared, territoryId: "b" },
  ]);
  // Without b on the chart, a alone reaches what it shared with b.
  expect(ownDependencies(data, ["a"]).map(({ name }) => name)).toEqual([
    "shared",
    "solo",
  ]);
  // A package reached through another workspace package shares its dependencies.
  const through = {
    ...data,
    graph: data.graph && {
      ...data.graph,
      edges: [...data.graph.edges, edge("a", "b", { range: "workspace:*" })],
    },
  };
  expect(ownDependencies(through, ["a", "b"]).map(({ name }) => name)).toEqual([
    "solo",
  ]);
  expect(ownDependencies({ ...data, graph: undefined }, ["a", "b"])).toEqual(
    []
  );
});

it("places stacks the same way for any input order", () => {
  const islands = [island("a", -120), island("b", 120), island("c", 0, 160)];
  const sources = [
    stackSource("a", "one", 0.9),
    stackSource("a", "two", 0.4),
    stackSource("b", "three", 0.7),
    stackSource("c", "four", 0.2),
    stackSource("c", "five", 1),
  ];
  const stacks = seaStacks({ islands, sources });
  expect(stacks.length).toBe(sources.length);
  expect(
    seaStacks({
      islands: [...islands].reverse(),
      sources: [...sources].reverse(),
    })
  ).toEqual(stacks);
  expect(stacks.map(({ id }) => id)).toEqual([
    "stack:c+dependency:five",
    "stack:a+dependency:one",
    "stack:b+dependency:three",
    "stack:a+dependency:two",
    "stack:c+dependency:four",
  ]);
});

it("keeps stacks off land, apart, and on their own island's shelf", () => {
  // Close islands: a stack must not sit nearer a neighbour's coast than its own.
  const islands = [
    island("a", -60),
    island("b", 60),
    island("c", 0, 70, 30),
    island("d", 200, 40, 24),
  ];
  const sources = islands.flatMap((each) =>
    Array.from({ length: 5 }, (_, i) =>
      stackSource(each.id, `${each.id}${i}`, i / 4)
    )
  );
  const stacks = seaStacks({ islands, sources });
  expect(stacks.length).toBeGreaterThan(0);
  expectClear(stacks, islands);
});

it("grows stacks with reliance: the most relied upon break the surface, the least stay under", () => {
  const stacks = seaStacks({
    islands: [island("a", 0)],
    sources: [stackSource("a", "most", 1), stackSource("a", "least", 0)],
  });
  const most = stacks.find(({ label }) => label === "most");
  const least = stacks.find(({ label }) => label === "least");
  expect(most?.height).toBeGreaterThan(0);
  expect(least?.height).toBeLessThan(0);
  expect(most?.radius).toBeGreaterThan(least?.radius ?? 0);
  expect(most?.lean).toBeUndefined();
  expect(least?.lean?.angle).toBeCloseTo(defaultSeaStackSettings.lean, 9);
});

it("stops at each island's cap and the chart's, the most relied upon first", () => {
  const islands = Array.from({ length: 6 }, (_, i) =>
    island(`i${i}`, (i % 3) * 260, Math.floor(i / 3) * 260)
  );
  const sources = islands.flatMap((each, i) =>
    Array.from({ length: 9 }, (_, k) =>
      stackSource(each.id, `${each.id}-${k}`, (k + i) / 20)
    )
  );
  const all = seaStacks({ islands, sources });
  for (const each of islands) {
    expect(all.filter(({ islandId }) => islandId === each.id).length).toBe(
      defaultSeaStackSettings.perIsland
    );
  }
  const capped = seaStacks(
    { islands, sources },
    { ...defaultSeaStackSettings, cap: 7 }
  );
  expect(capped).toHaveLength(7);
  const weakestKept = Math.min(...capped.map(({ height }) => height));
  const kept = new Set(capped.map(({ id }) => id));
  for (const stack of all.filter(({ id }) => !kept.has(id))) {
    expect(stack.height).toBeLessThanOrEqual(weakestKept);
  }
});

it("raises no stack from the reference chart, which carries no inventory, and places given ones on its coasts", async () => {
  const data = await loadSpyglass();
  // The capture predates dependency inventories: nothing to stand for, so no stacks.
  expect(chartSeaStacks(data, [])).toEqual([]);
  const dependencies = data.territories.flatMap((territory, i) =>
    Array.from({ length: (i % 4) + 1 }, (_, k) => ({
      name: `${territory.label}-own-${k}`,
      reliance: ((i + k) % 5) / 4,
      territoryId: territory.id,
    }))
  );
  const stacks = chartSeaStacks(data, dependencies);
  expect(stacks).toEqual(chartSeaStacks(data, [...dependencies].reverse()));
  expect(stacks.length).toBeGreaterThan(dependencies.length / 2);
  expect(stacks.length).toBeLessThanOrEqual(defaultSeaStackSettings.cap);
  expectClear(stacks, data.territories);
  for (const stack of stacks) {
    const [territoryId, dependency] = stack.members;
    expect(territoryId).toBe(stack.islandId);
    expect(dependency).toBe(`dependency:${stack.label}`);
    expect(
      stack.label?.startsWith(
        data.territories.find(({ id }) => id === territoryId)?.label ?? "?"
      )
    ).toBe(true);
  }
});
