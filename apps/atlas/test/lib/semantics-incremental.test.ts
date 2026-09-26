import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { assembleSurfaceReport } from "../../src/lib/assemble";
import { analyzePackageLocal } from "../../src/lib/package-local";
import type {
  SemanticsDeriver,
  SemanticsLocalAnalyzer,
} from "../../src/lib/semantics";
import { generateSemantics } from "../../src/lib/semantics";
import { SEMANTICS_CACHE_SCHEMA_VERSION } from "../../src/lib/semantics-cache";
import {
  compareSemanticsDatasets,
  listSemanticsFiles,
} from "../../src/lib/semantics-equivalence";
import type {
  SemanticsGenerationResult,
  SemanticsInvalidation,
  SemanticsManifest,
} from "../../src/lib/semantics-types";
import { deriveWorkspaceSurface } from "../../src/lib/workspace-derive";
import { hashTree } from "./helpers/planning-fixture";

// V12.5/V12.6 incremental materialization on the semantics fixture: apps/a
// imports packages/b, tooling/c stands alone. The fixture is not a Git
// repository, so the history component is constant and every scenario
// exercises sources, manifests, cache state, and the clock. Two cache tiers
// are under test: package-local reports (keyed by a package's own files)
// and assembled reports (keyed by the whole workspace).

const fixture = path.join(import.meta.dirname, "fixtures", "semantics");
const now = new Date("2027-01-01T00:00:00Z");
const tempRoots: string[] = [];

afterAll(() => {
  for (const dir of tempRoots) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

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
    ...(context.profile !== undefined && { profile: context.profile }),
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

function copyFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "semantics-incremental-"));
  fs.cpSync(fixture, dir, { recursive: true });
  const root = fs.realpathSync(dir);
  tempRoots.push(root);
  return root;
}

