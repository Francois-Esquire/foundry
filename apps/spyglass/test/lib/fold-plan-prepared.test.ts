import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBoundary } from "../../src/lib/boundary";
import type { Boundary } from "../../src/lib/boundary-model";
import { analyzeFileMap } from "../../src/lib/file-map-analysis";
import { buildFoldPlans, readFoldInputs } from "../../src/lib/fold-plan";
import type { FoldInputs } from "../../src/lib/fold-planning";
import { analyzePackageLocal } from "../../src/lib/package-local";
import type {
  FoldPackagePlan,
  ReductionOpportunity,
  SurfaceDependencies,
} from "../../src/lib/types";
import { analyzePreparedWorkspace } from "../../src/lib/workspace-analysis";
import {
  deriveWorkspaceSurface,
  prepareWorkspaceDerivation,
} from "../../src/lib/workspace-derive";
import type { WorkspaceSurfaceDerivation } from "../../src/lib/workspace-derive-types";

// Fold planning from prepared inputs. `readFoldInputs` takes the native
// planner's repository answers up front; `buildFoldPlans` given them must
// plan exactly as the native planner does, without any read. The native
// lookups are intercepted rather than relied on to fail: once inputs are
// prepared, a call to a blocked one is recorded and fails the test, even
// where planning catches its error. The `node:fs` interception covers every
// Spyglass source module; ts-morph, dependency-cruiser and TypeScript's
// own `ts.sys` are external and not intercepted. The planner reached
// `ts.sys.readFile` only behind an `existsSync` check, which is blocked.

const guard = vi.hoisted(() => {
  const blocked = new Set<string>();
  const attempts: string[] = [];
  /** Each fold read: its source directories and destination names. */
  const foldReads: { destinations: string[]; sources: string[] }[] = [];
  return {
    attempts,
    blocked,
    foldReads,
    /**
     * Directory listing order. `native` is whatever the file system and
     * runtime give: Node sorts `readdirSync` (libuv's scandir), Bun returns
     * the file system's own order, which on ext4 is hash order. The others
     * impose an order, so a test can hold the planner to every listing.
     */
    order: "native" as "ascending" | "descending" | "native",
    wrap<A extends unknown[], R>(
      name: string,
      fn: (...args: A) => R
    ): (...args: A) => R {
      return (...args: A) => {
        if (blocked.has(name)) {
          attempts.push(name);
          throw new Error(`${name} called after preparation`);
        }
        return fn(...args);
      };
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    existsSync: guard.wrap("existsSync", original.existsSync),
    lstatSync: guard.wrap("lstatSync", original.lstatSync),
    readdirSync: guard.wrap("readdirSync", ((...args: unknown[]) => {
      const entries = (original.readdirSync as (...a: unknown[]) => unknown[])(
        ...args
      );
      if (guard.order === "native") {
        return entries;
      }
      const name = (entry: unknown) =>
        typeof entry === "string"
          ? entry
          : String((entry as { name: unknown }).name);
      const ascending = [...entries].sort((a, b) =>
        name(a) < name(b) ? -1 : Number(name(a) > name(b))
      );
      return guard.order === "ascending" ? ascending : ascending.reverse();
    }) as typeof original.readdirSync),
    readFileSync: guard.wrap("readFileSync", original.readFileSync),
    realpathSync: guard.wrap("realpathSync", original.realpathSync),
    statSync: guard.wrap("statSync", original.statSync),
  };
});
vi.mock("../../src/lib/boundary", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/lib/boundary")>();
  return {
    ...original,
    boundaryEntrypoints: guard.wrap(
      "boundaryEntrypoints",
      original.boundaryEntrypoints
    ),
    ownerBoundary: guard.wrap("ownerBoundary", original.ownerBoundary),
    resolveBoundary: guard.wrap("resolveBoundary", original.resolveBoundary),
    snapshotDirectoryOwnership: guard.wrap(
      "snapshotDirectoryOwnership",
      original.snapshotDirectoryOwnership
    ),
    workspacePatterns: guard.wrap(
      "workspacePatterns",
      original.workspacePatterns
    ),
  };
});
vi.mock("../../src/lib/fold-inputs", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/lib/fold-inputs")>();
  return {
    ...original,
    readFoldInputsWith: ((reader, ignorer, root, sources, destinations) => {
      const names = [...destinations];
      guard.foldReads.push({
        destinations: names,
        sources: sources.map((boundary) => boundary.relPath),
      });
      return original.readFoldInputsWith(reader, ignorer, root, sources, names);
    }) satisfies typeof original.readFoldInputsWith,
  };
});
vi.mock("../../src/lib/ignore", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/lib/ignore")>();
  return {
    ...original,
    createIgnorer: guard.wrap("createIgnorer", original.createIgnorer),
  };
});
vi.mock("../../src/lib/dependencies", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/lib/dependencies")>();
  return {
    ...original,
    cruiseWorkspace: guard.wrap("cruiseWorkspace", original.cruiseWorkspace),
  };
});
vi.mock("../../src/lib/git-history", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/lib/git-history")>();
  return {
    ...original,
    collectGitHistory: guard.wrap(
      "collectGitHistory",
      original.collectGitHistory
    ),
  };
});
vi.mock("../../src/lib/project", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/lib/project")>();
  return {
    ...original,
    createProject: guard.wrap("createProject", original.createProject),
  };
});

