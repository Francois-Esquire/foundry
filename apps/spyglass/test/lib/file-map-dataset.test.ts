import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assembleSurfaceReport } from "../../src/lib/assemble";
import { type DatasetTransport, datasetReader } from "../../src/lib/dataset";
import type { DatasetAnalysis } from "../../src/lib/dataset-analysis";
import { fileTransport } from "../../src/lib/dataset-files";
import {
  DATASET_ANALYSIS_FILE,
  DATASET_FILES,
} from "../../src/lib/dataset-layout";
import type { FileMapDataset } from "../../src/lib/file-map-dataset";
import { fileMapDataset } from "../../src/lib/file-map-dataset";
import { FileMapInputError } from "../../src/lib/file-map-preparation";
import { analyzePackageLocal } from "../../src/lib/package-local";
import { createProject } from "../../src/lib/project";
import { generateSemantics } from "../../src/lib/semantics";
import {
  canonicalSemanticsText,
  listSemanticsFiles,
} from "../../src/lib/semantics-equivalence";
import type { DatasetManifest } from "../../src/lib/semantics-types";
import { deriveWorkspaceSurface } from "../../src/lib/workspace-derive";
import { fileMapDisk, recordFiles } from "./helpers/file-map";

const ROOT = "/spyglass-file-map";
const NOW = new Date("2026-11-07T00:00:00Z");
const fixture = join(import.meta.dirname, "fixtures", "semantics");
const disk = fileMapDisk("spyglass-file-map-dataset-");
const files = recordFiles(fixture);

let nativeRoot: string;
let nativeOutput: string;
let dataset: FileMapDataset;

async function nativeScan(root: string): Promise<string> {
  const output = join(root, ".foundry", "semantics");
  await generateSemantics({
    analyzeLocal: (unit, context) =>
      Promise.resolve(
        analyzePackageLocal({ root: context.root, target: unit.path })
      ),
    cache: join(root, ".foundry", "cache"),
    command: "test",
    concurrency: 1,
    derive: async (locals, context) => {
      const project = createProject(context.root);
      if (project.getCompilerOptions().types === undefined) {
        project.compilerOptions.set({ types: [] });
      }
      const derived = await deriveWorkspaceSurface(locals, {
        ...context,
        project,
      });
      return {
        reports: locals.map((local) => {
          const facts = derived.packages[local.package.path];
          if (facts === undefined) {
            throw new Error(`no derivation for ${local.package.path}`);
          }
          return assembleSurfaceReport(local, facts);
        }),
        timing: derived.timing,
      };
    },
    failFast: true,
    now: NOW,
    output,
    root,
  });
  return output;
}

beforeAll(async () => {
  nativeRoot = disk.materialize(files);
  nativeOutput = await nativeScan(nativeRoot);
  dataset = await fileMapDataset({ files, now: NOW, root: ROOT });
}, 120_000);

afterAll(() => disk.cleanup());

function changedPaths(left: unknown, right: unknown, path = ""): string[] {
  if (JSON.stringify(left) === JSON.stringify(right)) {
    return [];
  }
  if (
    left !== null &&
    right !== null &&
    typeof left === "object" &&
    typeof right === "object" &&
    Array.isArray(left) === Array.isArray(right)
  ) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].flatMap((key) =>
      changedPaths(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        `${path}/${key}`
      )
    );
  }
  return [`${path}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`];
}

describe("fileMapDataset against a native scan of the same bytes", () => {
  it("assembles the native scan's 37 artifacts, differing only by the root's last segment", () => {
    const published = listSemanticsFiles(nativeOutput).sort();
    expect(published).toHaveLength(37);

    expect([...dataset.paths].sort()).toEqual(
      [...published, DATASET_ANALYSIS_FILE].sort()
    );
    const rootSegment = nativeRoot.slice(nativeRoot.lastIndexOf("/") + 1);
    const differences = published.flatMap((file) =>
      changedPaths(
        JSON.parse(
          canonicalSemanticsText(file, JSON.parse(dataset.text(file) ?? "null"))
        ),
        JSON.parse(
          canonicalSemanticsText(
            file,
            JSON.parse(readFileSync(join(nativeOutput, file), "utf8"))
          )
        )
      ).map((change) => `${file}${change}`)
    );
    expect(differences).toEqual([
      `manifest.json/workspace/root: "spyglass-file-map" != "${rootSegment}"`,
    ]);
  });
});

