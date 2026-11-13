import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ownerBoundary,
  snapshotDirectoryOwnership,
} from "../../src/lib/boundary";
import { analyzePackageLocal } from "../../src/lib/package-local";
import type { PackageLocalReport } from "../../src/lib/package-local-types";
import { createProject } from "../../src/lib/project";
import type { AnalysisProfile } from "../../src/lib/types";
import type { PreparedWorkspaceDerivation } from "../../src/lib/workspace-analysis";
import { analyzePreparedWorkspace } from "../../src/lib/workspace-analysis";
import {
  deriveWorkspaceSurface,
  prepareWorkspaceDerivation,
} from "../../src/lib/workspace-derive";
import type { WorkspaceSurfaceDerivation } from "../../src/lib/workspace-derive-types";

// Workspace derivation over prepared native inputs. Preparation resolves
// boundaries and entrypoints, builds the shared program, cruises the module
// graph, answers its gitignore and ownership questions, reads Git history
// and reads fold planning's inputs. Analysis must take those answers from
// the prepared value alone.
// The module-level lookup caches would hide a disk read after preparation,
// so the native functions are intercepted instead: once preparation is
// done, any call to a blocked one is recorded and fails the test, even
// where a caller catches its error.
//
// The fixture runs in place, so its Git history comes from the enclosing
// checkout; that is what exercises the history owner lookups.
//
// By default the shared project is not prepared source: it is a native
// ts-morph program on the real file system that keeps tsconfig settings and
// installed dependency types. The typed workspace below checks that both
// still shape the derived facts.

const guard = vi.hoisted(() => {
  const blocked = new Set<string>();
  const attempts: string[] = [];
  const calls: { args: unknown[]; name: string }[] = [];
  return {
    attempts,
    blocked,
    calls,
    wrap<A extends unknown[], R>(
      name: string,
      fn: (...args: A) => R
    ): (...args: A) => R {
      return (...args: A) => {
        calls.push({ args, name });
        if (blocked.has(name)) {
          attempts.push(name);
          throw new Error(`${name} called after preparation`);
        }
        return fn(...args);
      };
    },
  };
});

