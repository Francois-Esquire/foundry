import {
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assembleSurfaceReport } from "../../src/lib/assemble";
import { datasetReader } from "../../src/lib/dataset";
import type { FileMapCapabilities } from "../../src/lib/dataset-analysis";
import type { DatasetAssemblyOutcome } from "../../src/lib/dataset-assembly";
import {
  DATASET_ANALYSIS_FILE,
  DATASET_FILES,
  packageReportFile,
} from "../../src/lib/dataset-layout";
import { resolveDependencyGraph } from "../../src/lib/dependency-graph";
import { collectDependencyInventory } from "../../src/lib/dependency-inventory";
import type { DependencyInventory } from "../../src/lib/dependency-inventory-types";
import { requireDeclared } from "../../src/lib/discovery-rules";
import {
  assembleInMemoryDataset,
  DatasetArtifacts,
  type InMemoryDataset,
  type InMemoryDatasetInput,
} from "../../src/lib/in-memory-dataset";
import { analyzePackageLocal } from "../../src/lib/package-local";
import type { PackageLocalReport } from "../../src/lib/package-local-types";
import { generateSemantics, rootName } from "../../src/lib/semantics";
import { discoverSemanticsUnits } from "../../src/lib/semantics-discover";
import {
  canonicalSemanticsText,
  listSemanticsFiles,
} from "../../src/lib/semantics-equivalence";
import type { DeclaredDiscovery } from "../../src/lib/semantics-types";
import { DEFAULT_CONFIGURATION } from "../../src/lib/spyglass-config";
import type { SurfaceReport } from "../../src/lib/types";
import { deriveWorkspaceSurface } from "../../src/lib/workspace-derive";

const now = new Date("2027-01-01T00:00:00Z");
const settings = {
  domains: DEFAULT_CONFIGURATION.domains,
  rules: DEFAULT_CONFIGURATION.rules,
};

let root: string;
let output: string;
let discovery: DeclaredDiscovery;
let inventory: DependencyInventory;
const locals = new Map<string, PackageLocalReport>();
const reports = new Map<string, SurfaceReport>();

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "in-memory-dataset-")));
  cpSync(join(import.meta.dirname, "fixtures", "semantics"), root, {
    recursive: true,
  });
  output = join(root, ".foundry", "semantics");
  await generateSemantics({
    analyzeLocal: (unit, context) => {
      const local = analyzePackageLocal({
        root: context.root,
        target: unit.path,
        tsconfig: "tsconfig.json",
      });
      locals.set(unit.id, local);
      return Promise.resolve(local);
    },
    cache: join(root, ".foundry", "cache"),
    command: "test",
    derive: async (analyzed, context) => {
      const derivation = await deriveWorkspaceSurface(analyzed, {
        now: context.now,
        root: context.root,
        tsconfig: "tsconfig.json",
      });
      return {
        reports: analyzed.map((local) => {
          const derived = derivation.packages[local.package.path];
          if (derived === undefined) {
            throw new Error(`no derivation for ${local.package.path}`);
          }
          const report = assembleSurfaceReport(local, derived);
          reports.set(local.package.name ?? local.package.path, report);
          return report;
        }),
        timing: derivation.timing,
      };
    },
    now,
    root,
  });
  discovery = requireDeclared(
    root,
    discoverSemanticsUnits(root, DEFAULT_CONFIGURATION)
  );
  inventory = collectDependencyInventory(root, discovery);
  inventory.graph = resolveDependencyGraph(root, inventory);
}, 120_000);

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

function outcomes(): DatasetAssemblyOutcome[] {
  return discovery.units.map((unit) => ({
    local: locals.get(unit.id),
    report: reports.get(unit.id),
    unit,
  }));
}

function input<C>(
  capabilities: C,
  overrides: Partial<InMemoryDatasetInput<C>> = {}
): InMemoryDatasetInput<C> {
  return {
    capabilities,
    command: "test",
    discovery,
    inventory,
    outcomes: outcomes(),
    root,
    settings,
    workspaceName: rootName(root),
    ...overrides,
  };
}