describe("fileMapDataset on a standalone package", () => {
  it("records the native cruise as its module graph source", async () => {
    const result = await fileMapDataset({
      files: {
        "package.json": JSON.stringify({ name: "solo" }),
        "src/index.ts": "export const value = 1;\n",
        "src/legacy.js": "module.exports = 3;\n",
      },
      now: NOW,
      root: ROOT,
    });
    expect(result.capabilities.moduleGraph.source).toBe("dependency-cruiser");
    expect((await result.reader().manifest()).discovery.declarationSource).toBe(
      "package.json"
    );
  });

  it("assembles the native scan's artifacts for a root that is its own unit", async () => {
    const standalone = {
      "package.json": JSON.stringify({ name: "solo" }),
      "src/index.ts": "export const value = 1;\n",
    };
    const root = disk.materialize(standalone);
    const output = await nativeScan(root);
    const mine = await fileMapDataset({
      files: standalone,
      now: NOW,
      root: ROOT,
    });
    const published = listSemanticsFiles(output).sort();
    expect([...mine.paths].sort()).toEqual(
      [...published, DATASET_ANALYSIS_FILE].sort()
    );
    const rootSegment = root.slice(root.lastIndexOf("/") + 1);
    const differences = published.flatMap((file) =>
      changedPaths(
        JSON.parse(
          canonicalSemanticsText(file, JSON.parse(mine.text(file) ?? "null"))
        ),
        JSON.parse(
          canonicalSemanticsText(
            file,
            JSON.parse(readFileSync(join(output, file), "utf8"))
          )
        )
      ).map((change) => `${file}${change}`)
    );
    expect(differences).toEqual([
      `manifest.json/workspace/root: "spyglass-file-map" != "${rootSegment}"`,
    ]);
    expect(mine.manifest.discovery.declarationSource).toBe("package.json");
  }, 120_000);
});