/** Directories read through `node:fs` `readdirSync` by project modules. */
const listed = vi.hoisted(() => [] as string[]);

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  const readdirSync = ((...args: Parameters<typeof original.readdirSync>) => {
    listed.push(String(args[0]));
    return original.readdirSync(...args);
  }) as typeof original.readdirSync;
  return { ...original, default: { ...original, readdirSync }, readdirSync };
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
vi.mock("../../src/lib/ignore", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/lib/ignore")>();
  return {
    ...original,
    createIgnorer: guard.wrap("createIgnorer", original.createIgnorer),
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

/** Every native lookup the prepared value replaces. */
const ALL_PREPARED = [
  "boundaryEntrypoints",
  "collectGitHistory",
  "createIgnorer",
  "createProject",
  "cruiseWorkspace",
  "ownerBoundary",
  "resolveBoundary",
  "snapshotDirectoryOwnership",
  "workspacePatterns",
];

const fixture = join(import.meta.dirname, "fixtures", "semantics");
const now = new Date("2026-11-07T00:00:00Z");
const tempRoots: string[] = [];

beforeEach(() => {
  guard.blocked.clear();
  guard.attempts.length = 0;
  guard.calls.length = 0;
  listed.length = 0;
});

afterAll(() => {
  for (const dir of tempRoots) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/** The derivation without its timing or the recentering run times. */
function comparable(derivation: WorkspaceSurfaceDerivation): string {
  return JSON.stringify({ ...derivation, timing: undefined }, (key, value) =>
    key === "runtimeMs" ? undefined : value
  );
}

function localsOf(
  root: string,
  targets: string[],
  tsconfig?: string
): PackageLocalReport[] {
  return targets.map((target) =>
    analyzePackageLocal({
      root,
      target,
      ...(tsconfig !== undefined && { tsconfig }),
    })
  );
}

/**
 * Native preparation tabled owners without walking the root's directories:
 * no directory snapshot was read or prepared.
 */
function expectNoDirectoryCensus(prepared: PreparedWorkspaceDerivation): void {
  expect(prepared.directories).toBeUndefined();
  expect(guard.calls.map((call) => call.name)).not.toContain(
    "snapshotDirectoryOwnership"
  );
  expect(prepared.owners.size).toBeGreaterThan(0);
}

/** Analyze with the named native lookups blocked, collecting any attempt. */
function analyzeBlocked(
  blocked: readonly string[],
  run: () => WorkspaceSurfaceDerivation
): WorkspaceSurfaceDerivation {
  for (const name of blocked) {
    guard.blocked.add(name);
  }
  try {
    return run();
  } finally {
    guard.blocked.clear();
  }
}

function git(dir: string, args: string[], date: string): void {
  execFileSync("git", args, {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    stdio: "ignore",
  });
}

function commit(dir: string, date: string): void {
  git(dir, ["add", "-A"], date);
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
    date
  );
}

/**
 * Two packages with Git history. `@t/shared` extends an interface declared
 * only in an installed dependency's types; `@t/app` imports it through the
 * package name, through a root tsconfig path alias and imports a gitignored
 * generated file that itself consumes `@t/shared`. No dependency is installed by a package manager.
 */
function typedWorkspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workspace-prepared-")));
  tempRoots.push(root);
  const files: Record<string, string> = {
    ".gitignore": "dist\nignored/\nnode_modules\n",
    "node_modules/typed-dep/index.d.ts": [
      "export interface Widget { id: string; size: number; }",
      "export declare function makeWidget(id: string): Widget;",
      "",
    ].join("\n"),
    "node_modules/typed-dep/package.json": JSON.stringify({
      name: "typed-dep",
      types: "index.d.ts",
      version: "1.0.0",
    }),
    "package.json": JSON.stringify({
      name: "typed-root",
      private: true,
      workspaces: ["packages/*"],
    }),
    "packages/app/ignored/gen.ts": [
      'import { unusedShared } from "@t/shared";',
      "export const generated = String(unusedShared);",
      "",
    ].join("\n"),
    "packages/app/package.json": JSON.stringify({
      dependencies: { "@t/shared": "workspace:*", "typed-dep": "1.0.0" },
      exports: { ".": "./src/index.ts" },
      name: "@t/app",
    }),
    "packages/app/src/alias.ts": [
      'import { recordOf, toGadget } from "~shared/index";',
      'import { makeWidget } from "typed-dep";',
      "",
      "export function viaAlias(): number {",
      '  return recordOf(toGadget(makeWidget("b"))).size;',
      "}",
      "",
    ].join("\n"),
    "packages/app/src/index.ts": [
      'import { type Gadget, toGadget } from "@t/shared";',
      'import { makeWidget } from "typed-dep";',
      'import { generated } from "../ignored/gen";',
      'import { viaAlias } from "./alias";',
      "",
      "export function run(): string {",
      "  const gadget: Gadget = toGadget(makeWidget(generated));",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source text
      "  return `${gadget.label}${gadget.size}${viaAlias()}`;",
      "}",
      "",
    ].join("\n"),
    "packages/shared/package.json": JSON.stringify({
      dependencies: { "typed-dep": "1.0.0" },
      exports: { ".": "./src/index.ts" },
      name: "@t/shared",
    }),
    "packages/shared/src/index.ts": [
      'import type { Widget } from "typed-dep";',
      "",
      "export interface Gadget extends Widget {",
      "  label: string;",
      "}",
      "",
      "export interface WidgetRecord {",
      "  id: string;",
      "  size: number;",
      "}",
      "",
      "export function toGadget(widget: Widget): Gadget {",
      "  return { ...widget, label: widget.id.toUpperCase() };",
      "}",
      "",
      "export function recordOf(gadget: Gadget): WidgetRecord {",
      "  return { id: gadget.id, size: gadget.size };",
      "}",
      "",
      "export const unusedShared = 1;",
      "",
    ].join("\n"),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        module: "ESNext",
        moduleResolution: "Bundler",
        paths: { "~shared/*": ["packages/shared/src/*"] },
        strict: true,
        target: "ES2022",
      },
    }),
  };
  for (const [file, content] of Object.entries(files)) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  git(root, ["init", "-q"], "2026-10-01T00:00:00Z");
  commit(root, "2026-10-01T00:00:00Z");
  writeFileSync(
    join(root, "packages/shared/src/index.ts"),
    `${files["packages/shared/src/index.ts"]}export const later = 2;\n`
  );
  commit(root, "2026-10-15T00:00:00Z");
  return root;
}

