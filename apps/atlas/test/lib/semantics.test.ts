import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assembleSurfaceReport } from "../../src/lib/assemble";
import { analyzePackageLocal } from "../../src/lib/package-local";
import type {
  SemanticsDeriver,
  SemanticsLocalAnalyzer,
} from "../../src/lib/semantics";
import {
  decodePackageFile,
  encodePackageFile,
  generateSemantics,
  spawnDeriver,
  spawnLocalAnalyzer,
} from "../../src/lib/semantics";
import {
  DEFAULT_SEMANTICS_CONFIG,
  discoverSemanticsUnits,
  loadSemanticsConfig,
} from "../../src/lib/semantics-discover";
import type {
  SemanticsConceptIndex,
  SemanticsCouplingIndex,
  SemanticsManifest,
  SemanticsModuleEdgeShard,
  SemanticsModuleIndex,
  SemanticsModuleShard,
} from "../../src/lib/semantics-types";
import { SEMANTICS_DATASET_SCHEMA_VERSION } from "../../src/lib/semantics-types";
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
import { hashTree } from "./helpers/planning-fixture";

const fixture = path.join(import.meta.dirname, "fixtures", "semantics");
const now = new Date("2027-01-01T00:00:00Z");

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

function copyFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "semantics-"));
  fs.cpSync(fixture, dir, { recursive: true });
  return fs.realpathSync(dir);
}

function readJson(dir: string, file: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
}

function readManifest(dir: string): SemanticsManifest {
  return readJson(dir, "manifest.json") as SemanticsManifest;
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
  it("finds one unit per configured root and records every skip", () => {
    const discovery = discoverSemanticsUnits(fixture, DEFAULT_SEMANTICS_CONFIG);
    expect(discovery.units.map((u) => [u.id, u.root, u.path])).toEqual([
      ["@s/a", "apps", "apps/a"],
      ["@s/b", "packages", "packages/b"],
      ["@s/c", "tooling", "tooling/c"],
    ]);
    expect(discovery.units.every((u) => u.analyzable)).toBe(true);
    expect(discovery.units[0]?.manifestPath).toBe("apps/a/package.json");
    expect(discovery.rootsScanned).toEqual(["apps", "packages", "tooling"]);
    expect(discovery.rootsMissing).toEqual(["plugins"]);
    expect(discovery.directoriesInspected).toBe(6);
    expect(discovery.skipped).toEqual([
      { path: "packages/dist", reason: "generated output" },
      { path: "packages/docs-only", reason: "analysis unsupported" },
      { path: "packages/loose", reason: "no package manifest" },
    ]);
  });

  it("respects custom roots, exclusions, and missing roots", () => {
    const discovery = discoverSemanticsUnits(fixture, {
      ...DEFAULT_SEMANTICS_CONFIG,
      exclude: ["libraries/lib"],
      roots: ["services", "libraries", "vendor"],
    });
    expect(discovery.units.map((u) => u.id)).toEqual(["@s/svc"]);
    expect(discovery.rootsScanned).toEqual(["libraries", "services"]);
    expect(discovery.rootsMissing).toEqual(["vendor"]);
    expect(discovery.skipped).toEqual([
      { path: "libraries/lib", reason: "excluded" },
    ]);
  });

  it("reads foundry.config.json#semantics and defaults without it", () => {
    expect(loadSemanticsConfig(fixture)).toEqual(DEFAULT_SEMANTICS_CONFIG);
    const dir = copyFixture();
    fs.writeFileSync(
      path.join(dir, "foundry.config.json"),
      JSON.stringify({ semantics: { roots: ["services"] } })
    );
    expect(loadSemanticsConfig(dir)).toEqual({
      ...DEFAULT_SEMANTICS_CONFIG,
      roots: ["services"],
    });
    fs.rmSync(dir, { force: true, recursive: true });
  });

  it("encodes scoped package names reversibly", () => {
    expect(encodePackageFile("@foundry/db")).toBe("@foundry__db");
    expect(decodePackageFile("@foundry__db")).toBe("@foundry/db");
    expect(encodePackageFile("plain")).toBe("plain");
  });
});

