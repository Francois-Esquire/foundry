import { execFileSync } from "node:child_process";
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
import { generateSemantics } from "../../src/lib/semantics";
import { SEMANTICS_CACHE_SCHEMA_VERSION } from "../../src/lib/semantics-cache";
import { DEFAULT_SEMANTICS_CONFIG } from "../../src/lib/semantics-discover";
import { compareSemanticsDatasets } from "../../src/lib/semantics-equivalence";
import {
  generateSemanticsHistory,
  historyFingerprint,
} from "../../src/lib/semantics-history";
import {
  buildLineage,
  parseStatusLog,
  parseTimelineLog,
  rangeStart,
  selectCheckpoints,
} from "../../src/lib/semantics-history-timeline";
import type {
  SemanticsHistoryCommit,
  SemanticsHistoryEntities,
  SemanticsHistoryManifest,
  SemanticsHistoryTimeline,
  TemporalSnapshotDelta,
  TemporalWorkspaceSnapshot,
} from "../../src/lib/semantics-history-types";
import { SEMANTICS_HISTORY_SCHEMA_VERSION } from "../../src/lib/semantics-history-types";
import { stageClosure } from "../../src/lib/semantics-stages";
import { deriveWorkspaceSurface } from "../../src/lib/workspace-derive";
import { hashTree } from "./helpers/planning-fixture";

const fixture = path.join(import.meta.dirname, "fixtures", "semantics");

function git(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", args, {
    cwd: dir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "ignore"],
  }).toString();
}

function write(dir: string, file: string, content: string): void {
  const target = path.join(dir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function commit(dir: string, date: string): string {
  git(dir, ["add", "-A"]);
  git(
    dir,
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "-qm",
      "fixture",
    ],
    { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
  );
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

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

const inProcess = { analyzeLocal: inProcessLocal, derive: inProcessDerive };

/**
 * Four monthly commits: the semantics fixture, a new module and dependency,
 * a rename plus a cross-package move, then a package born and one removed.
 */
function buildRepository(): { dir: string; commits: string[] } {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "semantics-history-fixture-"))
  );
  fs.cpSync(fixture, dir, { recursive: true });
  write(dir, ".gitignore", ".foundry/\n");
  git(dir, ["init", "-q", "-b", "main"]);
  const commits: string[] = [];
  commits.push(commit(dir, "2026-01-15T12:00:00Z"));

  write(
    dir,
    "packages/b/src/scale.ts",
    'import type { Shape } from "./shape";\n\nexport function scale(shape: Shape, k: number): Shape {\n  return { width: shape.width * k, height: shape.height * k };\n}\n'
  );
  write(
    dir,
    "packages/b/src/index.ts",
    'export type { Shape } from "./shape";\nexport { area, perimeter } from "./shape";\nexport { scale } from "./scale";\n'
  );
  commits.push(commit(dir, "2026-02-15T12:00:00Z"));

  git(dir, ["mv", "tooling/c/src/pad.ts", "tooling/c/src/padding.ts"]);
  write(
    dir,
    "tooling/c/src/index.ts",
    'import type { Shape } from "@s/b";\n\nimport { perimeter } from "@s/b";\n\nimport type { Unit } from "./unit";\n\nimport { pad } from "./padding";\n\nexport function fence(shape: Shape): number {\n  const unit: Unit = "px";\n  return perimeter(shape) + pad(unit);\n}\n'
  );
  git(dir, ["mv", "packages/b/src/scale.ts", "apps/a/src/scale.ts"]);
  write(
    dir,
    "apps/a/src/scale.ts",
    'import type { Shape } from "@s/b";\n\nexport function scale(shape: Shape, k: number): Shape {\n  return { width: shape.width * k, height: shape.height * k };\n}\n'
  );
  write(
    dir,
    "packages/b/src/index.ts",
    'export type { Shape } from "./shape";\nexport { area, perimeter } from "./shape";\n'
  );
  write(
    dir,
    "apps/a/src/index.ts",
    'import type { Shape } from "@s/b";\n\nimport { area } from "@s/b";\n\nimport { scale } from "./scale";\n\nexport interface Tile extends Shape {\n  label: string;\n}\n\nexport function describe(tile: Tile): string {\n  return `${tile.label}: ${String(area(scale(tile, 2)))}`;\n}\n'
  );
  commits.push(commit(dir, "2026-03-15T12:00:00Z"));

  write(
    dir,
    "packages/d/package.json",
    '{\n  "name": "@s/d",\n  "private": true,\n  "dependencies": { "@s/b": "workspace:*" }\n}\n'
  );
  write(
    dir,
    "packages/d/src/index.ts",
    'import type { Shape } from "@s/b";\n\nimport { area } from "@s/b";\n\nexport function halve(shape: Shape): number {\n  return area(shape) / 2;\n}\n'
  );
  git(dir, ["rm", "-rq", "tooling/c"]);
  commits.push(commit(dir, "2026-04-15T12:00:00Z"));
  return { commits, dir };
}