/** The file reads and lookups the native fold planner made. */
const FOLD_READS = [
  "createIgnorer",
  "existsSync",
  "readFileSync",
  "readdirSync",
  "resolveBoundary",
  "workspacePatterns",
];
/** Every file system call and native lookup a Spyglass module can make. */
const EVERYTHING = [
  ...FOLD_READS,
  "boundaryEntrypoints",
  "collectGitHistory",
  "createProject",
  "cruiseWorkspace",
  "lstatSync",
  "ownerBoundary",
  "realpathSync",
  "snapshotDirectoryOwnership",
  "statSync",
];

const now = new Date("2026-11-07T00:00:00Z");
const tempRoots: string[] = [];

beforeEach(() => {
  guard.blocked.clear();
  guard.attempts.length = 0;
  guard.foldReads.length = 0;
  guard.order = "native";
});

afterAll(() => {
  for (const dir of tempRoots) {
    chmodRecursiveSafe(dir);
    rmSync(dir, { force: true, recursive: true });
  }
});

function chmodRecursiveSafe(dir: string): void {
  try {
    chmodSync(join(dir, "packages/sat/src/locked"), 0o755);
  } catch {
    // Only the walk-error case locks a directory.
  }
}

function blockedDuring<T>(names: readonly string[], run: () => T): T {
  for (const name of names) {
    guard.blocked.add(name);
  }
  try {
    return run();
  } finally {
    guard.blocked.clear();
  }
}

function workspace(prefix: string, files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempRoots.push(root);
  for (const [file, content] of Object.entries(files)) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

const consume = (specifier: string, name: string) =>
  `import { ${name} } from "${specifier}";\nexport const use = ${name}();\n`;

/**
 * Two fold sources with different destinations. `@f/sat` folds into
 * `@f/host`, which already has `src/sat`, declares the dependency and
 * references it from a JSONC tsconfig. Its walk meets a gitignored
 * directory and file, a skipped `dist`, a declaration file, a test, a
 * story, a config module and a file that is not TypeScript. `@f/lone` is
 * listed explicitly in the root workspaces and folds into `@f/plain`,
 * which has `src` but no `src/lone`, declares nothing and has no tsconfig.
 */
/** Every file below `root`, root-relative, as a file map records it. */
function fileMapOf(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else {
        files[relative(root, absolute)] = readFileSync(absolute, "utf8");
      }
    }
  };
  walk(root);
  return files;
}

