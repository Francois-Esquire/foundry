import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, sep } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assembleSurfaceReport } from "../../src/lib/assemble";
import { DEFAULT_CONFIGURATION } from "../../src/lib/atlas-config";
import { ANALYSIS_CONFIG } from "../../src/lib/config";
import { datasetReader } from "../../src/lib/dataset";
import { fileTransport } from "../../src/lib/dataset-files";
import { encodePackageFile } from "../../src/lib/dataset-layout";
import { analyzePackageLocal } from "../../src/lib/package-local";
import type {
  SemanticsDeriver,
  SemanticsLocalAnalyzer,
} from "../../src/lib/semantics";
import {
  generateSemantics,
  spawnDeriver,
  spawnLocalAnalyzer,
} from "../../src/lib/semantics";
import { discoverSemanticsUnits } from "../../src/lib/semantics-discover";
import { compareSemanticsDatasets } from "../../src/lib/semantics-equivalence";
import type {
  DatasetManifest,
  SemanticsConceptIndex,
  SemanticsModuleEdgeShard,
  SemanticsModuleIndex,
  SemanticsModuleShard,
} from "../../src/lib/semantics-types";
import { DATASET_SCHEMA_VERSION } from "../../src/lib/semantics-types";
import type { SurfaceReport } from "../../src/lib/types";
import { deriveWorkspaceSurface } from "../../src/lib/workspace-derive";
import { ingestWorkspaceReports } from "../../src/lib/workspace-ingest";
import { analyzeWorkspace } from "../../src/lib/workspace-intelligence";
import {
  createWorkspaceProjectionContext,
  projectWorkspaceOverview,
} from "../../src/lib/workspace-projection";
import type { WorkspaceOverviewProjection } from "../../src/lib/workspace-projection-types";
import { projectWorkspaceGraph } from "../../src/lib/workspace-projection-views";
import { analyzeWorkspaceSurfaces } from "../../src/lib/workspace-surface";
import type { WorkspaceReport } from "../../src/lib/workspace-types";
import { WORKSPACE_SCHEMA_VERSION } from "../../src/lib/workspace-types";
import { resolveCodex } from "../../src/web/codex/resolve";
import { readCodexSource } from "../../src/web/codex/source";
import { listedFiles } from "../helpers/dataset-files";
import { hashTree } from "./helpers/planning-fixture";

let fixture: string;
const now = new Date("2027-01-01T00:00:00Z");

beforeAll(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), "semantics-fixture-")));
  cpSync(join(import.meta.dirname, "fixtures", "semantics"), fixture, {
    recursive: true,
  });
  // Generated output is ignored by Git, so create this discovery fixture here.
  mkdirSync(join(fixture, "packages", "dist"), { recursive: true });
  writeFileSync(
    join(fixture, "packages", "dist", "index.ts"),
    "export const generated = true;\n"
  );
});

afterAll(() => {
  rmSync(fixture, { force: true, recursive: true });
});

/** In-process seams: the canonical analysis with the fixture tsconfig, no worker. */
const inProcessLocal: SemanticsLocalAnalyzer = (unit, context) =>
  Promise.resolve(
    analyzePackageLocal({
      root: context.root,
      target: unit.path,
      tsconfig: "tsconfig.json",
    })
  );

const inProcessDerive: SemanticsDeriver = async (locals, context) => {
  const derivation = await deriveWorkspaceSurface(locals, {
    now: context.now,
    root: context.root,
    tsconfig: "tsconfig.json",
  });
  return {
    reports: locals.map((local) => {
      const derived = derivation.packages[local.package.path];
      if (derived === undefined) {
        throw new Error(`no derivation for ${local.package.path}`);
      }
      return assembleSurfaceReport(local, derived);
    }),
    timing: derivation.timing,
  };
};

const inProcess = { analyzeLocal: inProcessLocal, derive: inProcessDerive };

/** A deriver that returns no report for the last package, `@s/c`. */
const withoutLastReport: SemanticsDeriver = async (locals, context) => {
  const derived = await inProcessDerive(locals, context);
  return { ...derived, reports: derived.reports.slice(0, -1) };
};

function copyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "semantics-"));
  cpSync(fixture, dir, { recursive: true });
  return realpathSync(dir);
}

function readJson(dir: string, file: string): unknown {
  return JSON.parse(readFileSync(join(dir, file), "utf8"));
}

function readManifest(dir: string): DatasetManifest {
  return readJson(dir, "manifest.json") as DatasetManifest;
}