function write(root: string, file: string, content: string): void {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function append(root: string, file: string, content: string): void {
  fs.appendFileSync(path.join(root, file), content);
}

/** A copy of the current dataset, so a later build can be compared against it. */
function keep(root: string, name: string): string {
  const target = path.join(root, ".foundry", name);
  fs.cpSync(path.join(root, ".foundry", "semantics"), target, {
    recursive: true,
  });
  return target;
}

type BuildOptions = Partial<Parameters<typeof generateSemantics>[0]>;

function build(
  root: string,
  options: BuildOptions = {}
): Promise<SemanticsGenerationResult> {
  return generateSemantics({
    analyzeLocal: inProcessLocal,
    command: "test",
    derive: inProcessDerive,
    now,
    root,
    ...options,
  });
}

const full = (
  root: string,
  options: BuildOptions = {}
): Promise<SemanticsGenerationResult> =>
  build(root, { mode: "full", ...options });
const incremental = (
  root: string,
  options: BuildOptions = {}
): Promise<SemanticsGenerationResult> =>
  build(root, { mode: "incremental", ...options });

function invalidations(
  result: SemanticsGenerationResult,
  kind: SemanticsInvalidation["kind"]
): Map<string, SemanticsInvalidation> {
  return new Map(
    result.invalidations.filter((i) => i.kind === kind).map((i) => [i.id, i])
  );
}

function causesOf(
  result: SemanticsGenerationResult,
  kind: "package-local" | "package-report"
): Record<string, string> {
  return Object.fromEntries(
    [...invalidations(result, kind)].map(([id, i]) => [
      id,
      `${i.status}:${i.reason.type === "direct" ? i.reason.cause : "dependency"}`,
    ])
  );
}

const localCauses = (result: SemanticsGenerationResult) =>
  causesOf(result, "package-local");
const reportCauses = (result: SemanticsGenerationResult) =>
  causesOf(result, "package-report");

function stageStatus(
  result: SemanticsGenerationResult,
  stage: string
): string | undefined {
  return result.invalidations.find(
    (i) => i.kind === "workspace-stage" && i.id === stage
  )?.status;
}

/** Incremental output must equal a clean full build of the same tree. */
async function expectEquivalentToFull(root: string): Promise<void> {
  const incrementalCopy = keep(root, "incremental");
  await full(root);
  const result = compareSemanticsDatasets(
    incrementalCopy,
    path.join(root, ".foundry", "semantics")
  );
  expect(result.differences).toEqual([]);
  expect(result.equivalent).toBe(true);
  expect(result.comparedArtifacts).toBeGreaterThan(10);
  fs.rmSync(incrementalCopy, { force: true, recursive: true });
}

function readManifest(root: string): SemanticsManifest {
  return JSON.parse(
    fs.readFileSync(
      path.join(root, ".foundry", "semantics", "manifest.json"),
      "utf8"
    )
  ) as SemanticsManifest;
}

const cacheDir = (root: string): string =>
  path.join(root, ".foundry", "cache", "semantics");

describe("no changes", () => {
  it("reuses every local and assembled report, skips derivation, and reproduces the full dataset", async () => {
    const root = copyFixture();
    const first = await full(root);
    expect(first.mode).toBe("full");
    expect(first.packages.analyzed).toBe(3);
    expect(first.reports.derived).toBe(3);
    expect(localCauses(first)).toEqual({
      "@s/a": "recompute:full-rebuild",
      "@s/b": "recompute:full-rebuild",
      "@s/c": "recompute:full-rebuild",
    });
    const before = keep(root, "first");
    const inodes = new Map(
      listSemanticsFiles(first.output).map((f) => [
        f,
        fs.statSync(path.join(first.output, f)).ino,
      ])
    );

    const seen: string[] = [];
    let derived = 0;
    const second = await incremental(root, {
      analyzeLocal: (unit, context) => {
        seen.push(unit.id);
        return inProcessLocal(unit, context);
      },
      derive: (locals, context) => {
        derived += 1;
        return inProcessDerive(locals, context);
      },
    });
    expect(seen).toEqual([]);
    expect(derived).toBe(0);
    expect(second.mode).toBe("incremental");
    expect(second.packages).toMatchObject({
      analyzed: 0,
      reused: 3,
      unchanged: 0,
    });
    expect(second.reports).toEqual({ derived: 0, reused: 3, unchanged: 0 });
    expect(localCauses(second)).toEqual({
      "@s/a": "reuse:fingerprint-unchanged",
      "@s/b": "reuse:fingerprint-unchanged",
      "@s/c": "reuse:fingerprint-unchanged",
    });
    expect(reportCauses(second)).toEqual({
      "@s/a": "reuse:fingerprint-unchanged",
      "@s/b": "reuse:fingerprint-unchanged",
      "@s/c": "reuse:fingerprint-unchanged",
    });
    const stages = second.invalidations.filter(
      (i) => i.kind === "workspace-stage"
    );
    expect(stages.map((s) => [s.id, s.status])).toEqual([
      ["workspaceDerivation", "reuse"],
      ["workspaceIngestion", "recompute"],
      ["workspaceIntelligence", "recompute"],
      ["workspaceProjection", "recompute"],
      ["materialization", "recompute"],
    ]);
    expect(stages[1]?.reason).toEqual({ source: [], type: "dependency" });

    const comparison = compareSemanticsDatasets(before, second.output);
    expect(comparison.differences).toEqual([]);
    expect(comparison.equivalent).toBe(true);
    // every artifact but the manifest is byte-identical and keeps its inode
    expect(second.artifacts.generated).toBe(1);
    expect(second.artifacts.reused).toBe(second.files - 1);
    expect(second.artifacts.removed).toBe(0);
    for (const [file, ino] of inodes) {
      if (file === "manifest.json") {
        continue;
      }
      expect(fs.statSync(path.join(second.output, file)).ino).toBe(ino);
    }
    const manifest = readManifest(root);
    expect(manifest.generation.mode).toBe("incremental");
    expect(manifest.generation.packagesReused).toBe(3);
    expect(manifest.generation.packagesAnalyzed).toBe(0);
    expect(manifest.generation.derived).toBe(false);
    expect(manifest.generation.artifactsReused).toBe(second.files - 1);
    expect(second.phases.map((p) => p.name)).toContain("derive");
  });

  it("does not grow the cache across repeated builds", async () => {
    const root = copyFixture();
    await full(root);
    const first = hashTree(cacheDir(root));
    await incremental(root);
    await incremental(root);
    const after = hashTree(cacheDir(root));
    expect([...after.keys()].sort()).toEqual([...first.keys()].sort());
    expect(fs.existsSync(path.join(cacheDir(root), "lock.json"))).toBe(false);
  });

  it("stores one local and one assembled entry per package", async () => {
    const root = copyFixture();
    const result = await full(root);
    const files = fs.readdirSync(path.join(cacheDir(root), "packages")).sort();
    expect(files).toEqual([
      "@s__a.json",
      "@s__a.local.json",
      "@s__a.local.meta.json",
      "@s__a.meta.json",
      "@s__b.json",
      "@s__b.local.json",
      "@s__b.local.meta.json",
      "@s__b.meta.json",
      "@s__c.json",
      "@s__c.local.json",
      "@s__c.local.meta.json",
      "@s__c.meta.json",
    ]);
    expect(result.cache).toMatchObject({ localEntries: 3, packageEntries: 3 });
    expect(result.cache.localBytes).toBeLessThan(result.cache.bytes);
  });
});

describe("source changes", () => {
  it("re-analyzes only the edited package locally and derives the workspace once", async () => {
    const root = copyFixture();
    await full(root);
    append(root, "tooling/c/src/pad.ts", "\nexport const padded = 1;\n");
    const result = await incremental(root);
    expect(result.packages).toMatchObject({ analyzed: 1, reused: 2 });
    expect(result.reports.derived).toBe(3);
    expect(invalidations(result, "package-local").get("@s/c")?.reason).toEqual({
      cause: "sources-changed",
      changed: ["tooling/c/src/pad.ts"],
      type: "direct",
    });
    expect(localCauses(result)).toEqual({
      "@s/a": "reuse:fingerprint-unchanged",
      "@s/b": "reuse:fingerprint-unchanged",
      "@s/c": "recompute:sources-changed",
    });
    // derivation reads the whole workspace, so every assembled report moves
    expect(reportCauses(result)).toEqual({
      "@s/a": "recompute:sources-changed",
      "@s/b": "recompute:sources-changed",
      "@s/c": "recompute:sources-changed",
    });
    expect(stageStatus(result, "workspaceDerivation")).toBe("recompute");
    await expectEquivalentToFull(root);
  });

  it("keeps a consumer's local report when its provider changes", async () => {
    const root = copyFixture();
    await full(root);
    // apps/a imports Shape from packages/b; b changes, a's own facts do not
    append(
      root,
      "packages/b/src/shape.ts",
      "\nexport interface Corner {\n  x: number;\n}\n"
    );
    const result = await incremental(root);
    expect(localCauses(result)).toEqual({
      "@s/a": "reuse:fingerprint-unchanged",
      "@s/b": "recompute:sources-changed",
      "@s/c": "reuse:fingerprint-unchanged",
    });
    expect(result.packages).toMatchObject({ analyzed: 1, reused: 2 });
    await expectEquivalentToFull(root);
  });

  it("re-analyzes the consumer, not the provider, when an import is added", async () => {
    const root = copyFixture();
    const first = await full(root);
    const consumersOf = (output: string): string[] =>
      (
        JSON.parse(
          fs.readFileSync(path.join(output, "packages", "@s__b.json"), "utf8")
        ) as { symbols: { name: string; consumerPackages: string[] }[] }
      ).symbols.find((s) => s.name === "area")?.consumerPackages ?? [];
    expect(consumersOf(first.output)).toEqual(["@s/a"]);
    append(
      root,
      "tooling/c/src/unit.ts",
      '\nimport { area } from "@s/b";\nexport const covered = area({ width: 1, height: 1 });\n'
    );
    const result = await incremental(root);
    expect(localCauses(result)).toEqual({
      "@s/a": "reuse:fingerprint-unchanged",
      "@s/b": "reuse:fingerprint-unchanged",
      "@s/c": "recompute:sources-changed",
    });
    // b's derived facts move: one more consumer of its public surface
    expect(consumersOf(result.output)).toEqual(["@s/a", "@s/c"]);
    await expectEquivalentToFull(root);
  });

  it("recognizes a comment-only edit as analyzed but unchanged and reuses the artifacts", async () => {
    const root = copyFixture();
    await full(root);
    const before = keep(root, "before");
    append(
      root,
      "packages/b/src/shape.ts",
      "\n// a comment changes the hash, not the semantics\n"
    );
    const result = await incremental(root);
    expect(result.packages).toMatchObject({
      analyzed: 1,
      reused: 2,
      unchanged: 1,
    });
    expect(result.reports).toEqual({ derived: 3, reused: 0, unchanged: 3 });
    const comparison = compareSemanticsDatasets(before, result.output);
    expect(comparison.differences).toEqual([]);
    // reports keep their cached bytes, so only the manifest is rewritten
    expect(result.artifacts.generated).toBe(1);
    await expectEquivalentToFull(root);
  });

  it("treats a manifest change as a local source change of that package", async () => {
    const root = copyFixture();
    await full(root);
    const manifest = path.join(root, "packages/b/package.json");
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as Record<
      string,
      unknown
    >;
    fs.writeFileSync(
      manifest,
      JSON.stringify({ ...parsed, description: "changed" })
    );
    const result = await incremental(root);
    expect(result.packages).toMatchObject({ analyzed: 1, reused: 2 });
    expect(
      invalidations(result, "package-local").get("@s/b")?.reason
    ).toMatchObject({
      cause: "sources-changed",
      changed: ["packages/b/package.json"],
    });
    await expectEquivalentToFull(root);
  });

  it("ignores files the analyzer never reads", async () => {
    const root = copyFixture();
    await full(root);
    write(root, "README.md", "# changed\n");
    write(root, "packages/b/README.md", "# b\n");
    write(root, ".prettierrc", "{}\n");
    write(root, "packages/b/src/styles.css", "body {}\n");
    write(root, "examples/explorer/app.js", "export const app = 1;\n");
    const result = await incremental(root);
    expect(result.packages).toMatchObject({ analyzed: 0, reused: 3 });
    expect(result.reports).toEqual({ derived: 0, reused: 3, unchanged: 0 });
  });

  it("re-derives without any local analysis when the analysis clock moves", async () => {
    const root = copyFixture();
    await full(root);
    const result = await incremental(root, {
      now: new Date("2027-01-02T00:00:00Z"),
    });
    expect(result.packages).toMatchObject({ analyzed: 0, reused: 3 });
    expect(localCauses(result)["@s/a"]).toBe("reuse:fingerprint-unchanged");
    expect(reportCauses(result)["@s/a"]).toBe("recompute:clock-changed");
    expect(result.reports.derived).toBe(3);
  });

  it("re-derives without any local analysis when the semantics config changes", async () => {
    const root = copyFixture();
    await full(root);
    write(
      root,
      "foundry.config.json",
      JSON.stringify({ semantics: { exclude: ["packages/docs-only"] } })
    );
    const result = await incremental(root);
    expect(localCauses(result)["@s/c"]).toBe("reuse:fingerprint-unchanged");
    expect(reportCauses(result)["@s/c"]).toBe("recompute:config-changed");
  });
});

describe("discovery changes", () => {
  it("analyzes an added package locally and rebuilds the workspace around it", async () => {
    const root = copyFixture();
    await full(root);
    write(
      root,
      "packages/d/package.json",
      JSON.stringify({ exports: { ".": "./src/index.ts" }, name: "@s/d" })
    );
    write(
      root,
      "packages/d/src/index.ts",
      "export interface Delta {\n  amount: number;\n}\n"
    );
    const result = await incremental(root);
    expect(localCauses(result)).toEqual({
      "@s/a": "reuse:fingerprint-unchanged",
      "@s/b": "reuse:fingerprint-unchanged",
      "@s/c": "reuse:fingerprint-unchanged",
      "@s/d": "recompute:package-added",
    });
    expect(reportCauses(result)).toEqual({
      "@s/a": "recompute:sources-changed",
      "@s/b": "recompute:sources-changed",
      "@s/c": "recompute:sources-changed",
      "@s/d": "recompute:package-added",
    });
    expect(readManifest(root).packages.map((p) => p.id)).toEqual([
      "@s/a",
      "@s/b",
      "@s/c",
      "@s/d",
    ]);
    await expectEquivalentToFull(root);
  });

  it("drops a removed package from the dataset and both cache tiers", async () => {
    const root = copyFixture();
    await full(root);
    expect(
      fs.existsSync(path.join(cacheDir(root), "packages", "@s__c.meta.json"))
    ).toBe(true);
    fs.rmSync(path.join(root, "tooling/c"), { recursive: true });
    const result = await incremental(root);
    const removed = result.invalidations.find((i) => i.status === "remove");
    expect(removed).toEqual({
      id: "@s/c",
      kind: "package-report",
      reason: { cause: "package-removed", type: "direct" },
      status: "remove",
    });
    expect(result.artifacts.removed).toBeGreaterThan(0);
    for (const file of [
      "@s__c.meta.json",
      "@s__c.local.meta.json",
      "@s__c.local.json",
    ]) {
      expect(fs.existsSync(path.join(cacheDir(root), "packages", file))).toBe(
        false
      );
    }
    expect(
      fs.existsSync(path.join(result.output, "packages", "@s__c.json"))
    ).toBe(false);
    expect(readManifest(root).packages.map((p) => p.id)).toEqual([
      "@s/a",
      "@s/b",
    ]);
    await expectEquivalentToFull(root);
  });
});

describe("cache state", () => {
  it("recomputes only a corrupt local entry", async () => {
    const root = copyFixture();
    await full(root);
    fs.writeFileSync(
      path.join(cacheDir(root), "packages", "@s__b.local.json"),
      "{ not json"
    );
    const result = await incremental(root);
    expect(localCauses(result)).toEqual({
      "@s/a": "reuse:fingerprint-unchanged",
      "@s/b": "recompute:cache-corrupt",
      "@s/c": "reuse:fingerprint-unchanged",
    });
    // the assembled reports are still valid; derivation is not needed
    expect(result.reports).toEqual({ derived: 0, reused: 3, unchanged: 0 });
    await expectEquivalentToFull(root);
  });

  it("re-derives when an assembled entry is corrupt, without local analysis", async () => {
    const root = copyFixture();
    await full(root);
    fs.writeFileSync(
      path.join(cacheDir(root), "packages", "@s__b.json"),
      "{ not json"
    );
    const result = await incremental(root);
    expect(result.packages).toMatchObject({ analyzed: 0, reused: 3 });
    expect(reportCauses(result)).toEqual({
      "@s/a": "reuse:fingerprint-unchanged",
      "@s/b": "recompute:cache-corrupt",
      "@s/c": "reuse:fingerprint-unchanged",
    });
    expect(result.reports).toEqual({ derived: 3, reused: 0, unchanged: 2 });
    await expectEquivalentToFull(root);
  });

  it("recomputes a missing local entry", async () => {
    const root = copyFixture();
    await full(root);
    fs.rmSync(path.join(cacheDir(root), "packages", "@s__b.local.meta.json"));
    const result = await incremental(root);
    expect(localCauses(result)["@s/b"]).toBe("recompute:cache-missing");
    expect(localCauses(result)["@s/a"]).toBe("reuse:fingerprint-unchanged");
  });

  it("rejects an entry written under another cache schema", async () => {
    const root = copyFixture();
    await full(root);
    const meta = path.join(cacheDir(root), "packages", "@s__b.local.meta.json");
    const parsed = JSON.parse(fs.readFileSync(meta, "utf8")) as Record<
      string,
      unknown
    >;
    expect(parsed.cacheSchemaVersion).toBe(SEMANTICS_CACHE_SCHEMA_VERSION);
    fs.writeFileSync(
      meta,
      JSON.stringify({ ...parsed, cacheSchemaVersion: 0 })
    );
    const result = await incremental(root);
    expect(localCauses(result)["@s/b"]).toBe("recompute:cache-schema-changed");
    // the refreshed entry carries the current cache schema, so it hits again
    const again = await incremental(root);
    expect(localCauses(again)["@s/b"]).toBe("reuse:fingerprint-unchanged");
  });

  it("never reads a V12.5 full-report entry as a local report", async () => {
    const root = copyFixture();
    const first = await full(root);
    const report = fs.readFileSync(
      path.join(first.output, "packages", "@s__b.json"),
      "utf8"
    );
    const packages = path.join(cacheDir(root), "packages");
    // a schema-1 entry: the assembled report under the bare name, no `kind`
    fs.writeFileSync(path.join(packages, "@s__b.local.json"), report);
    const meta = JSON.parse(
      fs.readFileSync(path.join(packages, "@s__b.local.meta.json"), "utf8")
    ) as Record<string, unknown>;
    const { kind: _kind, ...legacy } = meta;
    fs.writeFileSync(
      path.join(packages, "@s__b.local.meta.json"),
      JSON.stringify({ ...legacy, cacheSchemaVersion: 1 })
    );
    const result = await incremental(root);
    expect(localCauses(result)["@s/b"]).toBe("recompute:cache-corrupt");
    await expectEquivalentToFull(root);
  });

  it("falls back to analyzing everything without a cache", async () => {
    const root = copyFixture();
    await full(root);
    const before = keep(root, "before");
    fs.rmSync(cacheDir(root), { recursive: true });
    const result = await incremental(root);
    expect(result.packages).toMatchObject({ analyzed: 3, reused: 0 });
    expect(localCauses(result)["@s/a"]).toBe("recompute:cache-missing");
    expect(compareSemanticsDatasets(before, result.output).equivalent).toBe(
      true
    );
  });

  it("produces the same full dataset under a valid, empty, or corrupt cache", async () => {
    const root = copyFixture();
    await full(root);
    const valid = keep(root, "valid");
    fs.writeFileSync(
      path.join(cacheDir(root), "packages", "@s__a.local.json"),
      "garbage"
    );
    await full(root);
    const corrupt = keep(root, "corrupt");
    fs.rmSync(cacheDir(root), { recursive: true });
    await full(root);
    expect(compareSemanticsDatasets(valid, corrupt).equivalent).toBe(true);
    expect(
      compareSemanticsDatasets(valid, path.join(root, ".foundry", "semantics"))
        .equivalent
    ).toBe(true);
  });

  it("refuses to run while another live process holds the cache lock", async () => {
    const root = copyFixture();
    await full(root);
    const lock = path.join(cacheDir(root), "lock.json");
    fs.writeFileSync(
      lock,
      JSON.stringify({
        pid: process.pid + 1_000_000,
        startedAt: "2027-01-01T00:00:00Z",
      })
    );
    // a pid that cannot exist counts as a dead holder: the lock is taken over
    await expect(incremental(root)).resolves.toMatchObject({
      packages: { reused: 3 },
    });
    fs.writeFileSync(
      lock,
      JSON.stringify({ pid: process.ppid, startedAt: "2027-01-01T00:00:00Z" })
    );
    await expect(incremental(root)).rejects.toThrow("is locked by process");
    fs.rmSync(lock);
  });
});

describe("failures", () => {
  it("keeps the previous dataset when an incremental build fails", async () => {
    const root = copyFixture();
    const first = await full(root);
    const good = hashTree(first.output);
    append(root, "packages/b/src/shape.ts", "\nexport const extra = 1;\n");
    const analyzeLocal: SemanticsLocalAnalyzer = (unit, context) =>
      unit.id === "@s/b"
        ? Promise.reject(new Error("disk on fire"))
        : inProcessLocal(unit, context);
    await expect(
      incremental(root, { analyzeLocal, failFast: true })
    ).rejects.toThrow("disk on fire");
    expect(hashTree(first.output)).toEqual(good);
    // the failed build recorded no inputs, so the next plan still names the edit
    const plan = await incremental(root, { dryRun: true });
    expect(invalidations(plan, "package-local").get("@s/b")?.reason).toEqual({
      cause: "sources-changed",
      changed: ["packages/b/src/shape.ts"],
      type: "direct",
    });
  });

  it("keeps the previous dataset when derivation fails", async () => {
    const root = copyFixture();
    const first = await full(root);
    const good = hashTree(first.output);
    append(root, "packages/b/src/shape.ts", "\nexport const extra = 1;\n");
    await expect(
      incremental(root, {
        derive: () => Promise.reject(new Error("program exploded")),
      })
    ).rejects.toThrow("program exploded");
    expect(hashTree(first.output)).toEqual(good);
    expect(fs.existsSync(`${first.output}.tmp-${process.pid}`)).toBe(false);
  });

  it("never substitutes a stale cached local report for a failed analysis", async () => {
    const root = copyFixture();
    await full(root);
    append(root, "packages/b/src/shape.ts", "\nexport const extra = 1;\n");
    const analyzeLocal: SemanticsLocalAnalyzer = (unit, context) =>
      unit.id === "@s/b"
        ? Promise.reject(new Error("boom"))
        : inProcessLocal(unit, context);
    const result = await incremental(root, { analyzeLocal });
    expect(result.packages).toMatchObject({
      analyzed: 0,
      failed: 1,
      reused: 2,
    });
    const manifest = readManifest(root);
    expect(manifest.packages.find((p) => p.id === "@s/b")?.status).toBe(
      "failed"
    );
    expect(
      fs.existsSync(path.join(result.output, "packages", "@s__b.json"))
    ).toBe(false);
    // the stale entry stays on disk but can never match the new fingerprint
    const meta = JSON.parse(
      fs.readFileSync(
        path.join(cacheDir(root), "packages", "@s__b.local.meta.json"),
        "utf8"
      )
    ) as { fingerprint: string };
    const b = invalidations(result, "package-local").get("@s/b");
    expect(meta.fingerprint).not.toBe(b?.fingerprint);
  });
});

describe("dry run", () => {
  it("reports the plan without analyzing, deriving, or writing", async () => {
    const root = copyFixture();
    const first = await full(root);
    const dataset = hashTree(first.output);
    const cache = hashTree(cacheDir(root));
    append(root, "tooling/c/src/pad.ts", "\nexport const padded = 1;\n");
    const seen: string[] = [];
    const result = await incremental(root, {
      analyzeLocal: (unit) => {
        seen.push(unit.id);
        return Promise.reject(new Error("must not run"));
      },
      derive: () => Promise.reject(new Error("must not run")),
      dryRun: true,
    });
    expect(seen).toEqual([]);
    expect(result.dryRun).toBe(true);
    expect(result.packages).toMatchObject({ analyzed: 1, reused: 2 });
    expect(result.reports).toEqual({ derived: 3, reused: 0, unchanged: 0 });
    expect(result.phases.map((p) => p.name)).toEqual([
      "discover",
      "fingerprint",
    ]);
    expect(hashTree(first.output)).toEqual(dataset);
    expect(hashTree(cacheDir(root))).toEqual(cache);
  });
});

describe("determinism", () => {
  it("yields the same invalidation graph and dataset under any worker count", async () => {
    const root = copyFixture();
    await full(root);
    const pristine = path.join(root, ".foundry", "cache-pristine");
    fs.cpSync(cacheDir(root), pristine, { recursive: true });
    append(root, "apps/a/src/index.ts", "\nexport const more = 2;\n");
    const graphs: unknown[] = [];
    const datasets: string[] = [];
    for (const concurrency of [1, 2, 4]) {
      // every run starts from the pre-change cache, so only the worker count differs
      fs.rmSync(cacheDir(root), { recursive: true });
      fs.cpSync(pristine, cacheDir(root), { recursive: true });
      const result = await incremental(root, { concurrency });
      expect(result.packages).toMatchObject({ analyzed: 1, reused: 2 });
      graphs.push(result.invalidations);
      datasets.push(keep(root, `c${concurrency}`));
    }
    expect(graphs[1]).toEqual(graphs[0]);
    expect(graphs[2]).toEqual(graphs[0]);
    for (const dataset of datasets.slice(1)) {
      expect(
        compareSemanticsDatasets(datasets[0] ?? "", dataset).differences
      ).toEqual([]);
    }
  });

  it("walks a sequence of edits with incremental equal to full at every step", async () => {
    const root = copyFixture();
    await full(root);
    const steps: (() => void)[] = [
      () => {
        append(root, "apps/a/src/index.ts", "\nexport const step = 1;\n");
      },
      () => {
        write(root, "packages/b/src/extra.ts", "export const extra = 1;\n");
      },
      () => {
        fs.rmSync(path.join(root, "packages/b/src/extra.ts"));
      },
      () => {
        write(
          root,
          "packages/b/package.json",
          JSON.stringify({
            exports: { ".": "./src/index.ts" },
            name: "@s/b",
            private: true,
          })
        );
      },
      () => {
        append(
          root,
          "tooling/c/src/unit.ts",
          '\nimport type { Shape } from "@s/b";\nexport const box: Shape = { width: 2, height: 2 };\n'
        );
      },
      () => {
        write(
          root,
          "packages/e/package.json",
          JSON.stringify({ exports: { ".": "./src/index.ts" }, name: "@s/e" })
        );
      },
      () => {
        write(root, "packages/e/src/index.ts", "export const e = 1;\n");
      },
      () => {
        fs.rmSync(path.join(root, "packages/e"), { recursive: true });
      },
    ];
    for (const step of steps) {
      step();
      await incremental(root);
      await expectEquivalentToFull(root);
    }
  });
});