/**
 * Consumers of `@t/shared` that only the compiler discovers, lazily, while
 * analysis resolves `@t/app`'s imports: each is excluded from the project
 * glob and the cruise (a `*.config.ts`, a test fixture, a declaration file)
 * and is created after the last commit, so it is neither a project source,
 * a cruised path nor a Git-tracked file when preparation tables owners.
 * Their native owners differ: a nested fixture manifest outside the
 * workspace patterns folds into `@t/app`, an unanalyzed workspace member
 * owns its own file, an unnamed member is named by its path, and a file
 * directly below the root belongs to `<root>`. One is imported relatively
 * through an in-root symbolic link, which TypeScript does not realpath, so
 * the program spells it through the link.
 */
const LATE_CONSUMERS: Record<string, string> = {
  "late.config.ts": "<root>",
  "packages/app/app.config.ts": "@t/app",
  "packages/app/src/linked/use.config.ts": "@t/app",
  "packages/app/src/shim.d.ts": "@t/app",
  "packages/app/test/fixtures/phantom/use.ts": "@t/app",
  "packages/extra/extra.config.ts": "@t/extra",
  "packages/unnamed/unnamed.config.ts": "packages/unnamed",
};
const LINKED_CONSUMER = "packages/app/src/linked/use.config.ts";

function lateWorkspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workspace-late-")));
  tempRoots.push(root);
  const write = (files: Record<string, string>) => {
    for (const [file, content] of Object.entries(files)) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  };
  write({
    "package.json": JSON.stringify({
      name: "late-root",
      private: true,
      workspaces: ["packages/*"],
    }),
    "packages/app/package.json": JSON.stringify({
      exports: { ".": "./src/index.ts" },
      name: "@t/app",
    }),
    "packages/app/src/index.ts": [
      'import { fromRoot } from "../../../late.config";',
      'import { fromExtra } from "../../extra/extra.config";',
      'import { fromUnnamed } from "../../unnamed/unnamed.config";',
      'import { fromConfig } from "../app.config";',
      'import { fromFixture } from "../test/fixtures/phantom/use";',
      'import { fromLinked } from "./linked/use.config";',
      'import type { Shimmed } from "./shim";',
      "",
      "export const total: Shimmed =",
      "  fromRoot + fromExtra + fromUnnamed + fromConfig + fromFixture + fromLinked;",
      "",
    ].join("\n"),
    "packages/extra/package.json": JSON.stringify({ name: "@t/extra" }),
    "packages/shared/package.json": JSON.stringify({
      exports: { ".": "./src/index.ts" },
      name: "@t/shared",
    }),
    "packages/shared/src/index.ts": [
      "export const lateShared = 1;",
      "export type LateType = number;",
      "",
    ].join("\n"),
    "packages/unnamed/package.json": JSON.stringify({ private: true }),
  });
  git(root, ["init", "-q"], "2026-10-01T00:00:00Z");
  commit(root, "2026-10-01T00:00:00Z");
  const consume = (name: string) =>
    `import { lateShared } from "@t/shared";\nexport const ${name} = lateShared;\n`;
  write({
    "late.config.ts": consume("fromRoot"),
    "packages/app/app.config.ts": consume("fromConfig"),
    "packages/app/src/shim.d.ts":
      'import type { LateType } from "@t/shared";\nexport type Shimmed = LateType;\n',
    "packages/app/test/fixtures/linked-target/use.config.ts":
      consume("fromLinked"),
    "packages/app/test/fixtures/phantom/package.json": JSON.stringify({
      name: "phantom",
    }),
    "packages/app/test/fixtures/phantom/use.ts": consume("fromFixture"),
    "packages/extra/extra.config.ts": consume("fromExtra"),
    "packages/unnamed/unnamed.config.ts": consume("fromUnnamed"),
  });
  symlinkSync(
    "../test/fixtures/linked-target",
    join(root, "packages/app/src/linked")
  );
  return root;
}