describe("fileMapDataset through the existing dataset reader", () => {
  it("answers every reader accessor from the map's artifacts", async () => {
    const reader = dataset.reader();
    const manifest = await reader.manifest();
    expect(manifest.coverage).toBe("complete");
    expect(manifest.workspace).toEqual({
      name: "semantics-root",
      root: "spyglass-file-map",
    });
    expect(manifest.packages.map((pkg) => pkg.id)).toEqual([
      "@s/a",
      "@s/b",
      "@s/c",
    ]);
    expect(manifest.discovery.unitsSkipped.map((entry) => entry.path)).toEqual([
      "packages/docs-only",
      "packages/loose",
    ]);
    expect((await reader.packageReport("@s/a")).target.name).toBe("@s/a");
    expect((await reader.moduleIndex()).shards).toHaveLength(3);
    expect(await reader.moduleShards()).toHaveLength(3);
    expect(await reader.moduleEdgeShards()).toHaveLength(3);
    expect((await reader.workspaceReport()).packages.packages).toHaveLength(3);
    expect((await reader.dependencyGraph()).nodes.length).toBeGreaterThan(0);
    const inventory = await reader.dependencyInventory();
    expect(inventory?.packages.map((pkg) => pkg.id)).toEqual([
      "@s/a",
      "@s/b",
      "@s/c",
      "@s/docs-only",
      "workspace-root:",
    ]);

    expect(inventory?.graph?.resolution.status).toBe("unavailable");
    expect(await reader.lens("file-roles")).toEqual(
      JSON.parse(
        readFileSync(join(nativeOutput, "lenses/file-roles.json"), "utf8")
      )
    );
    expect((await reader.visualization())?.islands.length).toBeGreaterThan(0);
    expect(await reader.history()).toBeUndefined();
    expect((await reader.analysis())?.capabilities).toEqual(
      dataset.capabilities
    );

    expect(
      await datasetReader(fileTransport(nativeOutput)).analysis()
    ).toBeUndefined();
    await expect(reader.internals("@s/a")).rejects.toThrow(
      "The dataset was saved without internals for @s/a."
    );
  });

  it("carries the map's capabilities and what it did not assemble beside the reader", async () => {
    expect(dataset.capabilities.history).toEqual({
      available: false,
      detail: "A file map carries no Git history.",
      reason: "not-git-repository",
    });
    expect(dataset.capabilities.moduleGraph.source).toBe("dependency-cruiser");
    expect(dataset.capabilities.types.policy).toBe(
      "explicit-declarations-and-bundled-libs"
    );
    expect(dataset.capabilities.configuration.unusedRootTsconfig).toBe(true);
    expect(dataset.provenance).toEqual({
      inputsFingerprint: "unrecorded",
      internals: "not-assembled",
    });
    expect(dataset.manifest.generation.inputs).toBeUndefined();
    expect(dataset.manifest.generation.command).toBe("fileMapDataset");
    expect(dataset.manifest.generation.phases.map((p) => p.name)).toEqual([
      "discover",
      "analyze",
      "derive",
      "ingest",
      "intelligence",
      "project",
      "write",
      "lenses",
      "visualization",
    ]);

    const report = await dataset.reader().packageReport("@s/b");
    expect(JSON.stringify(report)).toContain("not-git-repository");
  });

  it("gives each call its own artifacts, manifest and parsed objects", async () => {
    const other = await fileMapDataset({
      exclude: ["tooling/c"],
      files,
      now: NOW,
      root: ROOT,
    });
    expect(other.manifest.packages.map((pkg) => pkg.id)).toEqual([
      "@s/a",
      "@s/b",
    ]);
    expect((await dataset.reader().manifest()).packages).toHaveLength(3);
    expect(other.manifest).not.toBe(dataset.manifest);
    other.manifest.files.workspace = "mutated";
    expect(dataset.manifest.files.workspace).toBe(DATASET_FILES.workspace);
    const read = (await dataset.transport(DATASET_FILES.manifest)) as {
      coverage: string;
    };
    read.coverage = "mutated";
    expect((await dataset.reader().manifest()).coverage).toBe("complete");
  });

  it("takes declared domains and rules as data", async () => {
    const withRule = await fileMapDataset({
      files,
      now: NOW,
      root: ROOT,
      settings: {
        domains: [],
        rules: [
          { effect: "require", operator: "internalize", subject: "tooling/c" },
        ],
      },
    });
    expect(withRule.text("lenses/rules.json")).not.toBe(
      dataset.text("lenses/rules.json")
    );
  });

  it("analyses a source whose name holds glob characters, as natively", async () => {
    const routed = await fileMapDataset({
      files: {
        "package.json": JSON.stringify({
          name: "routes",
          private: true,
          workspaces: ["site"],
        }),
        "site/index.ts":
          'import { config } from "./packages/[pkg].paths";\nexport const x = config;\n',
        "site/package.json": JSON.stringify({ name: "site" }),
        "site/packages/[pkg].paths.ts": "export const config = 1;\n",
      },
      now: NOW,
      root: ROOT,
    });
    const index = await routed.reader().moduleIndex();
    expect(JSON.stringify(index)).toContain("packages/[pkg].paths.ts");
  });

  it("refuses an unacceptable map and a map with no workspace, as natively", async () => {
    await expect(
      fileMapDataset({ files: { "../x.ts": "" }, now: NOW, root: ROOT })
    ).rejects.toThrow(FileMapInputError);
    await expect(
      fileMapDataset({ exclude: ["./a/"], files, now: NOW, root: ROOT })
    ).rejects.toThrow('exclude "./a/" must be a normalized');
    await expect(
      fileMapDataset({
        files: { "a.ts": "export {};\n", "package.json": "{}" },
        now: NOW,
        root: ROOT,
      })
    ).rejects.toThrow(
      `Directory ${ROOT} has no workspace declaration or named TypeScript package.`
    );
  });
});