function foldWorkspace(): string {
  return workspace("fold-prepared-", {
    ".gitignore": "generated/\n*.local.ts\n",
    "libs/lone/package.json": JSON.stringify({
      exports: { ".": "./src/index.ts" },
      name: "@f/lone",
    }),
    "libs/lone/src/index.ts":
      "export function lone(): number {\n  return 1;\n}\n",
    "package.json": JSON.stringify({
      name: "fold-root",
      private: true,
      workspaces: ["packages/*", "libs/lone"],
    }),
    "packages/host/package.json": JSON.stringify({
      dependencies: { "@f/sat": "workspace:*" },
      name: "@f/host",
    }),
    "packages/host/src/index.ts": consume("@f/sat", "sat"),
    "packages/host/src/sat/keep.ts": "export const keep = 1;\n",
    "packages/host/tsconfig.json":
      '{\n  // project references\n  "references": [{ "path": "../sat" }],\n}\n',
    "packages/plain/package.json": JSON.stringify({ name: "@f/plain" }),
    "packages/plain/src/index.ts": consume("@f/lone", "lone"),
    "packages/sat/dist/out.ts": "export const out = 1;\n",
    "packages/sat/package.json": JSON.stringify({
      exports: { ".": "./src/index.ts" },
      name: "@f/sat",
    }),
    "packages/sat/README.md": "# sat\n",
    "packages/sat/src/generated/gen.ts": "export const gen = 1;\n",
    "packages/sat/src/index.test.ts": consume("./index", "sat"),
    "packages/sat/src/index.ts":
      "export function sat(): number {\n  return 2;\n}\n",
    "packages/sat/src/scratch.local.ts": "export const scratch = 1;\n",
    "packages/sat/src/types.d.ts": "export type Sat = number;\n",
    "packages/sat/src/view.stories.tsx": "export const story = 1;\n",
    "packages/sat/tsconfig.json": "{}\n",
    "packages/sat/vite.config.ts": "export default {};\n",
  });
}

const FOLD_TARGETS = [
  "libs/lone",
  "packages/host",
  "packages/plain",
  "packages/sat",
];

function foldPlans(
  derivation: WorkspaceSurfaceDerivation
): Record<string, FoldPackagePlan> {
  return Object.fromEntries(
    Object.values(derivation.packages).flatMap((facts) =>
      facts.plans.flatMap((plan) =>
        plan.operation === "fold-package" ? [[facts.path, plan]] : []
      )
    )
  );
}

function comparable(derivation: WorkspaceSurfaceDerivation): string {
  return JSON.stringify({ ...derivation, timing: undefined }, (key, value) =>
    key === "runtimeMs" ? undefined : value
  );
}

/** A fold opportunity into `destination`, its single consumer. */
function foldInto(
  boundary: Boundary,
  destination: string
): {
  dependencies: SurfaceDependencies;
  opportunities: ReductionOpportunity[];
} {
  const name = boundary.packageName ?? boundary.relPath;
  return {
    dependencies: {
      averageSymbolDistribution: 1,
      consumerPackages: 1,
      dependencyPackages: 0,
      incoming: [
        {
          importSites: 1,
          moduleEdges: [],
          package: destination,
          referenceShare: 1,
          references: 1,
          surfaceShare: 1,
          symbols: [],
          symbolsUsed: 1,
          usageNamespace: "value",
        },
      ],
      outgoing: [],
      shapeSignals: [],
    },
    opportunities: [
      {
        cautions: [],
        estimatedReduction: [],
        evidence: [],
        evidenceConfidence: 1,
        id: `fold-package:${name}`,
        operation: "fold-package",
        subject: { id: name, name, type: "package" },
        summary: "",
        target: { id: destination, name: destination, type: "package" },
      },
    ],
  };
}