function readShard(dir: string, file: string): SemanticsModuleShard {
  return readJson(dir, file) as SemanticsModuleShard;
}

function listFiles(dir: string): string[] {
  return [...hashTree(dir).keys()].sort();
}

/**
 * Package reports carry the V8 simulation `runtimeMs`, the analyzer's own
 * volatile field; every other value is deterministic under a fixed clock.
 */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "runtimeMs")
        .map(([key, inner]) => [key, stable(inner)])
    );
  }
  return value;
}

/** Everything under the dataset except the volatile generation metadata. */
function stableDataset(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const file of hashTree(dir).keys()) {
    const parsed = readJson(dir, file);
    if (file === "manifest.json") {
      const { generatedAt: _at, generation: _gen, ...rest } = readManifest(dir);
      files.set(file, JSON.stringify(rest));
    } else {
      files.set(file, JSON.stringify(stable(parsed)));
    }
  }
  return files;
}

describe("discovery", () => {
  it("finds one unit per directory a package pattern matches and records every skip", () => {
    const discovery = discoverSemanticsUnits(fixture, DEFAULT_CONFIGURATION);
    expect(discovery.units.map((u) => [u.id, u.path])).toEqual([
      ["@s/a", "apps/a"],
      ["@s/b", "packages/b"],
      ["@s/c", "tooling/c"],
    ]);
    expect(discovery.units.every((u) => u.analyzable)).toBe(true);
    expect(discovery.units[0]?.manifestPath).toBe("apps/a/package.json");
    expect(discovery.packagePatterns).toEqual([
      "apps/*",
      "packages/*",
      "tooling/*",
    ]);
    expect(discovery.declarationSource).toBe("package.json#workspaces");
    expect(discovery.packagePatternsUnmatched).toEqual([]);
    expect(discovery.excludeUnmatched).toEqual([]);
    expect(discovery.unitsDiscovered).toBe(6);
    expect(discovery.skipped).toEqual([
      { path: "packages/dist", reason: "generated output" },
      { path: "packages/docs-only", reason: "analysis unsupported" },
      { path: "packages/loose", reason: "no package manifest" },
    ]);
  });

  it("skips excluded units and reports exclusions that matched none", () => {
    const discovery = discoverSemanticsUnits(fixture, {
      ...DEFAULT_CONFIGURATION,
      exclude: ["tooling/c", "tooling/typo"],
    });
    expect(discovery.units.map((u) => u.id)).toEqual(["@s/a", "@s/b"]);
    expect(discovery.skipped).toContainEqual({
      path: "tooling/c",
      reason: "excluded",
    });
    expect(discovery.excludeUnmatched).toEqual(["tooling/typo"]);
  });

  it("follows pnpm-workspace.yaml first, trims trailing slashes, and drops negations", () => {
    const dir = copyFixture();
    writeFileSync(
      join(dir, "pnpm-workspace.yaml"),
      "packages:\n  - services/*\n  - libraries/lib/\n  - '!services/svc'\n  - vendor/*\n"
    );
    const discovery = discoverSemanticsUnits(dir, DEFAULT_CONFIGURATION);
    expect(discovery.units.map((u) => [u.id, u.path])).toEqual([
      ["@s/lib", "libraries/lib"],
      ["@s/svc", "services/svc"],
    ]);
    expect(discovery.declarationSource).toBe("pnpm-workspace.yaml");
    expect(discovery.packagePatterns).toEqual([
      "services/*",
      "libraries/lib/",
      "!services/svc",
      "vendor/*",
    ]);
    expect(discovery.packagePatternsUnmatched).toEqual(["vendor/*"]);
    rmSync(dir, { force: true, recursive: true });
  });

  it("ignores package patterns that resolve to the root or escape it, without calling them unmatched", () => {
    const dir = copyFixture();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ workspaces: [".", "../*", "packages/b"] })
    );
    const discovery = discoverSemanticsUnits(dir, DEFAULT_CONFIGURATION);
    expect(discovery.units.map((u) => u.path)).toEqual(["packages/b"]);
    expect(discovery.packagePatterns).toEqual([".", "../*", "packages/b"]);
    expect(discovery.packagePatternsUnmatched).toEqual([]);
    expect(discovery.unitsDiscovered).toBe(1);
    rmSync(dir, { force: true, recursive: true });
  });

  it("records a directory two patterns match once", () => {
    const dir = copyFixture();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ workspaces: ["packages/b", "packages/*"] })
    );
    const discovery = discoverSemanticsUnits(dir, DEFAULT_CONFIGURATION);
    expect(discovery.units.map((u) => u.id)).toEqual(["@s/b"]);
    expect(discovery.unitsDiscovered).toBe(4);
    rmSync(dir, { force: true, recursive: true });
  });

  it("analyzes a pnpm workspace as its package.json twin", async () => {
    const declared = copyFixture();
    const pnpm = copyFixture();
    writeFileSync(
      join(pnpm, "package.json"),
      JSON.stringify({ name: "semantics-root", private: true })
    );
    writeFileSync(
      join(pnpm, "pnpm-workspace.yaml"),
      "packages:\n  - apps/*\n  - packages/*\n  - tooling/*\n"
    );
    const [left, right] = await Promise.all(
      [declared, pnpm].map((root) =>
        generateSemantics({ command: "test", now, root, ...inProcess })
      )
    );
    const differences = compareSemanticsDatasets(
      left?.output ?? "",
      right?.output ?? ""
    ).differences.filter((difference) => difference.file !== "manifest.json");
    expect(differences).toEqual([]);
    expect(readManifest(right?.output ?? "").discovery.declarationSource).toBe(
      "pnpm-workspace.yaml"
    );
    expect(
      readManifest(right?.output ?? "").packages.map((pkg) => pkg.id)
    ).toEqual(["@s/a", "@s/b", "@s/c"]);
    for (const root of [declared, pnpm]) {
      rmSync(root, { force: true, recursive: true });
    }
  }, 60_000);

  it("refuses to scan a workspace that declares no packages", async () => {
    const dir = copyFixture();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "solo" }));
    expect(
      discoverSemanticsUnits(dir, DEFAULT_CONFIGURATION).declarationSource
    ).toBeUndefined();
    await expect(
      generateSemantics({ root: dir, ...inProcess })
    ).rejects.toThrow(
      `Workspace ${dir} declares no packages. Atlas reads them from pnpm-workspace.yaml or package.json#workspaces.`
    );
    expect(existsSync(join(dir, ".foundry", "semantics"))).toBe(false);
    rmSync(dir, { force: true, recursive: true });
  });

  it("names a scoped package's files without a separator", () => {
    expect(encodePackageFile("@foundry/db")).toBe("@foundry__db");
    expect(encodePackageFile("plain")).toBe("plain");
  });
});