describe("saved analysis metadata against the manifest it was saved with", () => {
  const CONTRADICTS =
    "The dataset's analysis metadata contradicts its manifest:";
  const AGAIN = " Build the dataset again.";

  const saved = (): DatasetAnalysis =>
    JSON.parse(dataset.text(DATASET_ANALYSIS_FILE) ?? "null");

  const replaced =
    (
      analysis: unknown,
      manifest: (saved: DatasetManifest) => DatasetManifest = (m) => m
    ): DatasetTransport =>
    async (path) => {
      if (path === DATASET_ANALYSIS_FILE) {
        return analysis;
      }
      const value = await dataset.transport(path);
      return path === DATASET_FILES.manifest
        ? manifest(value as DatasetManifest)
        : value;
    };

  const rejection = async (read: DatasetTransport): Promise<string> => {
    const error = await datasetReader(read)
      .analysis()
      .then(
        () => undefined,
        (reason: unknown) => reason
      );
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  };

  it("answers metadata that agrees with its manifest", async () => {
    const analysis = await dataset.reader().analysis();
    expect(analysis).toEqual(saved());
    expect(analysis?.origin).toEqual({
      command: "fileMapDataset",
      kind: "file-map",
      root: ROOT,
    });
    expect(analysis?.capabilities.paths.root).toBe(ROOT);
    expect(analysis?.provenance).toEqual({
      inputsFingerprint: "unrecorded",
      internals: "not-assembled",
    });
  });

  it("rejects an origin root other than the capabilities' root", async () => {
    const analysis = saved();
    analysis.origin.root = "/unrelated/spyglass-file-map";
    expect(await rejection(replaced(analysis))).toBe(
      `${CONTRADICTS} origin.root "/unrelated/spyglass-file-map" is not capabilities.paths.root "/spyglass-file-map".${AGAIN}`
    );
  });

  it("rejects a root whose last segment is not the manifest's workspace root", async () => {
    const analysis = saved();
    analysis.origin.root = "/unrelated";
    analysis.capabilities.paths.root = "/unrelated";
    expect(await rejection(replaced(analysis))).toBe(
      `${CONTRADICTS} origin.root "/unrelated" ends in "unrelated", but the manifest's workspace.root is "spyglass-file-map".${AGAIN}`
    );
  });

  it("does not take the self-reported root as proof of where the map was placed", async () => {
    const analysis = saved();
    analysis.origin.root = "/elsewhere/spyglass-file-map";
    analysis.capabilities.paths.root = "/elsewhere/spyglass-file-map";
    expect(await datasetReader(replaced(analysis)).analysis()).toEqual(
      analysis
    );
  });

  it("rejects an origin command other than the manifest's generation command", async () => {
    const analysis = saved();
    analysis.origin.command = "different";
    expect(await rejection(replaced(analysis))).toBe(
      `${CONTRADICTS} origin.command "different" is not the manifest's generation.command "fileMapDataset".${AGAIN}`
    );
  });

  it("rejects a recorded fingerprint the manifest does not have", async () => {
    const analysis = saved();
    analysis.provenance.inputsFingerprint = "recorded";
    expect(await rejection(replaced(analysis))).toBe(
      `${CONTRADICTS} provenance.inputsFingerprint is "recorded", but the manifest's generation records no inputs.${AGAIN}`
    );
  });

  it("matches the fingerprint status to the inputs the manifest records", async () => {
    const withInputs = (manifest: DatasetManifest): DatasetManifest => ({
      ...manifest,
      generation: {
        ...manifest.generation,
        inputs: { config: "c", hash: "h" },
      },
    });
    expect(await rejection(replaced(saved(), withInputs))).toBe(
      `${CONTRADICTS} provenance.inputsFingerprint is "unrecorded", but the manifest's generation records inputs.${AGAIN}`
    );
    const recorded = saved();
    recorded.provenance.inputsFingerprint = "recorded";
    expect(
      await datasetReader(replaced(recorded, withInputs)).analysis()
    ).toEqual(recorded);
  });

  it("rejects unassembled internals when the manifest names internals", async () => {
    const withInternals = (manifest: DatasetManifest): DatasetManifest => ({
      ...manifest,
      packages: manifest.packages.map((pkg) =>
        pkg.id === "@s/b" ? { ...pkg, internals: "internals/s-b.json" } : pkg
      ),
    });
    expect(await rejection(replaced(saved(), withInternals))).toBe(
      `${CONTRADICTS} provenance.internals is "not-assembled", but the manifest names internals for @s/b.${AGAIN}`
    );
  });

  it("reports every contradiction at once", async () => {
    const analysis = saved();
    analysis.origin.root = "/unrelated";
    analysis.origin.command = "different";
    analysis.provenance.inputsFingerprint = "recorded";
    const message = await rejection(replaced(analysis));
    expect(message.startsWith(CONTRADICTS)).toBe(true);
    for (const field of [
      "origin.root",
      "workspace.root",
      "origin.command",
      "provenance.inputsFingerprint",
    ]) {
      expect(message).toContain(field);
    }
  });

  it("keeps an unsupported version and malformed shape as unreadable", async () => {
    const unreadable =
      "The dataset's analysis metadata is unreadable or uses an unsupported schema version. Build the dataset again.";
    for (const schemaVersion of [1, 2, 4]) {
      const version = { ...saved(), schemaVersion };
      expect(await rejection(replaced(version))).toBe(unreadable);
    }
    const malformed = saved() as unknown as { origin: unknown };
    malformed.origin = null;
    expect(await rejection(replaced(malformed))).toBe(unreadable);
  });

  it("refuses an earlier version's recorded program graph", async () => {
    const recorded = {
      ...saved(),
      capabilities: {
        ...saved().capabilities,
        moduleGraph: {
          edgeKinds: ["import"],
          modulesOutsideProgram: [],
          nativeSource: "dependency-cruiser",
          source: "typescript-program",
          unresolved: [],
          unsupportedEdgeKinds: [],
        },
      },
    };
    const unreadable =
      "The dataset's analysis metadata is unreadable or uses an unsupported schema version. Build the dataset again.";
    for (const schemaVersion of [1, 3]) {
      expect(await rejection(replaced({ ...recorded, schemaVersion }))).toBe(
        unreadable
      );
    }
  });

  it("propagates a failed metadata read instead of treating it as absent", async () => {
    const failure = new Error("metadata I/O");
    const read: DatasetTransport = (path) =>
      path === DATASET_ANALYSIS_FILE
        ? Promise.reject(failure)
        : dataset.transport(path);
    await expect(datasetReader(read).analysis()).rejects.toBe(failure);
  });

  it("checks metadata saved on disk through the file transport", async () => {
    const texts = (analysis: DatasetAnalysis): Record<string, string> =>
      Object.fromEntries(
        dataset.paths.map((path) => [
          path,
          path === DATASET_ANALYSIS_FILE
            ? JSON.stringify(analysis)
            : (dataset.text(path) ?? ""),
        ])
      );
    const intact = disk.materialize(texts(saved()));
    expect(await datasetReader(fileTransport(intact)).analysis()).toEqual(
      saved()
    );
    const changed = saved();
    changed.origin.command = "different";
    const mutated = disk.materialize(texts(changed));
    expect(await rejection(fileTransport(mutated))).toBe(
      `${CONTRADICTS} origin.command "different" is not the manifest's generation.command "fileMapDataset".${AGAIN}`
    );

    expect(
      await datasetReader(fileTransport(nativeOutput)).analysis()
    ).toBeUndefined();
  });
});