/** The native plan, and the same plan built from prepared inputs with every read blocked. */
function planBothWays(
  boundary: Boundary,
  destination: string,
  inputs: FoldInputs = readFoldInputs(boundary.root, [boundary], [destination])
): { native: FoldPackagePlan[]; prepared: FoldPackagePlan[] } {
  const { dependencies, opportunities } = foldInto(boundary, destination);
  const native = buildFoldPlans(boundary, [], dependencies, opportunities);
  const prepared = blockedDuring(EVERYTHING, () =>
    buildFoldPlans(boundary, [], dependencies, opportunities, undefined, inputs)
  );
  expect(guard.attempts).toEqual([]);
  return { native, prepared };
}

/** The native planner's error, and the prepared planner's, with every read blocked. */
function errorsBothWays(
  boundary: Boundary,
  destination: string
): { native: unknown; prepared: unknown } {
  const inputs = readFoldInputs(boundary.root, [boundary], [destination]);
  const { dependencies, opportunities } = foldInto(boundary, destination);
  const caught = (run: () => unknown): unknown => {
    try {
      run();
    } catch (error) {
      return error;
    }
    throw new Error("expected planning to throw");
  };
  const native = caught(() =>
    buildFoldPlans(boundary, [], dependencies, opportunities)
  );
  const prepared = blockedDuring(EVERYTHING, () =>
    caught(() =>
      buildFoldPlans(
        boundary,
        [],
        dependencies,
        opportunities,
        undefined,
        inputs
      )
    )
  );
  expect(guard.attempts).toEqual([]);
  return { native, prepared };
}