function readJson(dir: string, file: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
}

/** Dependency edges of a snapshot as `[sourceId, targetId]`. */
function edgesOf(snapshot: TemporalWorkspaceSnapshot): [string, string][] {
  return snapshot.dependencies.map(([a, b]) => [
    snapshot.modules[a]?.id ?? "",
    snapshot.modules[b]?.id ?? "",
  ]);
}

function hasEdge(
  snapshot: TemporalWorkspaceSnapshot | undefined,
  source: string,
  target: string
): boolean {
  return (
    snapshot !== undefined &&
    edgesOf(snapshot).some(([a, b]) => a === source && b === target)
  );
}

/** Concept ids a module holds in one role. */
function conceptsOf(
  snapshot: TemporalWorkspaceSnapshot | undefined,
  moduleId: string,
  role: "declared" | "usage" | "behavior"
): string[] {
  const module = snapshot?.modules.find((m) => m.id === moduleId);
  return (module?.concepts?.[role] ?? []).map(
    (index) => snapshot?.concepts[index]?.id ?? ""
  );
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
}

interface RepoState {
  branch: string;
  head: string;
  index: string;
  status: string;
  tree: Map<string, string>;
}

function repoState(dir: string): RepoState {
  const tree = new Map(
    [...hashTree(dir).entries()].filter(
      ([file]) => !file.startsWith(".foundry")
    )
  );
  return {
    branch: git(dir, ["symbolic-ref", "HEAD"]).trim(),
    head: git(dir, ["rev-parse", "HEAD"]).trim(),
    index: git(dir, ["ls-files", "-s"]),
    status: git(dir, ["status", "--porcelain"]),
    tree,
  };
}

function synthetic(
  entries: { hash: string; timestamp: string }[]
): SemanticsHistoryCommit[] {
  return entries.map((entry, i) => ({
    ...entry,
    additions: 1,
    changedFiles: 1,
    deletions: 0,
    parents: i === 0 ? [] : [entries[i - 1]?.hash ?? ""],
  }));
}

describe("timeline parsing", () => {
  it("parses numstat output with parents and renames", () => {
    const output =
      "\x01aaa\0" +
      "2026-02-01T00:00:00Z\0" +
      "p1 p2\0\n" +
      "3\t1\tsrc/a.ts\0" +
      "0\t0\t\0src/old.ts\0src/new.ts\0" +
      "-\t-\timg.png\0" +
      "\x01bbb\0" +
      "2026-01-01T00:00:00Z\0" +
      "\0\n" +
      "5\t0\tsrc/b.tsx\0";
    const commits = parseTimelineLog(output);
    expect(commits).toEqual([
      {
        additions: 3,
        changedFiles: 3,
        deletions: 1,
        hash: "aaa",
        parents: ["p1", "p2"],
        renamed: [["src/old.ts", "src/new.ts"]],
        timestamp: "2026-02-01T00:00:00Z",
      },
      {
        additions: 5,
        changedFiles: 1,
        deletions: 0,
        hash: "bbb",
        parents: [],
        timestamp: "2026-01-01T00:00:00Z",
      },
    ]);
  });

  it("parses name-status output into module additions and deletions", () => {
    const output =
      "\x01aaa\0" +
      "A\0src/a.ts\0" +
      "D\0src/gone.ts\0" +
      "R100\0src/old.ts\0src/new.ts\0" +
      "M\0src/b.ts\0" +
      "A\0README.md\0";
    expect([...parseStatusLog(output).entries()]).toEqual([
      ["aaa", { added: ["src/a.ts"], removed: ["src/gone.ts"] }],
    ]);
  });

  it("resolves range expressions against the head timestamp", () => {
    const head = new Date("2026-09-04T12:00:00Z");
    expect(rangeStart("1y", head)?.toISOString()).toBe(
      "2025-09-04T12:00:00.000Z"
    );
    expect(rangeStart("6m", head)?.toISOString()).toBe(
      "2026-03-04T12:00:00.000Z"
    );
    expect(rangeStart("10d", head)?.toISOString()).toBe(
      "2026-08-25T12:00:00.000Z"
    );
    expect(rangeStart("all", head)).toBeUndefined();
    expect(() => rangeStart("soon", head)).toThrow(/Unsupported history range/);
  });
});