describe("prepared workspace derivation", () => {
  const fixtureTargets = [
    "apps/a",
    "packages/b",
    "packages/docs-only",
    "packages/loose",
    "tooling/c",
  ];

  it.each(["full", "temporal"] satisfies AnalysisProfile[])(
    "reproduces the %s fixture derivation without native lookups",
    async (profile) => {
      const locals = localsOf(fixture, fixtureTargets);
      const prepared = await prepareWorkspaceDerivation(locals, {
        now,
        profile,
        root: fixture,
      });
      expectNoDirectoryCensus(prepared);
      const derived = analyzeBlocked(ALL_PREPARED, () =>
        analyzePreparedWorkspace(locals, prepared)
      );
      expect(guard.attempts).toEqual([]);
      const native = await deriveWorkspaceSurface(locals, {
        now,
        profile,
        root: fixture,
      });
      expect(comparable(derived)).toBe(comparable(native));
      expect(Object.keys(derived.packages)).toEqual(fixtureTargets);
    }
  );

  it("keeps installed types, tsconfig paths, gitignore and Git history", async () => {
    const root = typedWorkspace();
    const targets = ["packages/app", "packages/shared"];
    const locals = localsOf(root, targets, "tsconfig.json");
    guard.calls.length = 0;
    const prepared = await prepareWorkspaceDerivation(locals, {
      now,
      root,
      tsconfig: "tsconfig.json",
    });
    const forwarded = guard.calls
      .filter(
        (call) =>
          call.name === "createProject" || call.name === "cruiseWorkspace"
      )
      .map((call) => [call.name, ...call.args]);
    expect(forwarded).toEqual([
      ["createProject", root, "tsconfig.json"],
      ["cruiseWorkspace", root, "tsconfig.json"],
    ]);

    // The installed declaration is not enumerated by preparation: the
    // program loads it from disk when analysis first type-checks.
    expect(
      prepared.moduleGraph.ignored.get("packages/app/ignored/gen.ts")
    ).toBe(true);
    expect(prepared.history.available).toBe(true);
    expectNoDirectoryCensus(prepared);

    const derived = analyzeBlocked(ALL_PREPARED, () =>
      analyzePreparedWorkspace(locals, prepared)
    );
    expect(guard.attempts).toEqual([]);
    const native = await deriveWorkspaceSurface(locals, {
      now,
      root,
      tsconfig: "tsconfig.json",
    });
    expect(comparable(derived)).toBe(comparable(native));

    const shared = derived.packages["packages/shared"];
    // Gadget gains id and size only through the installed Widget type.
    expect(
      shared?.conceptOverlap.candidates.flatMap((candidate) =>
        candidate.conversions.map((conversion) => conversion.function)
      )
    ).toEqual(["recordOf"]);
    // recordOf is imported only through the root tsconfig's path alias.
    expect(shared?.usage).toMatchObject({
      "packages/shared/src/index.ts#recordOf": {
        consumerModules: ["packages/app/src/alias.ts"],
      },
    });
    // A gitignored generated consumer is still loaded by the program and
    // keeps the owner the native lookup gives it.
    expect(shared?.usage).toMatchObject({
      "packages/shared/src/index.ts#unusedShared": {
        consumerModuleUsage: expect.arrayContaining([
          {
            importSites: 1,
            module: "packages/app/ignored/gen.ts",
            package: "@t/app",
            references: 1,
          },
        ]),
      },
    });
    expect(shared?.churn.available).toBe(true);
  });

  it("owns compiler-discovered consumers outside the project, cruise and Git", async () => {
    const root = lateWorkspace();
    const targets = ["packages/app", "packages/shared"];
    const locals = localsOf(root, targets);
    guard.calls.length = 0;
    const prepared = await prepareWorkspaceDerivation(locals, { now, root });
    expectNoDirectoryCensus(prepared);
    const sources = new Set(
      prepared.project
        .getSourceFiles()
        .map((file): string => file.getFilePath())
    );
    const tracked = new Set(
      prepared.history.available ? prepared.history.trackedFiles : []
    );
    for (const [file, owner] of Object.entries(LATE_CONSUMERS)) {
      const absolute = join(root, file);
      // Not a project source, cruised path or tracked file: preparation
      // owns it because the program loads it.
      expect(sources.has(absolute)).toBe(false);
      expect(prepared.moduleGraph.ignored.has(file)).toBe(false);
      expect(tracked.has(file)).toBe(false);
      expect(ownerBoundary(root, absolute)).toBe(owner);
      expect(prepared.owners.get(absolute)).toBe(owner);
    }

    const derived = analyzeBlocked(ALL_PREPARED, () =>
      analyzePreparedWorkspace(locals, prepared)
    );
    expect(guard.attempts).toEqual([]);
    const owners = Object.fromEntries(
      Object.values(derived.packages)
        .filter((facts) => facts.path === "packages/shared")
        .flatMap((facts) => Object.values(facts.usage))
        .flatMap((symbol) =>
          symbol.consumerModuleUsage.map((entry) => [
            entry.module,
            entry.package,
          ])
        )
    );
    expect(owners).toEqual(LATE_CONSUMERS);
    // The linked spelling is tabled as the program spells it.
    expect(prepared.owners.get(join(root, LINKED_CONSUMER))).toBe("@t/app");
  });

  it("reuses a supplied project instead of creating one", async () => {
    const root = typedWorkspace();
    const locals = localsOf(root, ["packages/app", "packages/shared"]);
    const project = createProject(root, "tsconfig.json");
    guard.calls.length = 0;
    const prepared = await prepareWorkspaceDerivation(locals, {
      now,
      project,
      root,
      tsconfig: "tsconfig.json",
    });
    expect(prepared.project).toBe(project);
    expect(guard.calls.map((call) => call.name)).not.toContain("createProject");
    const supplied = analyzePreparedWorkspace(locals, prepared);
    const created = await deriveWorkspaceSurface(locals, {
      now,
      root,
      tsconfig: "tsconfig.json",
    });
    expect(comparable(supplied)).toBe(comparable(created));
  });

  it("fails on an uncovered owner, gitignore verdict or boundary", async () => {
    const locals = localsOf(fixture, fixtureTargets);
    const prepared = await prepareWorkspaceDerivation(locals, {
      now,
      root: fixture,
    });
    const realFixture = realpathSync(fixture);
    const consumer = join(realFixture, "apps/a/src/index.ts");
    expect(prepared.owners.has(consumer)).toBe(true);
    expect(prepared.moduleGraph.ignored.has("apps/a/src/index.ts")).toBe(true);

    // Native preparation prepares no directory verdicts, so a file analysis
    // asks about without a tabled owner fails rather than guessing.
    const owners = new Map(prepared.owners);
    owners.delete(consumer);
    expect(() =>
      analyzePreparedWorkspace(locals, { ...prepared, owners })
    ).toThrow(`No prepared owner for ${consumer}`);

    // A deferred lookup error is raised, as itself, where analysis asks.
    const deferred = new SyntaxError("deferred manifest error");
    expect(() =>
      analyzePreparedWorkspace(locals, {
        ...prepared,
        ownerErrors: new Map([[consumer, deferred]]),
        owners,
      })
    ).toThrow(deferred);

    // Supplied directory verdicts (file-map preparation's fallback) answer
    // an untabled file, refuse one below an unwalked directory and must be
    // for the prepared root.
    const directories = snapshotDirectoryOwnership(realFixture);
    expect(
      comparable(
        analyzePreparedWorkspace(locals, { ...prepared, directories, owners })
      )
    ).toBe(comparable(analyzePreparedWorkspace(locals, prepared)));
    const unwalked = new Set(directories.unwalked);
    unwalked.add(join(realFixture, "apps/a/src"));
    expect(() =>
      analyzePreparedWorkspace(locals, {
        ...prepared,
        directories: { ...directories, unwalked },
        owners,
      })
    ).toThrow(
      `No prepared directory ownership for ${consumer}: ${join(realFixture, "apps/a/src")} was not walked`
    );
    expect(() =>
      analyzePreparedWorkspace(locals, {
        ...prepared,
        directories: { ...directories, root: dirname(realFixture) },
      })
    ).toThrow(
      `prepared directory ownership is for ${dirname(realFixture)}, not ${realFixture}`
    );

    const ignored = new Map(prepared.moduleGraph.ignored);
    ignored.delete("apps/a/src/index.ts");
    expect(() =>
      analyzePreparedWorkspace(locals, {
        ...prepared,
        moduleGraph: { ...prepared.moduleGraph, ignored },
      })
    ).toThrow("No prepared gitignore verdict for apps/a/src/index.ts");

    expect(() =>
      analyzePreparedWorkspace(locals, {
        ...prepared,
        packages: prepared.packages.slice(1),
      })
    ).toThrow("prepared 4 boundaries for 5 local reports");
  });
});