describe("fold inputs", () => {
  it("records walks, destinations and patterns in a stable order", () => {
    const root = foldWorkspace();
    const sat = resolveBoundary(root, "packages/sat");
    const lone = resolveBoundary(root, "libs/lone");
    const inputs = readFoldInputs(
      root,
      [sat, lone],
      ["@f/plain", "<root>", "@f/host"]
    );
    expect([...inputs.sources.keys()]).toEqual([lone.dir, sat.dir]);
    expect(inputs.sources.get(sat.dir)).toEqual({
      files: {
        value: [
          "packages/sat/package.json",
          "packages/sat/README.md",
          "packages/sat/src/index.test.ts",
          "packages/sat/src/index.ts",
          "packages/sat/src/types.d.ts",
          "packages/sat/src/view.stories.tsx",
          "packages/sat/tsconfig.json",
          "packages/sat/vite.config.ts",
        ],
      },
      hasManifest: true,
      hasTsconfig: true,
    });
    expect([...inputs.destinations.keys()]).toEqual([
      "@f/host",
      "@f/plain",
      "<root>",
    ]);
    expect(inputs.destinations.get("<root>")).toBeNull();
    const host = inputs.destinations.get("@f/host");
    expect(host?.relPath).toBe("packages/host");
    expect(host?.manifest).toEqual({
      value: {
        dependencies: { "@f/sat": "workspace:*" },
        devDependencies: undefined,
        peerDependencies: undefined,
      },
    });
    expect(host?.tsconfig).toEqual({ references: [{ path: "../sat" }] });
    expect([...(host?.srcEntries ?? [])]).toEqual([
      ["lone", false],
      ["sat", true],
    ]);
    expect(inputs.destinations.get("@f/plain")?.tsconfig).toBeUndefined();
    expect(inputs.workspacePatterns).toEqual({
      value: ["packages/*", "libs/lone"],
    });
  });

  it("plans resolved, suggested and unresolved destinations without reading", () => {
    const root = foldWorkspace();
    const sat = resolveBoundary(root, "packages/sat");
    const lone = resolveBoundary(root, "libs/lone");
    const inputs = readFoldInputs(
      root,
      [sat, lone],
      ["@f/host", "@f/plain", "<root>"]
    );

    const resolved = planBothWays(sat, "@f/host", inputs);
    expect(resolved.prepared).toEqual(resolved.native);
    const [satPlan] = resolved.prepared;
    expect(satPlan?.status).toBe("ready");
    expect(satPlan?.destination).toEqual({
      directory: "src/sat",
      package: "@f/host",
      path: "packages/host",
      resolution: "resolved",
    });
    expect(satPlan?.files).toEqual([
      { file: "packages/sat/src/index.test.ts", kind: "test" },
      { file: "packages/sat/src/index.ts", kind: "source" },
      { file: "packages/sat/src/view.stories.tsx", kind: "source" },
      { file: "packages/sat/vite.config.ts", kind: "config" },
    ]);
    expect(
      satPlan?.packageMetadata.map((impact) => [impact.kind, impact.file])
    ).toEqual([
      ["source-manifest", "packages/sat/package.json"],
      ["source-tsconfig", "packages/sat/tsconfig.json"],
      ["consumer-dependency", "packages/host/package.json"],
      ["project-reference", "packages/host/tsconfig.json"],
    ]);

    const suggested = planBothWays(lone, "@f/plain", inputs);
    expect(suggested.prepared).toEqual(suggested.native);
    const [lonePlan] = suggested.prepared;
    expect(lonePlan?.destination).toEqual({
      directory: "src/lone",
      package: "@f/plain",
      path: "packages/plain",
      resolution: "suggested",
    });
    expect(lonePlan?.packageMetadata.map((impact) => impact.kind)).toEqual([
      "source-manifest",
      "workspace-entry",
    ]);

    const unresolved = planBothWays(sat, "<root>", inputs);
    expect(unresolved.prepared).toEqual(unresolved.native);
    const [rootPlan] = unresolved.prepared;
    expect(rootPlan?.status).toBe("unsupported");
    expect(rootPlan?.destination).toEqual({
      package: "<root>",
      resolution: "unresolved",
    });
    expect(rootPlan?.packageMetadata).toEqual([]);
  });

  it("keeps resolveBoundary's swallowed manifest failure unresolved", () => {
    // The package scan meets a manifest that does not parse before the
    // destination's, so the native lookup throws and the planner treats
    // the destination as unresolved.
    const root = workspace("fold-swallowed-", {
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "packages/aaa/package.json": "{",
      "packages/src/package.json": JSON.stringify({ name: "@s/src" }),
      "packages/zzz/package.json": JSON.stringify({ name: "@s/zzz" }),
      "packages/zzz/src/index.ts": "export {};\n",
    });
    // The scan's order is the code-unit order of the names, whatever order
    // the file system lists them in, so `aaa` is always met first.
    for (const order of ["ascending", "descending"] as const) {
      guard.order = order;
      const source = resolveBoundary(root, "packages/src");
      const { native, prepared } = planBothWays(source, "@s/zzz");
      expect(prepared).toEqual(native);
      expect(prepared[0]?.destination.resolution).toBe("unresolved");
      expect(prepared[0]?.status).toBe("unsupported");
    }
  });

  it("keeps the in-operator test of manifest sections", () => {
    // `in` sees inherited names, so an empty section "declares" a package
    // named constructor, natively and from prepared sections alike.
    const root = workspace("fold-inherited-", {
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "packages/ctor/package.json": JSON.stringify({ name: "constructor" }),
      "packages/ctor/src/index.ts": "export {};\n",
      "packages/dest/package.json": JSON.stringify({
        dependencies: {},
        name: "@d/dest",
      }),
    });
    const source = resolveBoundary(root, "packages/ctor");
    const { native, prepared } = planBothWays(source, "@d/dest");
    expect(prepared).toEqual(native);
    expect(prepared[0]?.packageMetadata.map((impact) => impact.kind)).toContain(
      "consumer-dependency"
    );
  });

  it("raises malformed destination sections and references where planning does", () => {
    const root = workspace("fold-malformed-", {
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "packages/baddeps/package.json": JSON.stringify({
        dependencies: "not-an-object",
        name: "@d/baddeps",
      }),
      "packages/badrefs/package.json": JSON.stringify({ name: "@d/badrefs" }),
      "packages/badrefs/tsconfig.json": JSON.stringify({ references: {} }),
      "packages/src/package.json": JSON.stringify({ name: "@s/src" }),
      "packages/src/src/index.ts": "export {};\n",
    });
    const source = resolveBoundary(root, "packages/src");
    for (const destination of ["@d/baddeps", "@d/badrefs"]) {
      const { native, prepared } = errorsBothWays(source, destination);
      expect(native).toBeInstanceOf(TypeError);
      expect(prepared).toBeInstanceOf(TypeError);
      expect((prepared as Error).message).toBe((native as Error).message);
    }
  });

  it("keeps a walk failure until a plan inventories that package", () => {
    const root = foldWorkspace();
    const sat = resolveBoundary(root, "packages/sat");
    const host = resolveBoundary(root, "packages/host");
    mkdirSync(join(root, "packages/sat/src/locked"));
    chmodSync(join(root, "packages/sat/src/locked"), 0o000);
    // Preparing both packages succeeds; only planning sat's fold fails.
    const inputs = readFoldInputs(root, [host, sat], ["@f/host", "@f/plain"]);
    expect("error" in (inputs.sources.get(sat.dir)?.files ?? {})).toBe(true);
    expect("value" in (inputs.sources.get(host.dir)?.files ?? {})).toBe(true);
    const { native, prepared } = errorsBothWays(sat, "@f/host");
    expect((prepared as Error).message).toBe((native as Error).message);
    expect((native as NodeJS.ErrnoException).code).toBe("EACCES");
    chmodSync(join(root, "packages/sat/src/locked"), 0o755);
  });

  it("resolves the root boundary's empty short name as native does", () => {
    // An unnamed root manifest makes the source's short name empty, so
    // `src/<short name>` is `src` itself.
    const root = workspace("fold-root-name-", {
      "dest/package.json": JSON.stringify({ name: "@d/dest" }),
      "dest/src/index.ts": "export {};\n",
      "package.json": JSON.stringify({ private: true }),
    });
    const source = resolveBoundary(root, ".");
    expect(source.relPath).toBe("");
    const { native, prepared } = planBothWays(source, "dest");
    expect(prepared).toEqual(native);
    expect(prepared[0]?.destination).toMatchObject({
      directory: "src/",
      resolution: "resolved",
    });
  });

  it("refuses a source or destination it was not prepared for", () => {
    const root = foldWorkspace();
    const sat = resolveBoundary(root, "packages/sat");
    const lone = resolveBoundary(root, "libs/lone");
    const inputs = readFoldInputs(root, [sat], ["@f/host"]);
    const fold = (boundary: Boundary, destination: string) => {
      const { dependencies, opportunities } = foldInto(boundary, destination);
      return () =>
        buildFoldPlans(
          boundary,
          [],
          dependencies,
          opportunities,
          undefined,
          inputs
        );
    };
    expect(fold(lone, "@f/plain")).toThrow(
      `No prepared fold source for ${lone.dir}`
    );
    expect(fold(sat, "@f/plain")).toThrow(
      "No prepared fold destination for @f/plain"
    );
    const shortless = readFoldInputs(root, [lone], ["@f/host"]);
    const { dependencies, opportunities } = foldInto(sat, "@f/host");
    expect(() =>
      buildFoldPlans(sat, [], dependencies, opportunities, undefined, {
        ...shortless,
        sources: inputs.sources,
      })
    ).toThrow("No prepared src/sat entry for fold destination @f/host");
  });
});

