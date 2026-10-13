import { describe, expect, it } from "vitest";
import { datasetReader } from "../../../src/lib/dataset";
import {
  readCodexSource,
  readLateCodexSource,
} from "../../../src/web/codex/source";
import { memoryTransport, recordReads } from "../../helpers/dataset-transport";

const entry = {
  fanIn: 1,
  fanOut: 1,
  fileKind: "source",
  id: "packages/core/src/a.ts",
  mapPosition: { x: 2, y: 3 },
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

const placed = {
  away: [{ modules: ["packages/ui/a.ts"], package: "@foundry/ui" }],
  home: { modules: [] },
  label: "departs",
  level: "file",
  package: "@foundry/core",
  place: entry.id,
  toward: "@foundry/ui",
  unindexed: 0,
};

const traffic = {
  consumerFiles: ["packages/ui/a.ts"],
  from: "@foundry/ui",
  supplierFiles: [entry.id],
  to: "@foundry/core",
};

function scanned(): Record<string, unknown> {
  return {
    "lenses/domains.json": { domains: [], placements: [] },
    "lenses/file-roles.json": { missing: [], packages: [roles] },
    "lenses/import-traffic.json": { pairs: [traffic] },
    "lenses/nesting.json": {
      folders: [],
      missing: [],
      pathRegions: [],
      seams: [],
    },
    "lenses/package-sizes.json": { packages: [sized] },
    "lenses/placement.json": {
      missing: [],
      packages: [{ id: "@foundry/core", path: "packages/core" }],
      places: [placed],
      policy: { dominantShare: 0.6 },
    },
    "lenses/proximity.json": {
      apart: { coChanges: [], files: [] },
      close: [],
      missing: [],
      packages: [{ id: "@foundry/core", unresolved: 0 }],
    },
    "lenses/responsibility-groups.json": { missing: [], packages: [groups] },
    "manifest.json": {
      coverage: "complete",
      files: {
        moduleIndex: "modules/index.json",
        projections: { dependencyGraph: "projections/graph.json" },
      },
      generatedAt: "2026-09-23T00:00:00.000Z",
      lenses: {
        domains: { file: "lenses/domains.json", schemaVersion: 1 },
        "file-roles": { file: "lenses/file-roles.json", schemaVersion: 1 },
        "import-traffic": {
          file: "lenses/import-traffic.json",
          schemaVersion: 1,
        },
        nesting: { file: "lenses/nesting.json", schemaVersion: 1 },
        "package-sizes": {
          file: "lenses/package-sizes.json",
          schemaVersion: 1,
        },
        placement: { file: "lenses/placement.json", schemaVersion: 1 },
        proximity: { file: "lenses/proximity.json", schemaVersion: 1 },
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
      schemaVersion: 5,
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

function readLate(files: Record<string, unknown>) {
  return readLateCodexSource(datasetReader(memoryTransport(files)));
}

describe("readLateCodexSource", () => {
  it("reads the nesting and proximity lenses after the layout, and nothing else but the manifest", async () => {
    const { read: transport, reads } = recordReads(memoryTransport(scanned()));
    const late = await readLateCodexSource(datasetReader(transport));
    expect([...new Set(reads)].sort()).toEqual([
      "lenses/nesting.json",
      "lenses/proximity.json",
      "manifest.json",
    ]);
    expect(late.nesting).toEqual({ folders: [], pathRegions: [], seams: [] });
    expect(late.proximity).toEqual({
      apart: { coChanges: [], files: [] },
      close: [],
      packages: [{ id: "@foundry/core", unresolved: 0 }],
    });
  });

  it("refuses a dataset a later scan replaced, when pinned to the one the layout read", async () => {
    await expect(
      readLateCodexSource(
        datasetReader(memoryTransport(scanned()), {
          pin: "2026-01-01T00:00:00.000Z",
        })
      )
    ).rejects.toThrow("A later scan replaced this dataset.");
  });
});

describe("readCodexSource", () => {
  it("reads no shard at load, module or edge, only the index, the graph, and the lenses", async () => {
    const { read: transport, reads } = recordReads(memoryTransport(scanned()));
    await readCodexSource(datasetReader(transport));
    expect(reads).not.toContain("modules/core.json");
    expect(reads).not.toContain("modules/core-edges.json");
    expect([...new Set(reads)].sort()).toEqual([
      "history/manifest.json",
      "lenses/domains.json",
      "lenses/file-roles.json",
      "lenses/import-traffic.json",
      "lenses/package-sizes.json",
      "lenses/placement.json",
      "lenses/responsibility-groups.json",
      "manifest.json",
      "modules/index.json",
      "projections/graph.json",
    ]);
  });

  it("reads layout edges only for older datasets without saved file positions", async () => {
    const files = scanned();
    const { mapPosition: _position, ...legacyEntry } = entry;
    files["modules/index.json"] = {
      edgeShards: [{ file: "modules/core-edges.json", package: entry.package }],
      modules: [legacyEntry],
      shards: [{ file: entry.shard, package: entry.package }],
    };
    const { read: transport, reads } = recordReads(memoryTransport(files));
    const source = await readCodexSource(datasetReader(transport));
    expect(reads).toContain("modules/core-edges.json");
    expect(source.layoutEdges).toEqual([
      { source: entry.id, target: entry.id },
    ]);
    expect(reads).not.toContain(entry.shard);
  });

  it("asks for a new scan when the dataset was saved before the import-traffic lens", async () => {
    const files = scanned();
    const manifest = files["manifest.json"] as {
      lenses: Record<string, unknown>;
    };
    const { "import-traffic": _missing, ...lenses } = manifest.lenses;
    await expect(
      read({ ...files, "manifest.json": { ...manifest, lenses } })
    ).rejects.toThrow(
      "The dataset has no import-traffic lens. Run atlas scan again."
    );
  });

  it("picks the dataset's time, packages and their folders, modules with their import counts, the import traffic, placements, and declared dependencies", async () => {
    const source = await read(scanned());
    expect(source.dataset).toMatchObject({
      coverage: "complete",
      generatedAt: "2026-09-23T00:00:00.000Z",
    });
    expect(source.packages).toEqual([sized]);
    expect(source.domains).toEqual({ domains: [], placements: [] });
    expect(source).not.toHaveProperty("nesting");
    expect(source).not.toHaveProperty("proximity");
    expect(source.placement).toEqual({
      packages: [{ id: "@foundry/core" }],
      places: [placed],
      policy: { dominantShare: 0.6 },
    });
    expect(source.packagePaths).toEqual([
      { id: "@foundry/core", path: "packages/core" },
    ]);
    expect(source.fileRoles).toEqual([roles]);
    expect(source.responsibilityGroups).toEqual([groups]);
    expect(source.modules).toEqual([entry]);
    expect(source.importTraffic).toEqual([traffic]);
    expect(source).not.toHaveProperty("imports");
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

  it("asks for a new scan when the dataset was saved before the package-sizes lens", async () => {
    const files = scanned();
    const manifest = files["manifest.json"] as {
      lenses: Record<string, unknown>;
    };
    const { "package-sizes": _missing, ...lenses } = manifest.lenses;
    await expect(
      read({ ...files, "manifest.json": { ...manifest, lenses } })
    ).rejects.toThrow(
      "The dataset has no package-sizes lens. Run atlas scan again."
    );
  });

  it("asks for a new scan when the dataset was saved before the placement lens", async () => {
    const files = scanned();
    const manifest = files["manifest.json"] as {
      lenses: Record<string, unknown>;
    };
    const { placement: _placement, ...lenses } = manifest.lenses;
    await expect(
      read({ ...files, "manifest.json": { ...manifest, lenses } })
    ).rejects.toThrow(
      "The dataset has no placement lens. Run atlas scan again."
    );
  });

  it("asks for a new scan when the dataset was saved before the nesting or domains lens", async () => {
    for (const [id, reads] of [
      ["nesting", readLate],
      ["domains", read],
    ] as const) {
      const files = scanned();
      const manifest = files["manifest.json"] as {
        lenses: Record<string, unknown>;
      };
      const { [id]: _missing, ...lenses } = manifest.lenses;
      await expect(
        reads({ ...files, "manifest.json": { ...manifest, lenses } })
      ).rejects.toThrow(`The dataset has no ${id} lens. Run atlas scan again.`);
    }
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
