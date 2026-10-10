import { describe, expect, it } from "vitest";
import { datasetReader } from "../../../src/lib/dataset";
import { readCodexSource } from "../../../src/web/codex/source";
import { memoryTransport } from "../../helpers/dataset-transport";

const entry = {
  fileKind: "source",
  id: "packages/core/src/a.ts",
  package: "@foundry/core",
  path: "packages/core/src/a.ts",
  shard: "modules/core.json",
};

function scanned(): Record<string, unknown> {
  return {
    "manifest.json": {
      coverage: "complete",
      files: {
        moduleIndex: "modules/index.json",
        projections: { dependencyGraph: "projections/graph.json" },
      },
      generatedAt: "2026-09-23T00:00:00.000Z",
      packages: [
        {
          declaredDependencies: { dependencies: { react: "^19" } },
          id: "@foundry/core",
          path: "packages/core",
        },
      ],
      schemaVersion: 4,
    },
    "modules/core-edges.json": {
      edges: [{ source: entry.id, target: entry.id }],
      package: "@foundry/core",
    },
    "modules/core.json": {
      modules: [{ ...entry, concepts: { declared: ["a#Thing"] } }],
      package: "@foundry/core",
    },
    "modules/index.json": {
      edgeShards: [
        { file: "modules/core-edges.json", package: "@foundry/core" },
      ],
      modules: [entry],
      shards: [{ file: "modules/core.json", package: "@foundry/core" }],
    },
    "projections/graph.json": {
      edges: [
        {
          concepts: { total: 0 },
          dependency: { moduleEdges: 1 },
          from: "@foundry/core",
          kind: "dependency",
          to: "@foundry/core",
        },
        { from: "@foundry/core", kind: "direction", to: "@foundry/core" },
      ],
      nodes: [{ analyzed: true, id: "@foundry/core", label: "core", layer: 0 }],
    },
  };
}

function read(files: Record<string, unknown>) {
  return readCodexSource(datasetReader(memoryTransport(files)));
}

describe("readCodexSource", () => {
  it("picks the dataset's time, packages, modules, imports, and declared dependencies", async () => {
    const source = await read(scanned());
    expect(source.dataset).toMatchObject({
      coverage: "complete",
      generatedAt: "2026-09-23T00:00:00.000Z",
    });
    expect(source.packages.map((p) => p.id)).toEqual(["@foundry/core"]);
    expect(source.modules).toEqual([entry]);
    expect(source.participation.map((m) => m.id)).toEqual([entry.id]);
    expect(source.imports).toEqual([{ source: entry.id, target: entry.id }]);
    expect(source.dependencies).toEqual([
      expect.objectContaining({ kind: "dependency" }),
    ]);
    expect(source.declaredDependencies).toEqual([
      {
        declared: { dependencies: { react: "^19" } },
        package: "@foundry/core",
      },
    ]);
    expect(source.history).toBeUndefined();
  });

  it("picks package history when it was recorded", async () => {
    const source = await read({
      ...scanned(),
      "history/entities.json": {
        modules: [],
        packages: [{ checkpoints: ["c1"], id: "@foundry/old" }],
      },
      "history/manifest.json": {
        files: { entities: "entities.json" },
        schemaVersion: 1,
        snapshots: [
          { commit: "c1", status: "complete", timestamp: "2026-01-01" },
        ],
      },
    });
    expect(source.history).toEqual({
      packages: [{ checkpoints: ["c1"], id: "@foundry/old" }],
      snapshots: [
        { commit: "c1", status: "complete", timestamp: "2026-01-01" },
      ],
    });
  });
});