describe("assembleInMemoryDataset", () => {
  it("assembles every published artifact of the native scan", async () => {
    const dataset = await assembleInMemoryDataset(input({}));
    const published = listSemanticsFiles(output).sort();
    expect([...dataset.paths].sort()).toEqual(published);
    expect(published).toHaveLength(37);
    for (const file of published) {
      const saved = readFileSync(join(output, file), "utf8");
      const text = dataset.text(file);
      expect(text, file).toBeDefined();
      expect(
        canonicalSemanticsText(file, JSON.parse(text ?? "null")),
        file
      ).toBe(canonicalSemanticsText(file, JSON.parse(saved)));
      if (file !== DATASET_FILES.manifest) {
        expect(text, file).toBe(saved);
      }
    }
  });

  it("writes package reports first and the manifest last, in the native order", async () => {
    const dataset = await assembleInMemoryDataset(input({}));
    const reportFiles = discovery.units.map((unit) =>
      packageReportFile(unit.id)
    );
    expect(dataset.paths.slice(0, reportFiles.length)).toEqual(reportFiles);
    expect(dataset.paths.at(-1)).toBe(DATASET_FILES.manifest);
    expect(dataset.paths.at(-2)).toBe(DATASET_FILES.visualization);
  });

  it("is read through the existing dataset reader", async () => {
    const dataset = await assembleInMemoryDataset(input({}));
    const reader = dataset.reader();
    const manifest = await reader.manifest();
    expect(manifest.coverage).toBe("complete");
    expect(manifest.workspace).toEqual({
      ...(rootName(root) !== undefined && { name: rootName(root) }),
      root: root.split("/").at(-1),
    });
    expect(manifest.packages.map((pkg) => pkg.id)).toEqual([
      "@s/a",
      "@s/b",
      "@s/c",
    ]);
    expect((await reader.packageReport("@s/a")).target.name).toBe("@s/a");
    expect((await reader.moduleIndex()).shards).toHaveLength(3);
    expect(await reader.moduleShards()).toHaveLength(3);
    expect(await reader.moduleEdgeShards()).toHaveLength(3);
    expect((await reader.workspaceReport()).packages.packages).toHaveLength(3);
    expect((await reader.dependencyGraph()).nodes.length).toBeGreaterThan(0);
    expect((await reader.dependencyInventory())?.packages).toHaveLength(
      inventory.packages.length
    );
    expect(await reader.lens("file-roles")).toEqual(
      JSON.parse(readFileSync(join(output, "lenses/file-roles.json"), "utf8"))
    );
    expect((await reader.visualization())?.islands.length).toBeGreaterThan(0);

    expect(await reader.history()).toBeUndefined();
    await expect(reader.internals("@s/a")).rejects.toThrow(
      "The dataset was saved without internals for @s/a."
    );
  });

  it("keeps the caller's capabilities and states what it did not assemble", async () => {
    const capabilities = { history: { status: "unavailable" } };
    const dataset = await assembleInMemoryDataset(input(capabilities));
    expect(dataset.capabilities).toBe(capabilities);
    expect(dataset.provenance).toEqual({
      inputsFingerprint: "unrecorded",
      internals: "not-assembled",
    });
    expect(dataset.manifest.generation.inputs).toBeUndefined();
    expect(
      (await dataset.reader().manifest()).packages.every(
        (pkg) => pkg.internals === undefined
      )
    ).toBe(true);
    const recorded = await assembleInMemoryDataset(
      input(capabilities, { inputs: { config: "c", hash: "h" } })
    );
    expect(recorded.provenance.inputsFingerprint).toBe("recorded");
    expect(recorded.manifest.generation.inputs).toEqual({
      config: "c",
      hash: "h",
    });
  });

  it("gives each result its own artifacts and each read its own objects", async () => {
    const first = await assembleInMemoryDataset(input("first"));
    const second = await assembleInMemoryDataset(
      input("second", {
        outcomes: outcomes().map((outcome) =>
          outcome.unit.id === "@s/c"
            ? { error: "analysis failed", unit: outcome.unit }
            : outcome
        ),
      })
    );
    expect((await first.reader().manifest()).coverage).toBe("complete");
    expect((await second.reader().manifest()).coverage).toBe("partial");
    expect(first.paths).toContain(packageReportFile("@s/c"));
    expect(second.paths).not.toContain(packageReportFile("@s/c"));
    expect(await second.transport(packageReportFile("@s/c"))).toBeUndefined();
    await expect(second.reader().packageReport("@s/c")).rejects.toThrow(
      "Spyglass could not analyze @s/c, so it has no package report."
    );

    const read = (await first.transport(DATASET_FILES.manifest)) as {
      coverage: string;
    };
    read.coverage = "mutated";
    const again = (await first.transport(DATASET_FILES.manifest)) as {
      coverage: string;
    };
    expect(again.coverage).toBe("complete");
    expect(again).not.toBe(read);
  });

  it("owns the returned manifest independently of global paths and other results", async () => {
    const { workspace } = DATASET_FILES;
    const { boundaries } = DATASET_FILES.projections;
    const first = await assembleInMemoryDataset(input("first"));
    const second = await assembleInMemoryDataset(input("second"));
    const originalText = first.text(DATASET_FILES.manifest);
    try {
      Reflect.set(first.manifest.files, "workspace", "review-mutated.json");
      Reflect.set(
        first.manifest.files.projections,
        "boundaries",
        "review-nested.json"
      );
      expect(DATASET_FILES.workspace).toBe(workspace);
      expect(DATASET_FILES.projections.boundaries).toBe(boundaries);
      expect(second.manifest.files.workspace).toBe(workspace);
      expect(second.manifest.files.projections.boundaries).toBe(boundaries);
      expect(first.text(DATASET_FILES.manifest)).toBe(originalText);
      expect((await first.reader().manifest()).files.workspace).toBe(workspace);
      const third = await assembleInMemoryDataset(input("third"));
      expect(third.paths).toContain(workspace);
      expect(third.paths).not.toContain("review-mutated.json");
      expect(third.manifest.files.projections.boundaries).toBe(boundaries);
    } finally {
      Reflect.set(DATASET_FILES, "workspace", workspace);
      Reflect.set(DATASET_FILES.projections, "boundaries", boundaries);
    }
  });

  it("reports a missing required artifact and an absent optional one through the reader", async () => {
    const dataset = await assembleInMemoryDataset(input({}));
    const without =
      (missing: string): InMemoryDataset<unknown>["transport"] =>
      (path) =>
        path === missing ? Promise.resolve(undefined) : dataset.transport(path);
    await expect(
      datasetReader(without(DATASET_FILES.workspace)).workspaceReport()
    ).rejects.toThrow(
      `The dataset is missing ${DATASET_FILES.workspace}. Run spyglass scan again.`
    );
    await expect(
      datasetReader(without(DATASET_FILES.manifest)).manifest()
    ).rejects.toThrow("No dataset found.");
    const noVisualization = datasetReader(async (path) => {
      const value = await dataset.transport(path);
      if (path !== DATASET_FILES.manifest) {
        return value;
      }
      const { visualization: _dropped, ...files } = (
        value as { files: Record<string, unknown> }
      ).files;
      return { ...(value as object), files };
    });
    expect(await noVisualization.visualization()).toBeUndefined();
    expect(await dataset.transport("not/a/dataset/file.json")).toBeUndefined();
  });
});