describe("generation", () => {
  let root: string;
  let before: Map<string, string>;
  let manifest: SemanticsManifest;
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
    reports = (
      await analyzeWorkspaceSurfaces({
        now,
        root,
        targets: ["apps/a", "packages/b", "tooling/c"],
        tsconfig: "tsconfig.json",
      })
    ).reports;
    workspace = analyzeWorkspace(
      ingestWorkspaceReports(reports, { root: "semantics-root" })
    );
  });

  afterAll(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  it("writes the dataset under .foundry/semantics with a complete manifest", () => {
    expect(dataset).toBe(path.join(root, ".foundry", "semantics"));
    expect(manifest.schemaVersion).toBe(SEMANTICS_DATASET_SCHEMA_VERSION);
    expect(manifest.coverage).toBe("complete");
    expect(manifest.workspace).toEqual({
      name: "semantics-root",
      root: path.basename(root),
    });
    expect(manifest.roots).toEqual(["apps", "packages", "plugins", "tooling"]);
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
    expect(manifest.discovery.unitsDiscovered).toBe(3);
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
    ]);
    expect(manifest.generation.partial).toBe(false);
    expect(manifest.generation.command).toBe("test");
  });

  it("references only relative files that exist", () => {
    const urls: string[] = [
      manifest.files.workspace,
      manifest.files.moduleIndex,
      manifest.files.conceptIndex,
      manifest.files.couplings,
      ...Object.values(manifest.files.projections),
    ];
    for (const pkg of manifest.packages) {
      if (pkg.report !== undefined) {
        urls.push(pkg.report);
      }
      if (pkg.projection !== undefined) {
        urls.push(pkg.projection);
      }
      if (pkg.modules.shard !== undefined) {
        urls.push(pkg.modules.shard);
      }
    }
    const index = readJson(
      dataset,
      manifest.files.moduleIndex
    ) as SemanticsModuleIndex;
    urls.push(
      ...index.shards.map((s) => s.file),
      ...index.edgeShards.map((s) => s.file),
      ...index.modules.map((m) => m.shard)
    );
    expect(urls.length).toBeGreaterThan(10);
    for (const url of urls) {
      expect(path.isAbsolute(url)).toBe(false);
      expect(url.startsWith("..")).toBe(false);
      expect(fs.existsSync(path.join(dataset, url))).toBe(true);
    }
    const referenced = new Set([...urls, "manifest.json"]);
    expect(listFiles(dataset).filter((f) => !referenced.has(f))).toEqual([]);
    const text = fs.readFileSync(path.join(dataset, "manifest.json"), "utf8");
    expect(text).not.toContain(root);
    expect(text).not.toContain(os.tmpdir());
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
    expect(record?.history).toBeUndefined();
    expect(record?.cautions).toEqual(["history-unavailable"]);
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

  it("materializes co-change pairs with the canonical raw values", () => {
    const written = readJson(
      dataset,
      manifest.files.couplings
    ) as SemanticsCouplingIndex;
    expect(written.schemaVersion).toBe(SEMANTICS_DATASET_SCHEMA_VERSION);
    expect(written.couplings.map((c) => c.id)).toEqual(
      workspace.evolution.couplings.map((c) => c.id)
    );
    for (const pair of written.couplings) {
      const canonical = workspace.evolution.couplings.find(
        (c) => c.id === pair.id
      );
      expect(pair).toEqual({
        coChangeCommits: canonical?.coChangeCommits,
        id: canonical?.id,
        jaccard: canonical?.jaccard,
        left: canonical?.left,
        leftCommits: canonical?.leftCommits,
        leftConditional: canonical?.leftConditional,
        leftPackage: canonical?.leftPackage,
        right: canonical?.right,
        rightCommits: canonical?.rightCommits,
        rightConditional: canonical?.rightConditional,
        rightPackage: canonical?.rightPackage,
        scope: canonical?.scope,
        ...(canonical?.lastCoChangedAt !== undefined && {
          lastCoChangedAt: canonical.lastCoChangedAt,
        }),
      });
    }
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
          f.startsWith(path.join(".foundry", "semantics") + path.sep) ||
          f.startsWith(path.join(".foundry", "cache", "semantics") + path.sep)
      )
    ).toBe(true);
    expect(fs.readdirSync(path.join(root, ".foundry")).sort()).toEqual([
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
    fs.rmSync(path.join(root, "tooling", "c"), { recursive: true });
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
    expect(fs.existsSync(path.join(result.output, "packages/@s__c.json"))).toBe(
      false
    );
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
    fs.rmSync(root, { force: true, recursive: true });
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
    expect(fs.readdirSync(path.join(root, ".foundry")).sort()).toEqual([
      "cache",
      "semantics",
    ]);
    fs.rmSync(root, { force: true, recursive: true });
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
    expect(fs.existsSync(path.join(root, ".foundry"))).toBe(true);
    // the failed build published nothing; only the disposable cache remains
    expect(fs.readdirSync(path.join(root, ".foundry"))).toEqual(["cache"]);
    fs.rmSync(root, { force: true, recursive: true });
  });
});

describe("worker", () => {
  it("produces the same local report and derived report as the in-process seams", async () => {
    const root = copyFixture();
    const unit = {
      analyzable: true,
      id: "@s/b",
      manifestPath: "packages/b/package.json",
      name: "@s/b",
      path: "packages/b",
      root: "packages",
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
    fs.rmSync(root, { force: true, recursive: true });
  });
});