describe("native preparation reads only the ownership analysis needs", () => {
  const BROKEN = "{ not json";

  /**
   * One analyzed member, `@t/a`, committed `at` with `extra` files beside
   * it, in a fresh repository.
   */
  function workspaceWith(
    extra: Record<string, string>,
    at = "2026-10-15T00:00:00Z"
  ): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "workspace-owned-")));
    tempRoots.push(root);
    const files: Record<string, string> = {
      "package.json": JSON.stringify({
        name: "root",
        private: true,
        workspaces: ["packages/*"],
      }),
      "packages/a/package.json": JSON.stringify({ name: "@t/a" }),
      "packages/a/src/index.ts": "export const a = 1;\n",
      ...extra,
    };
    for (const [file, content] of Object.entries(files)) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    git(root, ["init", "-q"], at);
    commit(root, at);
    return root;
  }

  /** The message the native lookup throws for the BROKEN manifest. */
  function parseMessage(): string {
    try {
      JSON.parse(BROKEN);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("BROKEN parsed");
  }

  async function deriveBlocked(root: string) {
    const locals = localsOf(root, ["packages/a"]);
    const prepared = await prepareWorkspaceDerivation(locals, { now, root });
    expectNoDirectoryCensus(prepared);
    const derived = analyzeBlocked(ALL_PREPARED, () =>
      analyzePreparedWorkspace(locals, prepared)
    );
    expect(guard.attempts).toEqual([]);
    return { derived, prepared };
  }

  it("ignores a malformed manifest only an old tracked file reaches", async () => {
    // Committed outside the history window: no eligible commit names it.
    const root = workspaceWith(
      { "examples/broken/package.json": BROKEN },
      "2015-01-01T00:00:00Z"
    );
    const { derived, prepared } = await deriveBlocked(root);
    expect(Object.keys(derived.packages)).toEqual(["packages/a"]);
    const broken = join(root, "examples/broken/package.json");
    expect(prepared.owners.has(broken)).toBe(false);
    expect((prepared.ownerErrors.get(broken) as Error).message).toBe(
      parseMessage()
    );
  });

  it("does not own tracked files in excluded directories", async () => {
    const root = workspaceWith({ "dist/broken/package.json": BROKEN });
    const { derived, prepared } = await deriveBlocked(root);
    expect(Object.keys(derived.packages)).toEqual(["packages/a"]);
    const broken = join(root, "dist/broken/package.json");
    expect(prepared.owners.has(broken)).toBe(false);
    expect(prepared.ownerErrors.has(broken)).toBe(false);
  });

  it("defers a cruised gitignored module's malformed manifest", async () => {
    const root = workspaceWith({
      ".gitignore": "gen/\n",
      "packages/a/gen/package.json": BROKEN,
      "packages/a/gen/y.ts": "export const g = 1;\n",
    });
    const { derived, prepared } = await deriveBlocked(root);
    expect(Object.keys(derived.packages)).toEqual(["packages/a"]);
    expect(prepared.moduleGraph.ignored.get("packages/a/gen/y.ts")).toBe(true);
    expect(
      (prepared.ownerErrors.get(join(root, "packages/a/gen/y.ts")) as Error)
        .message
    ).toBe(parseMessage());
  });

  it("raises a malformed manifest an eligible recent commit needs, in analysis", async () => {
    const root = workspaceWith({ "test/fixtures/broken/package.json": BROKEN });
    const broken = join(root, "test/fixtures/broken/package.json");
    expect(() => ownerBoundary(root, broken)).toThrow(parseMessage());
    const locals = localsOf(root, ["packages/a"]);
    const prepared = await prepareWorkspaceDerivation(locals, { now, root });
    expect(() =>
      analyzeBlocked(ALL_PREPARED, () =>
        analyzePreparedWorkspace(locals, prepared)
      )
    ).toThrow(parseMessage());
    expect(guard.attempts).toEqual([]);
    await expect(deriveWorkspaceSurface(locals, { now, root })).rejects.toThrow(
      parseMessage()
    );
  });

  it("does not enumerate unrelated ignored trees", async () => {
    const sentinels = [
      ".worktrees/stale/deep/er",
      ".cache/shots/run/frames",
    ] as const;
    const root = workspaceWith({
      ".gitignore": ".worktrees/\n.cache/\n",
      ...Object.fromEntries(
        sentinels.map((dir) => [`${dir}/package.json`, BROKEN])
      ),
    });
    const inSentinels = () =>
      listed.filter((dir) =>
        [".worktrees", ".cache"].some((name) =>
          dir.startsWith(join(root, name))
        )
      );
    const { prepared } = await deriveBlocked(root);
    expect(prepared.history.available).toBe(true);
    expect(inSentinels()).toEqual([]);
    // The recorder sees the walk the old preparation ran.
    snapshotDirectoryOwnership(root);
    expect(inSentinels()).toContain(join(root, ".worktrees/stale/deep/er"));
  });
});