describe("checkpoint selection", () => {
  const commits = synthetic([
    { hash: "c1", timestamp: "2026-01-10T00:00:00Z" },
    { hash: "c2", timestamp: "2026-01-20T00:00:00Z" },
    { hash: "c3", timestamp: "2026-02-05T00:00:00Z" },
    { hash: "c4", timestamp: "2026-02-25T00:00:00Z" },
    { hash: "c5", timestamp: "2026-04-01T00:00:00Z" },
    { hash: "c6", timestamp: "2026-04-15T00:00:00Z" },
    { hash: "c7", timestamp: "2026-04-16T00:00:00Z" },
  ]);

  it("monthly picks the last commit of each month and always HEAD", () => {
    const policy = { checkpoints: 12, every: 1, strategy: "monthly" as const };
    expect(selectCheckpoints(commits, policy)).toEqual(["c2", "c4", "c7"]);
    expect(selectCheckpoints(commits, policy)).toEqual(
      selectCheckpoints([...commits], policy)
    );
    expect(selectCheckpoints(commits, { ...policy, checkpoints: 2 })).toEqual([
      "c4",
      "c7",
    ]);
  });

  it("evenly-spaced includes both ends without duplicates", () => {
    const policy = {
      checkpoints: 3,
      every: 1,
      strategy: "evenly-spaced" as const,
    };
    expect(selectCheckpoints(commits, policy)).toEqual(["c1", "c4", "c7"]);
    expect(selectCheckpoints(commits, { ...policy, checkpoints: 50 })).toEqual(
      commits.map((c) => c.hash)
    );
    expect(selectCheckpoints(commits, { ...policy, checkpoints: 1 })).toEqual([
      "c7",
    ]);
  });

  it("every-n-commits walks back from HEAD", () => {
    expect(
      selectCheckpoints(commits, {
        checkpoints: 3,
        every: 3,
        strategy: "every-n-commits",
      })
    ).toEqual(["c1", "c4", "c7"]);
    expect(
      selectCheckpoints([], { checkpoints: 3, every: 1, strategy: "monthly" })
    ).toEqual([]);
  });
});

