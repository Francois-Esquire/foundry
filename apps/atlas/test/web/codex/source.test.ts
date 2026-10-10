import { describe, expect, it } from "vitest";
import { datasetReader } from "../../../src/lib/dataset";
import { readCodexSource } from "../../../src/web/codex/source";
import { memoryTransport, recordReads } from "../../helpers/dataset-transport";

const entry = {
  fileKind: "source",
  id: "packages/core/src/a.ts",
  package: "@foundry/core",
  path: "packages/core/src/a.ts",
  shard: "modules/core.json",
};

const sized = {
  analyzed: true,
  id: "@foundry/core",
  layer: 0,
  modules: { byKind: { source: 1 }, total: 1 },
};

const roles = {
  highFanInCutoff: 3,
  id: "@foundry/core",
  modules: [{ fanIn: 3, highFanIn: true, module: entry.id, role: "junction" }],
};

const groups = {
  groups: [],
  id: "@foundry/core",
  independent: ["responsibility:a"],
};

function scanned(): Record<string, unknown> {
  return {
    "lenses/file-roles.json": { missing: [], packages: [roles] },
    "lenses/package-sizes.json": { packages: [sized] },
    "lenses/responsibility-groups.json": { missing: [], packages: [groups] },
    "manifest.json": {
      coverage: "complete",
      files: {
        moduleIndex: "modules/index.json",
        projections: { dependencyGraph: "projections/graph.json" },
      },
      generatedAt: "2026-09-23T00:00:00.000Z",
      lenses: {
        "file-roles": { file: "lenses/file-roles.json", schemaVersion: 1 },
        "package-sizes": {
          file: "lenses/package-sizes.json",
          schemaVersion: 1,
        },
        "responsibility-groups": {
          file: "lenses/responsibility-groups.json",
          schemaVersion: 2,
        },
      },
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
  it("reads no module shard at load, only the index, the edge shards, the graph, and the lenses", async () => {
    const { read: transport, reads } = recordReads(memoryTransport(scanned()));
    await readCodexSource(datasetReader(transport));
    expect(reads).not.toContain("modules/core.json");
    expect([...new Set(reads)].sort()).toEqual([
      "history/manifest.json",
      "lenses/file-roles.json",
      "lenses/package-sizes.json",
      "lenses/responsibility-groups.json",
      "manifest.json",
      "modules/core-edges.json",
      "modules/index.json",
      "projections/graph.json",
    ]);
  });

  it("picks the dataset's time, packages and their folders, modules, imports, and declared dependencies", async () => {
    const source = await read(scanned());
    expect(source.dataset).toMatchObject({
      coverage: "complete",
      generatedAt: "2026-09-23T00:00:00.000Z",
    });
    expect(source.packages).toEqual([sized]);
    expect(source.packagePaths).toEqual([
      { id: "@foundry/core", path: "packages/core" },
    ]);
    expect(source.fileRoles).toEqual([roles]);
    expect(source.responsibilityGroups).toEqual([groups]);
    expect(source.modules).toEqual([entry]);
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

  it("asks for a new scan when the dataset was saved before lenses existed", async () => {
    const files = scanned();
    const { lenses: _lenses, ...manifest } = files["manifest.json"] as Record<
      string,
      unknown
    >;
    await expect(read({ ...files, "manifest.json": manifest })).rejects.toThrow(
      "The dataset has no package-sizes lens. Run atlas scan again."
    );
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