describe("native derivation reads only the folds it plans", () => {
  it("reads no fold input when no package has a fold opportunity", async () => {
    // Nothing consumes `@n/solo`, so it has no primary consumer to fold into;
    // its asset and doc trees are what a needless walk would enumerate.
    const files: Record<string, string> = {
      "package.json": JSON.stringify({
        private: true,
        workspaces: ["packages/*"],
      }),
      "packages/solo/package.json": JSON.stringify({
        exports: { ".": "./src/index.ts" },
        name: "@n/solo",
      }),
      "packages/solo/src/index.ts":
        "export function twice(x: number): number {\n  return x * 2;\n}\n",
    };
    for (let index = 0; index < 5; index += 1) {
      files[`packages/solo/assets/${index}.txt`] = "asset\n";
      files[`packages/solo/docs/${index}.md`] = "doc\n";
    }
    const root = workspace("fold-none-", files);
    const locals = [analyzePackageLocal({ root, target: "packages/solo" })];
    const derived = await deriveWorkspaceSurface(locals, { now, root });
    expect(guard.foldReads).toEqual([]);
    const facts = derived.packages["packages/solo"];
    expect(facts?.plans.map((plan) => plan.operation)).not.toContain(
      "fold-package"
    );
    expect(
      facts?.opportunities.map((opportunity) => opportunity.operation)
    ).not.toContain("fold-package");
  });

  it("reads exactly each fold's source and destination, as full preparation plans", async () => {
    const root = foldWorkspace();
    const locals = FOLD_TARGETS.map((target) =>
      analyzePackageLocal({ root, target })
    );
    const derived = await deriveWorkspaceSurface(locals, { now, root });
    expect(guard.foldReads).toEqual([
      {
        destinations: ["@f/plain", "@f/host"],
        sources: ["libs/lone", "packages/sat"],
      },
    ]);
    guard.foldReads.length = 0;
    const prepared = await prepareWorkspaceDerivation(locals, { now, root });
    // Full preparation reads every package for any destination.
    expect(guard.foldReads.map((read) => read.sources)).toEqual([FOLD_TARGETS]);
    expect(comparable(analyzePreparedWorkspace(locals, prepared))).toBe(
      comparable(derived)
    );
    expect(Object.keys(foldPlans(derived))).toEqual([
      "libs/lone",
      "packages/sat",
    ]);
  });

  it("reads a file map's fold inputs only for the folds it plans", async () => {
    const files = fileMapOf(foldWorkspace());
    const folded = await analyzeFileMap({ files, now, root: "/fold-map" });
    expect(guard.foldReads).toEqual([
      {
        destinations: ["@f/plain", "@f/host"],
        sources: ["libs/lone", "packages/sat"],
      },
    ]);
    expect(Object.keys(foldPlans(folded.derivation))).toEqual([
      "libs/lone",
      "packages/sat",
    ]);
    expect(folded.timing.foldInputsMs).toBeTypeOf("number");

    guard.foldReads.length = 0;
    const solo = await analyzeFileMap({
      files: {
        "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
        "packages/solo/package.json": JSON.stringify({
          exports: { ".": "./src/index.ts" },
          name: "@n/solo",
        }),
        "packages/solo/src/index.ts": "export const solo = 1;\n",
      },
      now,
      root: "/fold-map",
    });
    expect(guard.foldReads).toEqual([]);
    expect(Object.keys(foldPlans(solo.derivation))).toEqual([]);
    expect(solo.timing.foldInputsMs).toBeTypeOf("number");
  });
});

describe("prepared fold plans in a workspace derivation", () => {
  it("derives fold plans from prepared inputs over the native project", async () => {
    const root = foldWorkspace();
    const locals = FOLD_TARGETS.map((target) =>
      analyzePackageLocal({ root, target })
    );
    const native = await deriveWorkspaceSurface(locals, { now, root });
    const prepared = await prepareWorkspaceDerivation(locals, { now, root });
    // The native project reads through ts-morph, which is not intercepted.
    const derived = blockedDuring(EVERYTHING, () =>
      analyzePreparedWorkspace(locals, prepared)
    );
    expect(guard.attempts).toEqual([]);
    expect(comparable(derived)).toBe(comparable(native));

    const plans = Object.entries(foldPlans(derived)).map(([path, plan]) => [
      path,
      plan.destination.resolution,
      plan.packageMetadata.map((impact) => impact.kind),
    ]);
    expect(plans).toEqual([
      ["libs/lone", "suggested", ["source-manifest", "workspace-entry"]],
      [
        "packages/sat",
        "resolved",
        [
          "source-manifest",
          "source-tsconfig",
          "consumer-dependency",
          "project-reference",
        ],
      ],
    ]);
  });
});
