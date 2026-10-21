import { afterEach, expect, it, vi } from "vitest";
import { datasetReader } from "../../src/lib/dataset";
import {
  prepareVisualization,
  visualizationInputKey,
} from "../../src/lib/visualization/prepare";
import { readVisualizationInput } from "../../src/lib/visualization/read";
import { loadSpyglass } from "../../src/web/layout/load-spyglass";
import { memoryTransport, stubFetch } from "../helpers/dataset-transport";

vi.mock("../../src/lib/visualization/prepare", { spy: true });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function scanned(): Record<string, unknown> {
  const ids = ["b", "a"];
  const inventory = {
    graph: {
      edges: ids.map((source) => ({
        kind: "dependencies",
        name: "zod",
        range: "4",
        resolution: "resolved",
        source,
        target: "lock:zod",
      })),
      nodes: [
        ...ids.map((id) => ({ id, kind: "workspace", name: id })),
        { id: "lock:zod", kind: "external", name: "zod", version: "4.0.0" },
      ],
      resolution: { issues: [], source: "bun.lock", status: "complete" },
      schemaVersion: 1,
    },
    packages: ids.map((id) => ({
      analysis: "available",
      declaredDependencies: { dependencies: { zod: "4" } },
      id,
      name: id,
      path: `packages/${id}`,
      role: "workspace",
    })),
    schemaVersion: 1,
    skipped: [],
  };
  return {
    "dependencies/inventory.json": inventory,
    "lenses/domains.json": { domains: [], placements: [] },
    "lenses/file-roles.json": { packages: [] },
    "lenses/import-traffic.json": { pairs: [] },
    "lenses/package-sizes.json": {
      packages: ids.map((id, index) => ({
        analyzed: true,
        id,
        layer: index,
        modules: { byKind: { source: 1 }, total: 1 },
      })),
    },
    "lenses/placement.json": {
      packages: [],
      places: [],
      policy: { dominantShare: 0.6 },
    },
    "lenses/responsibility-groups.json": { packages: [] },
    "manifest.json": {
      coverage: "complete",
      files: {
        dependencyInventory: "dependencies/inventory.json",
        moduleIndex: "modules/index.json",
        projections: { dependencyGraph: "projections/graph.json" },
        visualization: "visualization/map.json",
      },
      generatedAt: "2026-10-19T00:00:00.000Z",
      lenses: Object.fromEntries(
        [
          "domains",
          "file-roles",
          "import-traffic",
          "package-sizes",
          "placement",
          "responsibility-groups",
        ].map((id) => [
          id,
          {
            file: `lenses/${id}.json`,
            schemaVersion: id === "responsibility-groups" ? 2 : 1,
          },
        ])
      ),
      packages: ids.map((id) => ({
        declaredDependencies: { dependencies: { zod: "4" } },
        id,
        path: `packages/${id}`,
      })),
      schemaVersion: 5,
    },
    "modules/index.json": {
      modules: ["a", "b"].map((id, index) => ({
        fanIn: 1,
        fanOut: 1,
        fileKind: "source",
        id: `packages/${id}/index.ts`,
        mapPosition: { x: index * 10, y: 3 },
        package: id,
        path: `packages/${id}/index.ts`,
        shard: `modules/${id}.json`,
      })),
    },
    "projections/graph.json": {
      edges: [
        {
          concepts: { total: 0 },
          dependency: { moduleEdges: 2 },
          from: "b",
          kind: "dependency",
          to: "a",
        },
      ],
    },
  };
}

it("uses scan-prepared geometry with exactly the viewer input key, including differently ordered module indexes", async () => {
  const files = scanned();
  const input = await readVisualizationInput(
    datasetReader(memoryTransport(files))
  );
  const baked = prepareVisualization(input);
  files["visualization/map.json"] = baked;
  vi.mocked(prepareVisualization).mockClear();
  stubFetch(memoryTransport(files));
  const data = await loadSpyglass();
  expect(prepareVisualization).toHaveBeenCalledTimes(1);
  const [viewerInput, , previous] =
    vi.mocked(prepareVisualization).mock.calls[0] ?? [];
  expect(viewerInput).toBeDefined();
  if (viewerInput === undefined || previous === undefined) {
    throw new Error("Missing cached preparation call");
  }
  expect(visualizationInputKey(viewerInput)).toBe(input && baked.inputKey);
  expect(vi.mocked(prepareVisualization).mock.results[0]?.value).toBe(previous);
  expect(data.foundations).toBe(previous.foundations);
  expect(data.foundationGroups).toBe(previous.groups);
  expect(data.internalFoundations).toBe(previous.internalFoundations);
  for (const island of previous.islands) {
    const territory = data.territories.find((item) => item.id === island.id);
    expect(territory?.coast).toBe(island.coast);
    expect(territory?.x).toBe(island.x);
    expect(territory?.y).toBe(island.y);
  }
});

it("prepares compatible geometry locally when a saved artifact has a future policy", async () => {
  const files = scanned();
  files["visualization/map.json"] = { policyVersion: 7, schemaVersion: 1 };
  stubFetch(memoryTransport(files));
  vi.mocked(prepareVisualization).mockClear();
  const data = await loadSpyglass();
  expect(data.territories).toHaveLength(2);
  expect(data.foundationGroups).toHaveLength(1);
  expect(vi.mocked(prepareVisualization).mock.calls[0]?.[2]).toBeUndefined();
});