function capabilitiesAt(at: string): FileMapCapabilities {
  return {
    configuration: {
      configModules: [],
      diagnostics: [],
      executed: false,
      tsconfig: "tsconfig.json",
      unusedRootTsconfig: false,
    },
    history: {
      available: false,
      detail: "A file map carries no Git history.",
      reason: "not-git-repository",
    },
    moduleGraph: { source: "dependency-cruiser", unresolved: [] },
    paths: { root: at, semantics: "posix" },
    types: {
      diagnostics: [],
      policy: "explicit-declarations-and-bundled-libs",
      suppliedDeclarations: [],
      typesOption: [],
      typesOptionSource: "policy-empty",
      unresolvedPackages: [],
    },
  };
}

describe("assembleInMemoryDataset with analysis metadata", () => {
  const CONTRADICTS = "The analysis metadata contradicts the assembly inputs:";

  async function refused(
    overrides: Partial<InMemoryDatasetInput<FileMapCapabilities>>
  ): Promise<string> {
    const phases: string[] = [];
    const error = await assembleInMemoryDataset(
      input(capabilitiesAt(root), {
        beforePhase: (name) => {
          phases.push(name);
          return Promise.resolve();
        },
        origin: { command: "test", kind: "file-map", root },
        ...overrides,
      })
    ).then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect(phases).toEqual([]);
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }

  it("saves metadata that agrees with the assembly and its manifest", async () => {
    const origin = { command: "test", kind: "file-map", root } as const;
    const unrecorded = await assembleInMemoryDataset(
      input(capabilitiesAt(root), { origin })
    );
    expect(unrecorded.paths).toContain(DATASET_ANALYSIS_FILE);
    expect(await unrecorded.reader().analysis()).toEqual({
      capabilities: capabilitiesAt(root),
      origin,
      provenance: {
        inputsFingerprint: "unrecorded",
        internals: "not-assembled",
      },
      schemaVersion: 3,
    });
    const recorded = await assembleInMemoryDataset(
      input(capabilitiesAt(root), {
        inputs: { config: "c", hash: "h" },
        origin,
      })
    );
    expect((await recorded.reader().analysis())?.provenance).toEqual({
      inputsFingerprint: "recorded",
      internals: "not-assembled",
    });
    expect(recorded.manifest.generation.inputs).toEqual({
      config: "c",
      hash: "h",
    });
  });

  it("refuses an origin root other than the assembly root", async () => {
    const moved = `/elsewhere/${root.split("/").at(-1)}`;
    expect(
      await refused({
        capabilities: capabilitiesAt(moved),
        origin: { command: "test", kind: "file-map", root: moved },
      })
    ).toBe(
      `${CONTRADICTS} origin.root "${moved}" is not the assembly root "${root}".`
    );
  });

  it("refuses capabilities placed under another root", async () => {
    expect(await refused({ capabilities: capabilitiesAt("/elsewhere") })).toBe(
      `${CONTRADICTS} origin.root "${root}" is not capabilities.paths.root "/elsewhere".`
    );
  });

  it("refuses an origin command other than the assembly command", async () => {
    expect(
      await refused({
        origin: { command: "different", kind: "file-map", root },
      })
    ).toBe(
      `${CONTRADICTS} origin.command "different" is not the manifest's generation.command "test".`
    );
  });

  it("refuses capabilities the metadata schema does not accept", async () => {
    const capabilities = {
      ...capabilitiesAt(root),
      history: { available: true },
    } as unknown as FileMapCapabilities;
    expect(await refused({ capabilities })).toBe(
      "The dataset's analysis metadata is unreadable or uses an unsupported schema version. Build the dataset again."
    );
  });
});

describe("DatasetArtifacts", () => {
  it("refuses a second write of a path and paths that are not dataset-relative", () => {
    const artifacts = new DatasetArtifacts();
    artifacts.write("manifest.json", { a: 1 });
    expect(() => artifacts.write("manifest.json", { a: 2 })).toThrow(
      "The dataset already has manifest.json."
    );
    for (const path of [
      "",
      "/manifest.json",
      "../manifest.json",
      "lenses/../manifest.json",
      "./manifest.json",
      "lenses//a.json",
      "lenses/a.json/",
      "lenses\\a.json",
    ]) {
      expect(() => artifacts.write(path, {}), path).toThrow(
        "Not a dataset-relative path"
      );
    }
    expect(() => artifacts.write("undefined.json", undefined)).toThrow(
      "undefined.json has no JSON value."
    );
    expect(artifacts.paths()).toEqual(["manifest.json"]);
    expect(artifacts.files).toEqual([
      { bytes: 7, file: "manifest.json", reused: false },
    ]);
  });
});
