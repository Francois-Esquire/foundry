import { afterEach, describe, expect, it, vi } from "vitest";
import { readCodexSource } from "../../../src/web/codex/source";

const entry = {
  fileKind: "source",
  id: "packages/core/src/a.ts",
  package: "@foundry/core",
  path: "packages/core/src/a.ts",
  shard: "modules/core.json",
};

function survey(schemaVersion = 3): Record<string, unknown> {
  return {
    "/data/manifest.json": {
      coverage: "complete",
      files: {
        moduleIndex: "modules/index.json",
        projections: { dependencyGraph: "projections/graph.json" },
      },
      generatedAt: "2026-09-23T00:00:00.000Z",
      packages: [{ id: "@foundry/core", path: "packages/core" }],
      schemaVersion,
    },
    "/data/manifests/%40foundry__core.json": {
      dependencies: { react: "^19" },
      name: "@foundry/core",
    },
    "/data/modules/core-edges.json": {
      edges: [{ source: entry.id, target: entry.id }],
      package: "@foundry/core",
    },
    "/data/modules/core.json": {
      modules: [{ ...entry, concepts: { declared: ["a#Thing"] } }],
      package: "@foundry/core",
    },
    "/data/modules/index.json": {
      edgeShards: [
        { file: "modules/core-edges.json", package: "@foundry/core" },
      ],
      modules: [entry],
      shards: [{ file: "modules/core.json", package: "@foundry/core" }],
    },
    "/data/projections/graph.json": {
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

function serve(files: Record<string, unknown>, status = 404) {
  vi.stubGlobal("fetch", (url: string) =>
    Promise.resolve(
      url in files ? Response.json(files[url]) : new Response(null, { status })
    )
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readCodexSource", () => {
  it("reads the eager survey and each package manifest", async () => {
    serve(survey());
    const source = await readCodexSource();
    expect(source.survey).toMatchObject({
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
    expect(source.manifests).toEqual([
      {
        declared: { dependencies: { react: "^19" }, name: "@foundry/core" },
        package: "@foundry/core",
      },
    ]);
    expect(source.history).toBeUndefined();
  });

  it("reads package history when it was recorded", async () => {
    serve({
      ...survey(),
      "/data/history/entities.json": {
        modules: [],
        packages: [{ checkpoints: ["c1"], id: "@foundry/old" }],
      },
      "/data/history/manifest.json": {
        snapshots: [
          { commit: "c1", status: "complete", timestamp: "2026-01-01" },
        ],
      },
    });
    expect((await readCodexSource()).history).toEqual({
      packages: [{ checkpoints: ["c1"], id: "@foundry/old" }],
      snapshots: [
        { commit: "c1", status: "complete", timestamp: "2026-01-01" },
      ],
    });
  });

  it("fails when history exists but cannot be read", async () => {
    serve(survey(), 500);
    await expect(readCodexSource()).rejects.toThrow(
      "Could not load history (500)."
    );
  });

  it("asks for a scan when the survey is missing", async () => {
    serve({});
    await expect(readCodexSource()).rejects.toThrow("Run atlas scan");
  });

  it("rejects other dataset versions", async () => {
    serve(survey(2));
    await expect(readCodexSource()).rejects.toThrow(
      "Unsupported semantics dataset version 2."
    );
  });
});