describe("generation", () => {
  let root: string;
  let before: Map<string, string>;
  let manifest: DatasetManifest;
  let dataset: string;
  let reports: SurfaceReport[];
  let workspace: WorkspaceReport;

  beforeAll(async () => {
    root = copyFixture();
    before = hashTree(root);
    const result = await generateSemantics({
      now,
      root,
      ...inProcess,
      command: "test",
    });
    dataset = result.output;
    manifest = readManifest(dataset);
    ({ reports } = await analyzeWorkspaceSurfaces({
      now,
      root,
      targets: ["apps/a", "packages/b", "tooling/c"],
      tsconfig: "tsconfig.json",
    }));
    workspace = analyzeWorkspace(
      ingestWorkspaceReports(reports, { root: "semantics-root" })
    );
  });

  afterAll(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it("writes the dataset under .foundry/semantics with a complete manifest", () => {
    expect(dataset).toBe(join(root, ".foundry", "semantics"));
    expect(manifest.schemaVersion).toBe(DATASET_SCHEMA_VERSION);
    expect(manifest.coverage).toBe("complete");
    expect(manifest.workspace).toEqual({
      name: "semantics-root",
      root: basename(root),
    });
    expect(manifest.discovery).toMatchObject({
      declarationSource: "package.json#workspaces",
      excludeUnmatched: [],
      packagePatterns: ["apps/*", "packages/*", "tooling/*"],
      packagePatternsUnmatched: [],
    });
    expect(manifest.versions.workspaceSchema).toBe(WORKSPACE_SCHEMA_VERSION);
    expect(manifest.versions.packageSchema).toBe(35);
    expect(manifest.counts.packages).toBe(3);
    expect(manifest.counts.modules).toBe(7);
    expect(manifest.counts.concepts).toBeGreaterThan(0);
    expect(
      manifest.packages.map((p) => [p.id, p.status, p.modules.count])
    ).toEqual([
      ["@s/a", "complete", 2],
      ["@s/b", "complete", 2],
      ["@s/c", "complete", 3],
    ]);
    // Ranges as each package.json writes them; a kind it lacks is omitted.
    expect(
      manifest.packages.map((p) => [p.id, p.declaredDependencies])
    ).toEqual([
      ["@s/a", { dependencies: { "@s/b": "workspace:*" } }],
      ["@s/b", {}],
      ["@s/c", { dependencies: { "@s/b": "workspace:*" } }],
    ]);
    for (const pkg of manifest.packages) {
      expect(pkg).not.toHaveProperty("name");
      expect(pkg.internals).toBeUndefined();
    }
    expect(manifest.discovery.unitsDiscovered).toBe(6);
    expect(manifest.discovery.packagesFound).toBe(3);
    expect(manifest.discovery.unitsAnalyzed).toBe(3);
    expect(manifest.discovery.unitsSkipped).toHaveLength(3);
    expect(manifest.generation.phases.map((p) => p.name)).toEqual([
      "discover",
      "fingerprint",
      "analyze",
      "derive",
      "ingest",
      "intelligence",
      "project",
      "write",
      "lenses",
    ]);
    expect(manifest.generation.partial).toBe(false);
    expect(manifest.generation.command).toBe("test");
  });

  it("references only relative files that exist", () => {
    const listed = listedFiles(dataset);
    expect(listed.length).toBeGreaterThan(10);
    for (const file of listed) {
      expect(isAbsolute(file)).toBe(false);
      expect(file.startsWith("..")).toBe(false);
      expect(existsSync(join(dataset, file))).toBe(true);
    }
    expect(listFiles(dataset)).toEqual(listed);
    const text = readFileSync(join(dataset, "manifest.json"), "utf8");
    expect(text).not.toContain(root);
    expect(text).not.toContain(tmpdir());
  });

  it("publishes each lens's output, named in the manifest with its schema version", () => {
    expect(manifest.lenses).toEqual({
      "file-roles": { file: "lenses/file-roles.json", schemaVersion: 1 },
      "frequent-change": {
        file: "lenses/frequent-change.json",
        schemaVersion: 1,
      },
      "package-sizes": {
        file: "lenses/package-sizes.json",
        schemaVersion: 1,
      },
      placement: { file: "lenses/placement.json", schemaVersion: 1 },
      "responsibility-groups": {
        file: "lenses/responsibility-groups.json",
        schemaVersion: 1,
      },
    });
    // This scan saves no internals, so every complete package is missing.
    // The fixture is not a Git repository, so no package has churn.
    expect(readJson(dataset, "lenses/frequent-change.json")).toEqual({
      gate: {
        eligibleKinds: ANALYSIS_CONFIG.hotspots.eligibleKinds,
        minCommitPercentile: ANALYSIS_CONFIG.hotspots.gates.minCommitPercentile,
      },
      missing: ["@s/a", "@s/b", "@s/c"],
      packages: [],
    });
    for (const lens of ["file-roles", "responsibility-groups"]) {
      expect(readJson(dataset, `lenses/${lens}.json`)).toEqual({
        missing: ["@s/a", "@s/b", "@s/c"],
        packages: [],
      });
    }
    // Without internals the home use is unknown, so no place is labelled.
    expect(readJson(dataset, "lenses/placement.json")).toEqual({
      missing: ["@s/a", "@s/b", "@s/c"],
      packages: [],
      places: [],
      policy: { dominantShare: 0.6 },
    });
    const kinds = { config: 0, other: 0, source: 0, story: 0, test: 0 };
    expect(readJson(dataset, "lenses/package-sizes.json")).toEqual({
      packages: [
        {
          analyzed: true,
          id: "@s/a",
          layer: 1,
          modules: {
            byKind: { ...kinds, source: 1, test: 1, unknown: 0 },
            total: 2,
          },
        },
        {
          analyzed: true,
          id: "@s/b",
          layer: 0,
          modules: { byKind: { ...kinds, source: 2, unknown: 0 }, total: 2 },
        },
        {
          analyzed: true,
          id: "@s/c",
          layer: 1,
          modules: { byKind: { ...kinds, source: 3, unknown: 0 }, total: 3 },
        },
      ],
    });
  });

  it("materializes each package report exactly as the canonical analyzer returns it", () => {
    for (const report of reports) {
      const entry = manifest.packages.find(
        (p) => p.path === report.target.path
      );
      expect(entry?.report).toBeDefined();
      expect(stable(readJson(dataset, entry?.report ?? ""))).toEqual(
        stable(report)
      );
    }
  });

  it("materializes the canonical workspace with every V9 layer", () => {
    const written = readJson(
      dataset,
      manifest.files.workspace
    ) as WorkspaceReport;
    expect(stable(written)).toEqual(stable(workspace));
    expect(written.intelligence?.graph).toBeDefined();
    expect(written.intelligence?.concepts).toBeDefined();
    expect(written.intelligence?.patterns).toBeDefined();
    expect(written.ingestion.coverage.complete).toBe(true);
  });

  it("materializes projections equal to the V9.4 API", () => {
    const context = createWorkspaceProjectionContext(workspace);
    expect(readJson(dataset, manifest.files.projections.overview)).toEqual(
      projectWorkspaceOverview(context)
    );
    expect(
      readJson(dataset, manifest.files.projections.dependencyGraph)
    ).toEqual(projectWorkspaceGraph(context, "dependency-topology"));
  });

  it("records a module with its package, graph facts, concept roles, and edges", () => {
    const index = readJson(
      dataset,
      manifest.files.moduleIndex
    ) as SemanticsModuleIndex;
    expect(index.coverage.moduleEdges).toBe("sharded");
    expect(index.modules.map((m) => [m.id, m.fileKind])).toEqual([
      ["apps/a/src/index.test.ts", "test"],
      ["apps/a/src/index.ts", "source"],
      ["packages/b/src/index.ts", "source"],
      ["packages/b/src/shape.ts", "source"],
      ["tooling/c/src/index.ts", "source"],
      ["tooling/c/src/pad.ts", "source"],
      ["tooling/c/src/unit.ts", "source"],
    ]);
    const shard = readShard(dataset, "modules/@s__a.json");
    expect(shard.package).toBe("@s/a");
    const test = shard.modules.find((m) => m.id === "apps/a/src/index.test.ts");
    expect(test).toMatchObject({
      dependencies: { incoming: [], outgoing: ["packages/b/src/index.ts"] },
      fileKind: "test",
    });
    const record = shard.modules.find((m) => m.id === "apps/a/src/index.ts");
    expect(record).toMatchObject({
      dependencies: { incoming: [], outgoing: ["packages/b/src/index.ts"] },
      fileKind: "source",
      id: "apps/a/src/index.ts",
      package: "@s/a",
      path: "apps/a/src/index.ts",
    });
    expect(record?.graph).toMatchObject({ cycle: false, fanOut: 1 });
    expect(record?.gravity).toEqual(
      workspace.graph.modules.find((m) => m.id === "apps/a/src/index.ts")
        ?.gravity
    );
    expect(record?.concepts.declared).toEqual(["apps/a/src/index.ts#Tile"]);
    expect(record?.concepts.representation).toEqual([
      "apps/a/src/index.ts#Tile",
      "packages/b/src/shape.ts#Shape",
    ]);
    expect(record?.concepts.usage).toEqual(["apps/a/src/index.ts#Tile"]);
    expect(record?.evolution).toBeUndefined();
    expect(record?.cautions).toEqual(["evolution-unavailable"]);
    const c = readShard(dataset, "modules/@s__c.json");
    const fence = c.modules.find((m) => m.id === "tooling/c/src/index.ts");
    expect(fence?.concepts).toMatchObject({
      behavior: ["packages/b/src/shape.ts#Shape"],
      declared: [],
      usage: ["packages/b/src/shape.ts#Shape", "tooling/c/src/unit.ts#Unit"],
    });
    const b = readShard(dataset, "modules/@s__b.json");
    const barrel = b.modules.find((m) => m.id === "packages/b/src/index.ts");
    expect(barrel?.dependencies.incoming).toEqual([
      "apps/a/src/index.test.ts",
      "apps/a/src/index.ts",
      "tooling/c/src/index.ts",
    ]);
    expect(barrel?.graph).toMatchObject({ fanIn: 3, fanOut: 0, layer: 0 });
    const shape = b.modules.find((m) => m.id === "packages/b/src/shape.ts");
    expect(shape?.concepts.declared).toEqual(["packages/b/src/shape.ts#Shape"]);
    expect(shape?.concepts.behavior).toEqual(["packages/b/src/shape.ts#Shape"]);
    expect(shape?.dependencies.incoming).toEqual([]);
  });

  it("gives the viewer each module's import counts as its saved gravity fan-in and fan-out", async () => {
    const reader = datasetReader(fileTransport(dataset));
    const codex = resolveCodex(await readCodexSource(reader));
    const records = (await reader.moduleShards()).flatMap((s) => s.modules);
    expect(codex.modules).toHaveLength(records.length);
    for (const record of records) {
      const counted = codex.modules.find((m) => m.id === record.id);
      expect([counted?.dependents, counted?.dependencies]).toEqual([
        record.gravity?.fanIn,
        record.gravity?.fanOut,
      ]);
    }
  });

  it("gives each package pair as many module edges as import edges between its endpoint files", async () => {
    const codex = resolveCodex(
      await readCodexSource(datasetReader(fileTransport(dataset)))
    );
    expect(codex.dependencies.length).toBeGreaterThan(0);
    for (const dependency of codex.dependencies) {
      expect(dependency.consumerFiles.length).toBeGreaterThan(0);
      expect(dependency.supplierFiles.length).toBeGreaterThan(0);
      const consumers = new Set(dependency.consumerFiles);
      const suppliers = new Set(dependency.supplierFiles);
      expect(
        codex.imports.filter(
          (edge) => consumers.has(edge.source) && suppliers.has(edge.target)
        )
      ).toHaveLength(dependency.strength);
    }
  });

  it("shards every directed module edge by source package with scope and type metadata", () => {
    const index = readJson(
      dataset,
      manifest.files.moduleIndex
    ) as SemanticsModuleIndex;
    expect(index.edgeShards).toEqual([
      {
        crossPackage: 2,
        file: "modules/edges/@s__a.json",
        intraPackage: 1,
        package: "@s/a",
      },
      {
        crossPackage: 0,
        file: "modules/edges/@s__b.json",
        intraPackage: 1,
        package: "@s/b",
      },
      {
        crossPackage: 1,
        file: "modules/edges/@s__c.json",
        intraPackage: 3,
        package: "@s/c",
      },
    ]);
    const c = readJson(
      dataset,
      "modules/edges/@s__c.json"
    ) as SemanticsModuleEdgeShard;
    expect(c.package).toBe("@s/c");
    // index → pad → unit inside one package, plus a type-only index → unit
    expect(c.edges).toEqual([
      {
        id: "tooling/c/src/index.ts→packages/b/src/index.ts",
        relation: "dependency",
        scope: "cross-package",
        source: "tooling/c/src/index.ts",
        target: "packages/b/src/index.ts",
        typeOnly: false,
      },
      {
        id: "tooling/c/src/index.ts→tooling/c/src/pad.ts",
        relation: "dependency",
        scope: "intra-package",
        source: "tooling/c/src/index.ts",
        target: "tooling/c/src/pad.ts",
        typeOnly: false,
      },
      {
        id: "tooling/c/src/index.ts→tooling/c/src/unit.ts",
        relation: "dependency",
        scope: "intra-package",
        source: "tooling/c/src/index.ts",
        target: "tooling/c/src/unit.ts",
        typeOnly: true,
      },
      {
        id: "tooling/c/src/pad.ts→tooling/c/src/unit.ts",
        relation: "dependency",
        scope: "intra-package",
        source: "tooling/c/src/pad.ts",
        target: "tooling/c/src/unit.ts",
        typeOnly: false,
      },
    ]);
    // cross-package edges match the canonical workspace graph exactly
    const crossEdges = index.edgeShards.flatMap((shard) =>
      (readJson(dataset, shard.file) as SemanticsModuleEdgeShard).edges
        .filter((e) => e.scope === "cross-package")
        .map((e) => e.id)
    );
    expect(crossEdges.sort()).toEqual(
      workspace.graph.moduleEdges.map((e) => e.id).sort()
    );
    // module records still list cross-package edges only
    const cShard = readShard(dataset, "modules/@s__c.json");
    const fence = cShard.modules.find((m) => m.id === "tooling/c/src/index.ts");
    expect(fence?.dependencies.outgoing).toEqual(["packages/b/src/index.ts"]);
    // internal edges are the package report's own measurement
    const report = reports.find((r) => r.target.name === "@s/c");
    expect(report?.dependencyGravity.internalEdges).toEqual([
      {
        fromFile: "tooling/c/src/index.ts",
        toFile: "tooling/c/src/pad.ts",
        typeOnly: false,
      },
      {
        fromFile: "tooling/c/src/index.ts",
        toFile: "tooling/c/src/unit.ts",
        typeOnly: true,
      },
      {
        fromFile: "tooling/c/src/pad.ts",
        toFile: "tooling/c/src/unit.ts",
        typeOnly: false,
      },
    ]);
  });

  it("indexes every concept with its declaring package and centers", () => {
    const index = readJson(
      dataset,
      manifest.files.conceptIndex
    ) as SemanticsConceptIndex;
    const shape = index.concepts.find(
      (c) => c.id === "packages/b/src/shape.ts#Shape"
    );
    expect(shape).toMatchObject({
      coverage: "authoritative",
      file: "packages/b/src/shape.ts",
      name: "Shape",
      package: "@s/b",
    });
    expect(shape?.packages).toEqual(["@s/a", "@s/b", "@s/c"]);
    expect(shape?.centers.semantic).toBe("@s/b");
    expect(index.concepts.length).toBe(manifest.counts.concepts);
  });

  it("writes nothing outside the configured output and the cache", () => {
    const after = hashTree(root);
    for (const [file, hash] of before) {
      expect(after.get(file)).toBe(hash);
    }
    const added = [...after.keys()].filter((f) => !before.has(f));
    expect(added.length).toBeGreaterThan(0);
    expect(
      added.every(
        (f) =>
          f.startsWith(join(".foundry", "semantics") + sep) ||
          f.startsWith(join(".foundry", "cache", "semantics") + sep)
      )
    ).toBe(true);
    expect(readdirSync(join(root, ".foundry")).sort()).toEqual([
      "cache",
      "semantics",
    ]);
  });

  it("is idempotent aside from generation metadata", async () => {
    const first = stableDataset(dataset);
    await generateSemantics({ now, root, ...inProcess, command: "test" });
    const second = stableDataset(dataset);
    expect([...second.keys()].sort()).toEqual([...first.keys()].sort());
    for (const [file, hash] of first) {
      expect(second.get(file)).toBe(hash);
    }
  });

  it("is independent of completion order under concurrency", async () => {
    const sequential = stableDataset(dataset);
    const delays: Record<string, number> = {
      "@s/a": 300,
      "@s/b": 150,
      "@s/c": 0,
    };
    const finished: string[] = [];
    const reversed: SemanticsLocalAnalyzer = async (unit, context) => {
      await new Promise((resolve) => {
        setTimeout(resolve, delays[unit.id] ?? 0);
      });
      finished.push(unit.id);
      return inProcessLocal(unit, context);
    };
    await generateSemantics({
      analyzeLocal: reversed,
      command: "test",
      concurrency: 3,
      derive: inProcessDerive,
      now,
      root,
    });
    expect(finished).toEqual(["@s/c", "@s/b", "@s/a"]);
    const concurrent = stableDataset(dataset);
    expect([...concurrent.keys()].sort()).toEqual(
      [...sequential.keys()].sort()
    );
    for (const [file, hash] of sequential) {
      expect(concurrent.get(file), file).toBe(hash);
    }
  });

  it("drops records of units that disappeared", async () => {
    const files = listFiles(dataset);
    expect(files).toContain("packages/@s__c.json");
    rmSync(join(root, "tooling", "c"), { recursive: true });
    await generateSemantics({ now, root, ...inProcess });
    const after = listFiles(dataset);
    expect(after.some((f) => f.includes("@s__c"))).toBe(false);
    const next = readManifest(dataset);
    expect(next.packages.map((p) => p.id)).toEqual(["@s/a", "@s/b"]);
    expect(next.coverage).toBe("complete");
  });
});

describe("failure handling", () => {
  it("keeps going when one analysis fails and marks the dataset partial", async () => {
    const root = copyFixture();
    const analyzeLocal: SemanticsLocalAnalyzer = (unit, context) => {
      if (unit.id === "@s/c") {
        return Promise.reject(new Error("boom"));
      }
      return inProcessLocal(unit, context);
    };
    const result = await generateSemantics({
      analyzeLocal,
      derive: inProcessDerive,
      now,
      root,
    });
    expect(result.packages).toEqual({
      analyzed: 2,
      complete: 2,
      discovered: 3,
      failed: 1,
      reused: 0,
      skipped: 3,
      unchanged: 0,
    });
    expect(result.errors).toEqual([
      { message: "boom", phase: "analyze", unit: "@s/c" },
    ]);
    const manifest = readManifest(result.output);
    expect(manifest.coverage).toBe("partial");
    expect(manifest.generation.partial).toBe(true);
    expect(manifest.generation.packageFailures).toBe(1);
    const failed = manifest.packages.find((p) => p.id === "@s/c");
    expect(failed).toMatchObject({
      error: "boom",
      modules: { count: 1 },
      status: "failed",
    });
    expect(failed?.report).toBeUndefined();
    expect(failed?.projection).toBe("packages/@s__c.projection.json");
    expect(existsSync(join(result.output, "packages/@s__c.json"))).toBe(false);
    const workspace = readJson(
      result.output,
      manifest.files.workspace
    ) as WorkspaceReport;
    expect(workspace.ingestion.coverage.complete).toBe(false);
    expect(workspace.ingestion.coverage.missingPackages).toEqual(["@s/c"]);
    const overview = readJson(
      result.output,
      manifest.files.projections.overview
    ) as WorkspaceOverviewProjection;
    expect(overview.coverage.packagesAnalyzed).toBe(2);
    expect(overview.coverage.packagesKnown).toBe(3);
    rmSync(root, { force: true, recursive: true });
  });

  it("marks a package the derivation leaves out as failed, with the reason", async () => {
    const root = copyFixture();
    const result = await generateSemantics({
      analyzeLocal: inProcessLocal,
      derive: withoutLastReport,
      now,
      root,
    });
    expect(result.errors).toEqual([
      {
        message: "Derivation produced no report.",
        phase: "derive",
        unit: "@s/c",
      },
    ]);
    expect(
      readManifest(result.output).packages.find((p) => p.id === "@s/c")
    ).toMatchObject({
      error: "Derivation produced no report.",
      status: "failed",
    });
    rmSync(root, { force: true, recursive: true });
  });

  it("leaves the previous dataset byte-identical when generation fails", async () => {
    const root = copyFixture();
    const first = await generateSemantics({ now, root, ...inProcess });
    const good = hashTree(first.output);
    const analyzeLocal: SemanticsLocalAnalyzer = (unit, context) => {
      if (unit.id === "@s/b") {
        return Promise.reject(new Error("disk on fire"));
      }
      return inProcessLocal(unit, context);
    };
    await expect(
      generateSemantics({
        analyzeLocal,
        derive: inProcessDerive,
        failFast: true,
        now,
        root,
      })
    ).rejects.toThrow("disk on fire");
    expect(hashTree(first.output)).toEqual(good);
    await expect(
      generateSemantics({
        analyzeLocal: inProcessLocal,
        derive: withoutLastReport,
        failFast: true,
        now,
        root,
      })
    ).rejects.toThrow("@s/c");
    expect(hashTree(first.output)).toEqual(good);
    expect(readdirSync(join(root, ".foundry")).sort()).toEqual([
      "cache",
      "semantics",
    ]);
    rmSync(root, { force: true, recursive: true });
  });

  it("aborts remaining units under --fail-fast", async () => {
    const root = copyFixture();
    const seen: string[] = [];
    const analyzeLocal: SemanticsLocalAnalyzer = (unit) => {
      seen.push(unit.id);
      return Promise.reject(new Error(`no ${unit.id}`));
    };
    await expect(
      generateSemantics({
        analyzeLocal,
        concurrency: 1,
        derive: inProcessDerive,
        failFast: true,
        now,
        root,
      })
    ).rejects.toThrow("no @s/a");
    expect(seen).toEqual(["@s/a"]);
    // the failed build published nothing and left no temporary output
    expect(readdirSync(join(root, ".foundry"))).toEqual([]);
    rmSync(root, { force: true, recursive: true });
  });
});

describe("worker", () => {
  it("produces the same local report and derived report as the in-process seams", async () => {
    const root = copyFixture();
    const unit = {
      analyzable: true,
      declaredDependencies: {},
      id: "@s/b",
      manifestPath: "packages/b/package.json",
      path: "packages/b",
    };
    const spawnedLocal = await spawnLocalAnalyzer(unit, { root });
    const directLocal = analyzePackageLocal({ root, target: "packages/b" });
    expect(spawnedLocal).toEqual(directLocal);

    const spawned = await spawnDeriver([spawnedLocal], { now, root });
    const direct = await analyzeWorkspaceSurfaces({
      now,
      root,
      targets: ["packages/b"],
    });
    expect(spawned.reports.map(stable)).toEqual(direct.reports.map(stable));
    rmSync(root, { force: true, recursive: true });
  });
});
