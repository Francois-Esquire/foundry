import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DatasetNotFoundError,
  DatasetReplacedError,
  datasetReader,
} from "../../src/lib/dataset";
import { fileTransport } from "../../src/lib/dataset-files";
import { memoryTransport, recordReads } from "../helpers/dataset-transport";

const SAVED_AT = "2026-10-10T00:00:00.000Z";

const internals = (id: string) => ({
  locality: { package: { id } },
  primitives: {},
  responsibilities: { package: { id } },
  review: {},
  rewiring: {},
  topology: { modules: [], package: { id, root: "packages/a" } },
});

function dataset(overrides: Record<string, unknown> = {}) {
  return {
    "internals/@s__a.json": internals("@s/a"),
    "manifest.json": {
      files: {
        moduleIndex: "modules/index.json",
        projections: { dependencyGraph: "projections/dependency-graph.json" },
        workspace: "workspace.json",
      },
      generatedAt: SAVED_AT,
      packages: [
        {
          id: "@s/a",
          internals: "internals/@s__a.json",
          report: "packages/@s__a.json",
          status: "complete",
        },
        { id: "@s/b", report: "packages/@s__b.json", status: "complete" },
        { error: "boom", id: "@s/c", status: "failed" },
      ],
      schemaVersion: 4,
    },
    "modules/@s__a.json": { modules: [{ id: "a.ts" }], package: "@s/a" },
    "modules/edges/@s__a.json": { edges: [], package: "@s/a" },
    "modules/index.json": {
      edgeShards: [{ file: "modules/edges/@s__a.json", package: "@s/a" }],
      modules: [],
      shards: [{ file: "modules/@s__a.json", package: "@s/a" }],
    },
    "packages/@s__a.json": { churn: { available: false } },
    "projections/dependency-graph.json": { edges: [], nodes: [] },
    "workspace.json": { schemaVersion: 7 },
    ...overrides,
  };
}

function reader(files: Record<string, unknown> = dataset(), pin?: string) {
  const recorded = recordReads(memoryTransport(files));
  return { dataset: datasetReader(recorded.read, { pin }), ...recorded };
}

describe("the manifest", () => {
  it("is read once per reader, even by concurrent reads", async () => {
    const { dataset: saved, reads } = reader();
    await Promise.all([
      saved.manifest(),
      saved.packageReport("@s/a"),
      saved.internals("@s/a"),
      saved.workspaceReport(),
    ]);
    expect(reads.filter((path) => path === "manifest.json")).toHaveLength(1);
  });

  it("is refused at another schema version", async () => {
    const files = dataset();
    const { dataset: saved } = reader({
      ...files,
      "manifest.json": { ...files["manifest.json"], schemaVersion: 3 },
    });
    await expect(saved.manifest()).rejects.toThrow(
      "Atlas reads dataset schema version 4; this dataset has version 3. Run atlas scan to save it again."
    );
  });

  it("is missing when no scan saved a dataset", async () => {
    const { dataset: saved } = reader({});
    const read = saved.packageReport("@s/a");
    await expect(read).rejects.toBeInstanceOf(DatasetNotFoundError);
    await expect(read).rejects.toThrow(
      "No dataset found. Run atlas scan to save one."
    );
  });

  it.each([
    ["null", null],
    ["not an object", "manifest"],
  ])("is unreadable when it is %s", async (_case, saved) => {
    await expect(
      reader({ "manifest.json": saved }).dataset.manifest()
    ).rejects.toThrow(
      "The dataset's manifest is unreadable. Run atlas scan again."
    );
  });

  it("must be the one the reader is pinned to", async () => {
    await expect(
      reader(dataset(), SAVED_AT).dataset.manifest()
    ).resolves.toMatchObject({ generatedAt: SAVED_AT });
    const replaced = reader(dataset(), "2026-10-09T00:00:00.000Z").dataset;
    await expect(replaced.internals("@s/a")).rejects.toBeInstanceOf(
      DatasetReplacedError
    );
    await expect(replaced.manifest()).rejects.toThrow(
      "A later scan replaced this dataset. Scan again to read the new one."
    );
  });
});