describe("module lineage", () => {
  const base = (hash: string, timestamp: string): SemanticsHistoryCommit => ({
    additions: 0,
    changedFiles: 1,
    deletions: 0,
    hash,
    parents: [],
    timestamp,
  });

  it("carries identity through renames and cross-package moves", () => {
    const commits: SemanticsHistoryCommit[] = [
      { ...base("c1", "2026-01-01T00:00:00Z"), added: ["packages/b/src/x.ts"] },
      {
        ...base("c2", "2026-02-01T00:00:00Z"),
        renamed: [["packages/b/src/x.ts", "packages/b/src/y.ts"]],
      },
      {
        ...base("c3", "2026-03-01T00:00:00Z"),
        renamed: [["packages/b/src/y.ts", "apps/a/src/y.ts"]],
      },
    ];
    const index = buildLineage(
      commits,
      ["packages/b/src/old.ts"],
      ["c1", "c2", "c3"]
    );
    expect(index.lineages).toEqual([
      {
        id: "apps/a/src/y.ts",
        segments: [
          { path: "packages/b/src/x.ts", since: "c1", until: "c2" },
          { path: "packages/b/src/y.ts", since: "c2", until: "c3" },
          { path: "apps/a/src/y.ts", since: "c3" },
        ],
      },
      {
        id: "packages/b/src/old.ts",
        segments: [{ path: "packages/b/src/old.ts" }],
      },
    ]);
    expect(index.atCheckpoint.get("c1")?.get("packages/b/src/x.ts")).toBe(
      "apps/a/src/y.ts"
    );
    expect(index.atCheckpoint.get("c2")?.get("packages/b/src/y.ts")).toBe(
      "apps/a/src/y.ts"
    );
    expect(index.atCheckpoint.get("c3")?.get("apps/a/src/y.ts")).toBe(
      "apps/a/src/y.ts"
    );
    expect(index.atCheckpoint.get("c3")?.has("packages/b/src/y.ts")).toBe(
      false
    );
  });

  it("never invents continuity when Git reports delete plus add", () => {
    const commits: SemanticsHistoryCommit[] = [
      { ...base("c1", "2026-01-01T00:00:00Z"), added: ["src/a.ts"] },
      {
        ...base("c2", "2026-02-01T00:00:00Z"),
        added: ["src/b.ts"],
        removed: ["src/a.ts"],
      },
    ];
    const index = buildLineage(commits, [], ["c1", "c2"]);
    expect(index.lineages.map((l) => l.id)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(index.atCheckpoint.get("c2")?.has("src/a.ts")).toBe(false);
  });

  it("treats a deleted and recreated path as one identity", () => {
    const commits: SemanticsHistoryCommit[] = [
      { ...base("c1", "2026-01-01T00:00:00Z"), added: ["src/a.ts"] },
      { ...base("c2", "2026-02-01T00:00:00Z"), removed: ["src/a.ts"] },
      { ...base("c3", "2026-03-01T00:00:00Z"), added: ["src/a.ts"] },
    ];
    const index = buildLineage(commits, [], ["c1", "c2", "c3"]);
    expect(index.lineages).toEqual([
      {
        id: "src/a.ts",
        segments: [
          { path: "src/a.ts", since: "c1", until: "c2" },
          { path: "src/a.ts", since: "c3" },
        ],
      },
    ]);
    expect(index.atCheckpoint.get("c2")?.size).toBe(0);
  });
});

describe("history generation", () => {
  let repo: { dir: string; commits: string[] };
  let before: RepoState;
  let manifest: SemanticsHistoryManifest;
  let output: string;
  const snapshots = new Map<string, TemporalWorkspaceSnapshot>();

  beforeAll(async () => {
    repo = buildRepository();
    before = repoState(repo.dir);
    const result = await generateSemanticsHistory({
      config: {
        ...DEFAULT_SEMANTICS_CONFIG,
        roots: ["apps", "packages", "tooling"],
      },
      history: { checkpoints: 12, range: "all", strategy: "monthly" },
      root: repo.dir,
      ...inProcess,
      concurrency: 2,
    });
    manifest = result.manifest;
    output = result.output;
    for (const ref of manifest.snapshots) {
      if (ref.file !== undefined) {
        snapshots.set(
          ref.commit,
          readJson(output, ref.file) as TemporalWorkspaceSnapshot
        );
      }
    }
  }, 240_000);

  afterAll(() => {
    fs.rmSync(repo.dir, { force: true, recursive: true });
  });

  it("selects every monthly commit and ends at HEAD", () => {
    expect(manifest.schemaVersion).toBe(SEMANTICS_HISTORY_SCHEMA_VERSION);
    expect(manifest.snapshots.map((s) => s.commit)).toEqual(repo.commits);
    expect(manifest.repository).toEqual({
      branch: "main",
      head: repo.commits[3],
    });
    expect(manifest.policy.historyMode).toBe("first-parent");
    expect(manifest.generation).toMatchObject({
      cachedSnapshots: 0,
      failedSnapshots: 0,
      requestedSnapshots: 4,
      successfulSnapshots: 4,
      timelineCommits: 4,
    });
    expect(manifest.snapshots.every((s) => s.status === "complete")).toBe(true);
    const timeline = readJson(
      output,
      manifest.files.timeline
    ) as SemanticsHistoryTimeline;
    expect(timeline.commits.map((c) => c.hash)).toEqual(repo.commits);
    expect(timeline.commits.every((c) => c.checkpoint === true)).toBe(true);
    expect(timeline.commits[0]).not.toHaveProperty("author");
  });

  it("snapshots carry the commit identity and the package set of that tree", () => {
    const [c1, , , c4] = repo.commits;
    const first = snapshots.get(c1 ?? "");
    const last = snapshots.get(c4 ?? "");
    expect(first?.commit).toBe(c1);
    expect(first?.timestamp).toBe("2026-01-15T12:00:00Z");
    expect(first?.packages.map((p) => p.id)).toEqual(["@s/a", "@s/b", "@s/c"]);
    expect(last?.packages.map((p) => p.id)).toEqual(["@s/a", "@s/b", "@s/d"]);
    expect(first?.coverage).toMatchObject({
      failed: [],
      rootsScanned: ["apps", "packages", "tooling"],
      unitsAnalyzed: 3,
      unitsDiscovered: 3,
    });
    expect(first?.profile).toBe("temporal");
  });

  it("keeps one lineage through the rename and the cross-package move", () => {
    const entities = readJson(
      output,
      manifest.files.entities
    ) as SemanticsHistoryEntities;
    const [c1, c2, c3, c4] = repo.commits;
    const padding = entities.modules.find(
      (m) => m.id === "tooling/c/src/padding.ts"
    );
    expect(padding?.segments).toEqual([
      { path: "tooling/c/src/pad.ts", since: c1, until: c3 },
      { path: "tooling/c/src/padding.ts", since: c3, until: c4 },
    ]);
    const scale = entities.modules.find((m) => m.id === "apps/a/src/scale.ts");
    expect(scale?.segments).toEqual([
      { path: "packages/b/src/scale.ts", since: c2, until: c3 },
      { path: "apps/a/src/scale.ts", since: c3 },
    ]);
    expect(entities.packages).toEqual([
      { checkpoints: repo.commits, id: "@s/a" },
      { checkpoints: repo.commits, id: "@s/b" },
      { checkpoints: [c1, c2, c3], id: "@s/c" },
      { checkpoints: [c4], id: "@s/d" },
    ]);
    const second = snapshots.get(c2 ?? "");
    const scaleAtC2 = second?.modules.find(
      (m) => m.id === "apps/a/src/scale.ts"
    );
    expect(scaleAtC2).toMatchObject({
      package: "@s/b",
      path: "packages/b/src/scale.ts",
    });
    const third = snapshots.get(c3 ?? "");
    expect(
      third?.modules.find((m) => m.id === "tooling/c/src/padding.ts")?.path
    ).toBe("tooling/c/src/padding.ts");
    expect(
      hasEdge(third, "tooling/c/src/index.ts", "tooling/c/src/padding.ts")
    ).toBe(true);
    expect(
      hasEdge(second, "tooling/c/src/index.ts", "tooling/c/src/padding.ts")
    ).toBe(true);
  });

  it("re-keys concept ids by declaring module lineage and keeps index references consistent", () => {
    const [, c2] = repo.commits;
    const second = snapshots.get(c2 ?? "");
    const shape = second?.concepts.find((c) => c.name === "Shape");
    expect(shape?.id).toBe("packages/b/src/shape.ts#Shape");
    expect(shape?.packages).toEqual(["@s/a", "@s/b", "@s/c"]);
    expect(conceptsOf(second, "apps/a/src/scale.ts", "usage")).toContain(
      "packages/b/src/shape.ts#Shape"
    );
    expect(conceptsOf(second, "packages/b/src/shape.ts", "declared")).toContain(
      "packages/b/src/shape.ts#Shape"
    );
    for (const snapshot of snapshots.values()) {
      expect(snapshot.modules.map((m) => m.id)).toEqual(
        [...snapshot.modules.map((m) => m.id)].sort()
      );
      for (const [a, b] of snapshot.dependencies) {
        expect(snapshot.modules[a]).toBeDefined();
        expect(snapshot.modules[b]).toBeDefined();
      }
    }
  });

  it("derives deltas that name exact before and after states", () => {
    const [c1, c2, c3, c4] = repo.commits;
    expect(manifest.deltas.map((d) => [d.from, d.to])).toEqual([
      [c1, c2],
      [c2, c3],
      [c3, c4],
    ]);
    const d12 = readJson(
      output,
      manifest.deltas[0]?.file ?? ""
    ) as TemporalSnapshotDelta;
    expect(d12.modules.added).toEqual(["apps/a/src/scale.ts"]);
    expect(d12.dependencies.added).toContainEqual([
      "packages/b/src/index.ts",
      "apps/a/src/scale.ts",
    ]);
    expect(d12.packages.moduleCount).toEqual([{ from: 2, id: "@s/b", to: 3 }]);
    const d23 = readJson(
      output,
      manifest.deltas[1]?.file ?? ""
    ) as TemporalSnapshotDelta;
    expect(d23.modules.renamed).toEqual([
      {
        from: "packages/b/src/scale.ts",
        id: "apps/a/src/scale.ts",
        to: "apps/a/src/scale.ts",
      },
      {
        from: "tooling/c/src/pad.ts",
        id: "tooling/c/src/padding.ts",
        to: "tooling/c/src/padding.ts",
      },
    ]);
    expect(d23.modules.moved).toEqual([
      { from: "@s/b", id: "apps/a/src/scale.ts", to: "@s/a" },
    ]);
    expect(d23.dependencies.removed).toContainEqual([
      "packages/b/src/index.ts",
      "apps/a/src/scale.ts",
    ]);
    expect(d23.dependencies.added).toContainEqual([
      "apps/a/src/index.ts",
      "apps/a/src/scale.ts",
    ]);
    const d34 = readJson(
      output,
      manifest.deltas[2]?.file ?? ""
    ) as TemporalSnapshotDelta;
    expect(d34.packages).toMatchObject({ added: ["@s/d"], removed: ["@s/c"] });
    expect(d34.modules.removed).toEqual([
      "tooling/c/src/index.ts",
      "tooling/c/src/padding.ts",
      "tooling/c/src/unit.ts",
    ]);
    expect(d34.modules.added).toEqual(["packages/d/src/index.ts"]);
    const shape = d34.concepts.span.find(
      (s) => s.id === "packages/b/src/shape.ts#Shape"
    );
    expect(shape).toEqual({
      from: ["@s/a", "@s/b", "@s/c"],
      id: "packages/b/src/shape.ts#Shape",
      to: ["@s/a", "@s/b", "@s/d"],
    });
    expect(d34.boundaries.added).toContain("@s/d→@s/b");
    expect(d34.boundaries.removed).toContain("@s/c→@s/b");
  });

  it("leaves the repository checkout, branch, index, and tree untouched", () => {
    const after = repoState(repo.dir);
    expect(after.head).toBe(before.head);
    expect(after.branch).toBe(before.branch);
    expect(after.index).toBe(before.index);
    expect(after.status).toBe("");
    expect([...after.tree.entries()]).toEqual([...before.tree.entries()]);
    expect(
      git(repo.dir, ["worktree", "list", "--porcelain"]).trim().split("\n\n")
    ).toHaveLength(1);
  });

  it("writes only relative paths", () => {
    const tmp = fs.realpathSync(os.tmpdir());
    for (const file of listFiles(output)) {
      const text = fs.readFileSync(file, "utf8");
      expect(text.includes(tmp)).toBe(false);
      expect(text.includes("semantics-history-")).toBe(false);
      expect(text.includes(repo.dir)).toBe(false);
    }
  });

  it("reuses cached checkpoints and invalidates them on a fingerprint change", async () => {
    let analyzedLocals = 0;
    let derived = 0;
    const counting = {
      analyzeLocal: ((unit, context) => {
        analyzedLocals += 1;
        return inProcessLocal(unit, context);
      }) satisfies SemanticsLocalAnalyzer,
      derive: ((locals, context) => {
        derived += 1;
        return inProcessDerive(locals, context);
      }) satisfies SemanticsDeriver,
    };
    const first = hashTree(output);
    const cached = await generateSemanticsHistory({
      config: {
        ...DEFAULT_SEMANTICS_CONFIG,
        roots: ["apps", "packages", "tooling"],
      },
      history: { checkpoints: 12, range: "all", strategy: "monthly" },
      root: repo.dir,
      ...counting,
    });
    expect(analyzedLocals).toBe(0);
    expect(derived).toBe(0);
    expect(cached.manifest.generation.cachedSnapshots).toBe(4);
    expect(cached.manifest.snapshots.every((s) => s.cached)).toBe(true);
    const second = hashTree(output);
    for (const [file, hash] of first) {
      if (file === "manifest.json") {
        continue;
      }
      expect(second.get(file)).toBe(hash);
    }

    // A policy change invalidates every snapshot, but the historical
    // package-local reports are keyed by content alone and survive it: every
    // checkpoint re-derives without analyzing a single package again.
    const invalidated = await generateSemanticsHistory({
      config: {
        ...DEFAULT_SEMANTICS_CONFIG,
        exclude: ["packages/d"],
        roots: ["apps", "packages", "tooling"],
      },
      history: { checkpoints: 12, range: "all", strategy: "monthly" },
      root: repo.dir,
      ...counting,
    });
    expect(invalidated.manifest.fingerprint).not.toBe(
      cached.manifest.fingerprint
    );
    expect(invalidated.manifest.generation.cachedSnapshots).toBe(0);
    expect(derived).toBe(4);
    expect(analyzedLocals).toBe(0);
    const reused = invalidated.manifest.generation.checkpoints.map(
      (c) => c.localsReused
    );
    // the last checkpoint has one package removed and packages/d excluded
    expect(reused).toEqual([3, 3, 3, 2]);
  }, 240_000);

  it("records a failed checkpoint, keeps the others, and removes its worktree", async () => {
    const [, c2] = repo.commits;
    // Locals unchanged since the previous checkpoint come from the content
    // cache, so a per-package failure at c2 only loses that package; a
    // derivation failure loses the whole checkpoint.
    const failing: SemanticsDeriver = (locals, context) => {
      if (fs.existsSync(path.join(context.root, "packages/b/src/scale.ts"))) {
        throw new Error("historical workspace unsupported");
      }
      return inProcessDerive(locals, context);
    };
    const result = await generateSemanticsHistory({
      analyzeLocal: inProcessLocal,
      cache: ".foundry/cache/failing",
      config: {
        ...DEFAULT_SEMANTICS_CONFIG,
        roots: ["apps", "packages", "tooling"],
      },
      derive: failing,
      history: { checkpoints: 12, range: "all", strategy: "monthly" },
      output: ".foundry/history-failing",
      root: repo.dir,
    });
    const failed = result.manifest.snapshots.find((s) => s.commit === c2);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toMatch(/historical workspace unsupported/);
    expect(failed?.file).toBeUndefined();
    expect(result.manifest.generation).toMatchObject({
      failedSnapshots: 1,
      requestedSnapshots: 4,
      successfulSnapshots: 3,
    });
    expect(result.manifest.deltas.map((d) => [d.from, d.to])).toEqual([
      [repo.commits[0], repo.commits[2]],
      [repo.commits[2], repo.commits[3]],
    ]);
    expect(
      git(repo.dir, ["worktree", "list", "--porcelain"]).trim().split("\n\n")
    ).toHaveLength(1);
    expect(repoState(repo.dir).status).toBe("");
  }, 240_000);

  it("fails a checkpoint whose every package-local analysis failed", async () => {
    const result = await generateSemanticsHistory({
      analyzeLocal: () =>
        Promise.reject(new Error("historical source unsupported")),
      cache: ".foundry/cache/all-failing",
      config: {
        ...DEFAULT_SEMANTICS_CONFIG,
        roots: ["apps", "packages", "tooling"],
      },
      derive: inProcessDerive,
      history: { checkpoints: 12, range: "all", strategy: "monthly" },
      output: ".foundry/history-all-failing",
      root: repo.dir,
    });
    expect(result.manifest.snapshots.map((s) => s.status)).toEqual(
      Array<string>(4).fill("failed")
    );
    expect(result.manifest.snapshots[0]?.error).toMatch(
      /every unit failed to analyze: historical source unsupported/
    );
    expect(result.manifest.deltas).toEqual([]);
  }, 240_000);

  it("keeps the previous dataset byte-identical when generation fails", async () => {
    const previous = hashTree(output);
    await expect(
      generateSemanticsHistory({
        config: {
          ...DEFAULT_SEMANTICS_CONFIG,
          roots: ["apps", "packages", "tooling"],
        },
        history: { range: "soon" },
        root: repo.dir,
        ...inProcess,
      })
    ).rejects.toThrow(/Unsupported history range/);
    expect([...hashTree(output).entries()]).toEqual([...previous.entries()]);
    expect(
      fs.readdirSync(path.dirname(output)).filter((f) => f.includes(".tmp-"))
    ).toEqual([]);
  });

  it("ignores a corrupt or foreign cached snapshot and analyzes that checkpoint again", async () => {
    const cacheRoot = path.join(
      repo.dir,
      ".foundry/cache/semantics-history",
      `v${SEMANTICS_CACHE_SCHEMA_VERSION}`,
      manifest.fingerprint
    );
    const [c1, c2] = repo.commits;
    fs.writeFileSync(path.join(cacheRoot, `${c1 ?? ""}.json`), "{ broken");
    const foreign = readJson(
      cacheRoot,
      `${c2 ?? ""}.json`
    ) as TemporalWorkspaceSnapshot;
    fs.writeFileSync(
      path.join(cacheRoot, `${c2 ?? ""}.json`),
      JSON.stringify({
        ...foreign,
        commit: "0000000000000000000000000000000000000000",
      })
    );
    const result = await generateSemanticsHistory({
      config: {
        ...DEFAULT_SEMANTICS_CONFIG,
        roots: ["apps", "packages", "tooling"],
      },
      history: { checkpoints: 12, range: "all", strategy: "monthly" },
      root: repo.dir,
      ...inProcess,
    });
    expect(result.manifest.generation.cachedSnapshots).toBe(2);
    expect(
      result.manifest.snapshots.map((s) => [s.commit.slice(0, 7), s.cached])
    ).toEqual(repo.commits.map((c, i) => [c.slice(0, 7), i >= 2]));
    for (const ref of result.manifest.snapshots) {
      expect(
        readJson(result.output, ref.file ?? "") as TemporalWorkspaceSnapshot
      ).toEqual(snapshots.get(ref.commit));
    }
  }, 240_000);

  it("reuses every existing checkpoint when only HEAD moves", async () => {
    write(repo.dir, "apps/a/src/fresh.ts", "export const fresh = 1;\n");
    const head = commit(repo.dir, "2026-05-15T12:00:00Z");
    let analyzedCheckpoints = new Set<string>();
    const result = await generateSemanticsHistory({
      config: {
        ...DEFAULT_SEMANTICS_CONFIG,
        roots: ["apps", "packages", "tooling"],
      },
      history: { checkpoints: 12, range: "all", strategy: "monthly" },
      root: repo.dir,
      ...inProcess,
      onProgress: (event) => {
        if (event.kind === "unit") {
          analyzedCheckpoints = analyzedCheckpoints.add(event.commit);
        }
      },
    });
    expect(result.manifest.snapshots.map((s) => s.cached)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
    expect([...analyzedCheckpoints]).toEqual([head]);
    // undo so later tests see the original repository
    git(repo.dir, ["reset", "-q", "--hard", "HEAD~1"]);
  }, 240_000);

  it("keys the checkpoint cache by the stages a snapshot depends on only", () => {
    expect(stageClosure("historySnapshot")).toEqual([
      "historySnapshot",
      "packageAnalysis",
      "packageLocalAnalysis",
      "workspaceDerivation",
      "workspaceIngestion",
      "workspaceIntelligence",
    ]);
    expect(stageClosure("materialization")).toContain("workspaceProjection");
    expect(
      historyFingerprint({
        ...DEFAULT_SEMANTICS_CONFIG,
        roots: ["apps", "packages", "tooling"],
      })
    ).toBe(manifest.fingerprint);
    expect(
      historyFingerprint({ ...DEFAULT_SEMANTICS_CONFIG, roots: ["apps"] })
    ).not.toBe(manifest.fingerprint);
  });

  it("produces an equivalent dataset with and without the cache", async () => {
    const cached = await generateSemanticsHistory({
      config: {
        ...DEFAULT_SEMANTICS_CONFIG,
        roots: ["apps", "packages", "tooling"],
      },
      history: { checkpoints: 12, range: "all", strategy: "monthly" },
      root: repo.dir,
      ...inProcess,
    });
    expect(cached.manifest.generation.cachedSnapshots).toBe(4);
    const clean = await generateSemanticsHistory({
      cache: ".foundry/cache/history-clean",
      config: {
        ...DEFAULT_SEMANTICS_CONFIG,
        roots: ["apps", "packages", "tooling"],
      },
      history: { checkpoints: 12, range: "all", strategy: "monthly" },
      output: ".foundry/history-clean",
      root: repo.dir,
      ...inProcess,
    });
    expect(clean.manifest.generation.cachedSnapshots).toBe(0);
    const comparison = compareSemanticsDatasets(cached.output, clean.output, {
      kindOf: (file) =>
        file === "manifest.json" ? "history-manifest.json" : undefined,
    });
    expect(comparison.differences).toEqual([]);
    expect(comparison.equivalent).toBe(true);
  }, 240_000);

  it("re-derives every current report when a commit lands, without re-analyzing a package", async () => {
    const firstBuild = await generateSemantics({
      config: {
        ...DEFAULT_SEMANTICS_CONFIG,
        roots: ["apps", "packages", "tooling"],
      },
      now: new Date("2026-06-01T00:00:00Z"),
      root: repo.dir,
      ...inProcess,
      mode: "full",
    });
    expect(firstBuild.packages.analyzed).toBe(3);
    // a commit-only change: the working tree sources are what they were
    write(repo.dir, "packages/d/NOTES.md", "notes\n");
    commit(repo.dir, "2026-05-20T12:00:00Z");
    const second = await generateSemantics({
      config: {
        ...DEFAULT_SEMANTICS_CONFIG,
        roots: ["apps", "packages", "tooling"],
      },
      now: new Date("2026-06-01T00:00:00Z"),
      root: repo.dir,
      ...inProcess,
      mode: "incremental",
    });
    const byId = new Map(
      second.invalidations
        .filter((i) => i.kind === "package-report")
        .map((i) => [i.id, i])
    );
    // churn ranks every file against the whole repository's history, so a
    // commit anywhere is an input to every assembled report — but Git is not
    // an input to any package-local report, so no package is re-analyzed
    for (const id of ["@s/a", "@s/b", "@s/d"]) {
      expect(byId.get(id)?.reason).toEqual({
        cause: "history-changed",
        type: "direct",
      });
    }
    expect(second.packages).toMatchObject({ analyzed: 0, reused: 3 });
    expect(second.reports).toMatchObject({ derived: 3, reused: 0 });
    const third = await generateSemantics({
      config: {
        ...DEFAULT_SEMANTICS_CONFIG,
        roots: ["apps", "packages", "tooling"],
      },
      now: new Date("2026-06-01T00:00:00Z"),
      root: repo.dir,
      ...inProcess,
      mode: "incremental",
    });
    expect(third.packages).toMatchObject({ analyzed: 0, reused: 3 });
    expect(third.reports).toMatchObject({ derived: 0, reused: 3 });
    git(repo.dir, ["reset", "-q", "--hard", "HEAD~1"]);
  }, 240_000);

  it("analyzes a tree with no configured roots as an empty checkpoint", async () => {
    const result = await generateSemanticsHistory({
      cache: ".foundry/cache/empty",
      config: { ...DEFAULT_SEMANTICS_CONFIG, roots: ["vendor"] },
      history: { checkpoints: 1, range: "all", strategy: "evenly-spaced" },
      output: ".foundry/history-empty",
      root: repo.dir,
      ...inProcess,
    });
    expect(result.manifest.generation.successfulSnapshots).toBe(1);
    const only = result.manifest.snapshots[0];
    const snapshot = readJson(
      result.output,
      only?.file ?? ""
    ) as TemporalWorkspaceSnapshot;
    expect(snapshot.packages).toEqual([]);
    expect(snapshot.modules).toEqual([]);
    expect(snapshot.coverage.rootsMissing).toEqual(["vendor"]);
  }, 120_000);
});