describe("one package", () => {
  it("reads its report through the manifest and nothing else", async () => {
    const { dataset: saved, reads } = reader();
    await expect(saved.packageReport("@s/a")).resolves.toEqual({
      churn: { available: false },
    });
    expect(reads).toEqual(["manifest.json", "packages/@s__a.json"]);
  });

  it("reads its internals through the manifest and nothing else", async () => {
    const { dataset: saved, reads } = reader();
    await expect(saved.internals("@s/a")).resolves.toEqual(internals("@s/a"));
    expect(reads).toEqual(["manifest.json", "internals/@s__a.json"]);
  });

  it("is refused when the dataset does not hold it", async () => {
    const { dataset: saved } = reader();
    await expect(saved.packageReport("@s/x")).rejects.toThrow(
      "The dataset has no package named @s/x."
    );
    await expect(saved.internals("@s/x")).rejects.toThrow(
      "The dataset has no package named @s/x."
    );
  });

  it("has neither report nor internals when Atlas could not analyze it", async () => {
    const { dataset: saved } = reader();
    await expect(saved.packageReport("@s/c")).rejects.toThrow(
      "Atlas could not analyze @s/c, so it has no package report."
    );
    await expect(saved.internals("@s/c")).rejects.toThrow(
      "Atlas could not analyze @s/c, so it has no internals."
    );
  });

  it("has no internals when the dataset was saved without them", async () => {
    await expect(reader().dataset.internals("@s/b")).rejects.toThrow(
      "The dataset was saved without internals for @s/b. Run atlas scan to include them."
    );
  });

  it.each([
    ["a stage is missing", { ...internals("@s/a"), review: undefined }],
    ["the topology names another package", internals("@s/b")],
    ["there is no topology", { ...internals("@s/a"), topology: undefined }],
    ["the file holds no object", 7],
  ])("has incomplete internals when %s", async (_case, saved) => {
    const { dataset: read } = reader(
      dataset({ "internals/@s__a.json": saved })
    );
    await expect(read.internals("@s/a")).rejects.toThrow(
      "The dataset's internals for @s/a are incomplete. Run atlas scan again."
    );
  });

  it("names the file the dataset is missing", async () => {
    const { dataset: saved } = reader(
      dataset({ "packages/@s__a.json": undefined })
    );
    await expect(saved.packageReport("@s/a")).rejects.toThrow(
      "The dataset is missing packages/@s__a.json. Run atlas scan again."
    );
  });
});

describe("the workspace", () => {
  it("reads the workspace report the manifest names", async () => {
    const { dataset: saved, reads } = reader();
    await expect(saved.workspaceReport()).resolves.toEqual({
      schemaVersion: 7,
    });
    expect(reads).toEqual(["manifest.json", "workspace.json"]);
  });

  it("reads the module index once for its shards", async () => {
    const { dataset: saved, reads } = reader();
    const [modules, edges] = await Promise.all([
      saved.moduleShards(),
      saved.moduleEdgeShards(),
      saved.moduleIndex(),
    ]);
    expect(modules).toEqual([{ modules: [{ id: "a.ts" }], package: "@s/a" }]);
    expect(edges).toEqual([{ edges: [], package: "@s/a" }]);
    expect(reads.filter((path) => path === "modules/index.json")).toHaveLength(
      1
    );
  });
});

describe("history", () => {
  const history = {
    "history/entities.json": { modules: [], packages: [{ id: "@s/old" }] },
    "history/manifest.json": {
      files: { entities: "entities.json" },
      schemaVersion: 1,
      snapshots: [],
    },
  };

  it("is read once, through the checked manifest", async () => {
    const { dataset: saved, reads } = reader(dataset(history));
    await Promise.all([saved.history(), saved.history()]);
    expect(reads).toEqual([
      "manifest.json",
      "history/manifest.json",
      "history/entities.json",
    ]);
    const replaced = reader(dataset(history), "2026-10-09T00:00:00.000Z");
    await expect(replaced.dataset.history()).rejects.toBeInstanceOf(
      DatasetReplacedError
    );
  });

  it("is absent when the scan did not include it", async () => {
    await expect(reader().dataset.history()).resolves.toBeUndefined();
  });

  it("reads the entities its manifest names", async () => {
    const { dataset: saved } = reader(dataset(history));
    await expect(saved.history()).resolves.toEqual({
      entities: history["history/entities.json"],
      manifest: history["history/manifest.json"],
    });
  });

  it("is refused at another schema version", async () => {
    const { dataset: saved } = reader(
      dataset({
        ...history,
        "history/manifest.json": {
          ...history["history/manifest.json"],
          schemaVersion: 2,
        },
      })
    );
    await expect(saved.history()).rejects.toThrow(
      "Atlas reads history schema version 1; this dataset's history has version 2."
    );
  });
});

describe("the file system", () => {
  it("names a saved file that is not JSON", async () => {
    const output = mkdtempSync(join(tmpdir(), "atlas-dataset-"));
    try {
      writeFileSync(join(output, "manifest.json"), "{");
      await expect(
        datasetReader(fileTransport(output)).manifest()
      ).rejects.toThrow("Could not parse manifest.json.");
      await expect(
        datasetReader(fileTransport(join(output, "missing"))).manifest()
      ).rejects.toBeInstanceOf(DatasetNotFoundError);
    } finally {
      rmSync(output, { force: true, recursive: true });
    }
  });
});
