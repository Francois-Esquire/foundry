import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { cruiseWorkspace } from "../../src/lib/dependencies";
import type { RepositoryFileMapInput } from "../../src/lib/file-map-preparation";
import {
  FileMapInputError,
  fileMapProblems,
  prepareFileMap,
} from "../../src/lib/file-map-preparation";
import type { CruisedModule } from "../../src/lib/module-graph";
import { analyzePackageLocal } from "../../src/lib/package-local";
import { analyzePreparedPackageLocal } from "../../src/lib/package-local-analysis";
import { createProject } from "../../src/lib/project";
import { discoverSemanticsUnits } from "../../src/lib/semantics-discover";
import { DEFAULT_CONFIGURATION } from "../../src/lib/spyglass-config";
import { deriveWorkspaceSurface } from "../../src/lib/workspace-derive";
import { analyzeFileMap } from "./helpers/file-map-analysis";

const ROOT = "/spyglass-file-map";
const NOW = new Date("2026-11-07T00:00:00Z");
const fixture = join(import.meta.dirname, "fixtures", "semantics");
const tempRoots: string[] = [];
const UNPARSABLE_TSCONFIG = /tsconfig "tsconfig.json" cannot be parsed/;
const INVALID_TSCONFIG =
  /^tsconfig "tsconfig\.json" is refused as native analysis refuses it: .*error TS(?:6053|6046)/s;
const INVALID_YAML = /pnpm-workspace.yaml: the file is not valid YAML/;

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { force: true, recursive: true });
  }
});

function record(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const absolute = join(current, name);
      if (statSync(absolute).isDirectory()) {
        walk(absolute);
      } else {
        files[relative(dir, absolute)] = readFileSync(absolute, "utf8");
      }
    }
  };
  walk(dir);
  return files;
}

function materialize(input: RepositoryFileMapInput): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "spyglass-file-map-")));
  tempRoots.push(root);
  for (const [rel, text] of [
    ...Object.entries(input.files),
    ...Object.entries(input.declarations ?? {}),
  ]) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const withoutRuntime = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (key, item) =>
      key === "runtimeMs" || key === "timing" ? undefined : item
    )
  );

async function nativeDerivation(
  input: RepositoryFileMapInput,
  root: string,
  targets: string[]
) {
  const extra =
    input.tsconfig === undefined ? {} : { tsconfig: input.tsconfig };
  const locals = targets.map((target) =>
    analyzePackageLocal({ root, target, ...extra })
  );
  const project = createProject(root, input.tsconfig);
  if (project.getCompilerOptions().types === undefined) {
    project.compilerOptions.set({ types: [] });
  }
  const derivation = await deriveWorkspaceSurface(locals, {
    now: input.now,
    profile: input.profile ?? "full",
    project,
    root,
    ...extra,
  });
  return { derivation, locals };
}

const TYPED: RepositoryFileMapInput = {
  declarations: {
    "node_modules/typed-dep/index.d.ts":
      "export interface Widget { id: string; size: number; }\nexport declare function makeWidget(id: string): Widget;\n",
    "node_modules/typed-dep/package.json":
      '{ "name": "typed-dep", "version": "1.0.0", "types": "index.d.ts" }\n',
  },
  files: {
    ".gitignore": "dist\nignored/\n",
    "package.json":
      '{ "name": "typed-root", "private": true, "workspaces": ["packages/*"] }\n',
    "packages/app/ignored/gen.ts": 'export const generated = "g";\n',
    "packages/app/package.json":
      '{ "name": "@t/app", "exports": { ".": "./src/index.ts" } }\n',
    "packages/app/src/alias.ts": [
      'import { recordOf, toGadget } from "~shared/index";',
      'import { makeWidget } from "typed-dep";',
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
      "export function run(): string {",
      "  const gadget: Gadget = toGadget(makeWidget(generated));",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source text holding a template literal.
      "  return `${gadget.label}${gadget.size}${viaAlias()}`;",
      "}",
      "",
    ].join("\n"),
    "packages/shared/package.json":
      '{ "name": "@t/shared", "exports": { ".": "./src/index.ts" } }\n',
    "packages/shared/src/index.ts": [
      'import type { Widget } from "typed-dep";',
      "export interface Gadget extends Widget { label: string; }",
      "export interface WidgetRecord { id: string; size: number; }",
      "export function toGadget(widget: Widget): Gadget {",
      "  return { ...widget, label: widget.id.toUpperCase() };",
      "}",
      "export function recordOf(gadget: Gadget): WidgetRecord {",
      "  return { id: gadget.id, size: gadget.size };",
      "}",
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
  },
  now: NOW,
  root: ROOT,
};

const minimal = (files: Record<string, string>): RepositoryFileMapInput => ({
  files: {
    "package.json": '{ "name": "m", "workspaces": ["packages/*"] }',
    "packages/a/package.json": '{ "name": "@m/a" }',
    "packages/a/src/index.ts": "export const a = 1;\n",
    ...files,
  },
  now: NOW,
  root: ROOT,
});

describe("file-map input contract", () => {
  it.each([
    ["../escape.ts", "traversal or unnormalized"],
    ["packages/../escape.ts", "traversal or unnormalized"],
    ["packages/./a.ts", "traversal or unnormalized"],
    ["packages//a.ts", "traversal or unnormalized"],
    ["packages/a.ts/", "traversal or unnormalized"],
    ["/etc/passwd", "is absolute"],
    ["C:/repo/a.ts", "is absolute"],
    ["packages\\a.ts", "contains a backslash"],
    ["packages/a\0.ts", "contains NUL"],
    [".git/config", "inside .git"],
    [
      "node_modules/x/index.d.ts",
      "supply dependency declarations through declarations",
    ],
    ["", "an empty path"],
  ])("refuses the file path %j", async (path, problem) => {
    const input = minimal({ [path]: "x" });
    expect(fileMapProblems(input).join("\n")).toContain(problem);
    await expect(prepareFileMap(input)).rejects.toThrow(FileMapInputError);
  });

  it.each([
    ["types/index.d.ts", "below node_modules/"],
    ["node_modules/x/index.js", "below node_modules/"],
    ["node_modules/x/../../escape.d.ts", "traversal or unnormalized"],
  ])("refuses the declaration path %j", (path, problem) => {
    const input = { ...minimal({}), declarations: { [path]: "x" } };
    expect(fileMapProblems(input).join("\n")).toContain(problem);
  });

  it("refuses collisions: case, file and directory, file and declaration", () => {
    const problems = fileMapProblems({
      ...minimal({
        "packages/a/src/Index.ts": "x",
        "packages/a/src/index.ts/x.ts": "x",
      }),
      declarations: { "package.json": "{}" },
    }).join("\n");
    expect(problems).toContain("differ only in case");
    expect(problems).toContain(
      '"packages/a/src/index.ts" is a file and a directory'
    );
    expect(problems).toContain(
      '"package.json" is both a file and a declaration'
    );
  });

  it.each([
    ["repo", "normalized POSIX absolute"],
    ["/", "normalized POSIX absolute"],
    ["/repo/", "normalized POSIX absolute"],
    ["/repo/../other", "normalized POSIX absolute"],
    ["C:\\repo", "normalized POSIX absolute"],
  ])(
    "refuses the root %j, so no Windows identity reaches POSIX paths",
    async (root, problem) => {
      expect(fileMapProblems({ ...minimal({}), root }).join("\n")).toContain(
        problem
      );
    }
  );

  it("refuses a tsconfig the map lacks or cannot parse, and an invalid clock", async () => {
    expect(
      fileMapProblems({ ...minimal({}), tsconfig: "tsconfig.json" })
    ).toContain('tsconfig "tsconfig.json" is not in the file map');
    expect(
      fileMapProblems({ ...minimal({}), now: new Date(Number.NaN) })
    ).toContain("now must be a valid Date");
    await expect(
      prepareFileMap({
        ...minimal({ "tsconfig.json": "{ compilerOptions: " }),
        tsconfig: "tsconfig.json",
      })
    ).rejects.toThrow(UNPARSABLE_TSCONFIG);
  });

  it("reports every problem at once", async () => {
    const error = await prepareFileMap({
      ...minimal({ "../a": "", "/b": "" }),
      root: "x",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FileMapInputError);
    expect((error as FileMapInputError).problems.length).toBeGreaterThanOrEqual(
      3
    );
  });
});

describe("configuration is data", () => {
  it("never executes config modules and lists them as inert", async () => {
    const marker = "__spyglassFileMapExecuted";
    const result = await analyzeFileMap(
      minimal({
        "packages/a/package.json": JSON.stringify({
          name: "@m/a",
          scripts: { postinstall: `node -e "globalThis.${marker}=true"` },
        }),
        "packages/a/vite.config.ts": `(globalThis as Record<string, unknown>).${marker} = true;\nexport default {};\n`,
      })
    );
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
    expect(result.capabilities.configuration).toMatchObject({
      configModules: ["packages/a/vite.config.ts"],
      executed: false,
    });

    expect(result.locals[0]?.sources.map((source) => source.path)).toEqual([
      "packages/a/src/index.ts",
    ]);
  });

  it("refuses an explicit tsconfig native analysis refuses, and reports an unused root tsconfig", async () => {
    for (const config of [
      { extends: "@org/base/tsconfig.json" },
      { compilerOptions: { moduleResolution: "INVALID" } },
    ]) {
      const error = await prepareFileMap({
        ...minimal({ "tsconfig.json": JSON.stringify(config) }),
        tsconfig: "tsconfig.json",
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(FileMapInputError);
      expect((error as FileMapInputError).problems).toEqual([
        expect.stringMatching(INVALID_TSCONFIG),
      ]);
    }
    const unused = await analyzeFileMap(minimal({ "tsconfig.json": "{}" }));
    expect(unused.capabilities.configuration).toMatchObject({
      tsconfig: null,
      unusedRootTsconfig: true,
    });
  });

  it("reads pnpm-workspace.yaml as data and refuses invalid YAML explicitly", async () => {
    const pnpm = await prepareFileMap({
      files: {
        "libs/x/package.json": '{ "name": "@p/x" }',
        "libs/x/src/index.ts": "export const x = 1;\n",
        "package.json": '{ "name": "p" }',
        "pnpm-workspace.yaml": "packages:\n  - libs/*\n",
      },
      now: NOW,
      root: ROOT,
    });
    expect(pnpm.targets).toEqual(["libs/x"]);
    await expect(
      prepareFileMap({
        files: {
          "package.json": "{}",
          "pnpm-workspace.yaml": "packages: [unclosed",
        },
        now: NOW,
        root: ROOT,
      })
    ).rejects.toThrow(INVALID_YAML);
  });
});

describe("types and resolution from the map only", () => {
  it("resolves types through supplied declarations and both alias sets, and cruises as natively", async () => {
    const result = await analyzeFileMap({
      ...TYPED,
      tsconfig: "tsconfig.json",
    });
    const { capabilities, prepared } = result;
    expect(capabilities.types).toMatchObject({
      diagnostics: [],
      suppliedDeclarations: [
        "node_modules/typed-dep/index.d.ts",
        "node_modules/typed-dep/package.json",
      ],
      typesOption: [],
      typesOptionSource: "policy-empty",
      unresolvedPackages: [],
    });

    expect(capabilities.moduleGraph.unresolved).toEqual([
      { from: "packages/app/src/index.ts", specifier: "@t/shared" },
    ]);
    const app = prepared.prepared.moduleGraph.modules.find(
      (mod) => mod.source === "packages/app/src/index.ts"
    );

    expect(
      app?.dependencies
        .filter((dep) => !dep.couldNotResolve)
        .map((dep) => dep.resolved)
    ).toEqual(["packages/app/ignored/gen.ts", "packages/app/src/alias.ts"]);
    expect(
      prepared.prepared.moduleGraph.ignored.get("packages/app/ignored/gen.ts")
    ).toBe(true);

    const programFiles = prepared.prepared.project
      .getProgram()
      .compilerObject.getSourceFiles()
      .map((file) => file.fileName);
    const outside = programFiles.filter(
      (file) =>
        !(
          file.startsWith(`${ROOT}/`) ||
          file.startsWith("/node_modules/typescript/lib/")
        )
    );
    expect(outside).toEqual([]);
    expect(programFiles).toContain(`${ROOT}/node_modules/typed-dep/index.d.ts`);
    expect(programFiles.some((file) => file.includes("@types"))).toBe(false);
  });

  it("reports missing external types and an unresolved alias instead of hiding them", async () => {
    const { "node_modules/typed-dep/index.d.ts": _dropped, ...declarations } =
      TYPED.declarations ?? {};
    const result = await analyzeFileMap({ ...TYPED, declarations });
    expect(result.capabilities.types.unresolvedPackages).toEqual([
      "typed-dep",
      "~shared/index",
    ]);
    expect(result.capabilities.moduleGraph.unresolved).toContainEqual({
      from: "packages/app/src/alias.ts",
      specifier: "typed-dep",
    });
    expect(Object.keys(result.derivation.packages)).toEqual([
      "packages/app",
      "packages/shared",
    ]);
  });

  it("reports a package a supplied declaration imports but the map lacks", async () => {
    const result = await analyzeFileMap({
      ...minimal({
        "packages/a/src/uses-foo.ts":
          'import type { Foo } from "foo";\nexport const foo = (value: Foo) => value;\n',
      }),
      declarations: {
        "node_modules/foo/index.d.ts":
          'import type { Missing } from "bar";\nexport type Foo = Missing;\n',
        "node_modules/foo/package.json": JSON.stringify({
          name: "foo",
          types: "index.d.ts",
        }),
      },
    });
    expect(result.capabilities.types.diagnostics).toEqual([]);
    expect(result.capabilities.types.unresolvedPackages).toEqual(["bar"]);
  });

  it.each([
    [
      "a relative import",
      'import type { Bar } from "./absent";\nexport type Foo = Bar;\n',
      "TS2307: Cannot find module './absent' from 'node_modules/foo/index.d.ts'.",
    ],
    [
      "a triple-slash path reference",
      '/// <reference path="./absent.d.ts" />\nexport type Foo = Missing;\n',
      "TS6053: File 'node_modules/foo/absent.d.ts' referenced from 'node_modules/foo/index.d.ts' not found.",
    ],
  ])(
    "diagnoses %s a supplied declaration makes to a file the map lacks",
    async (_label, declaration, diagnostic) => {
      const result = await analyzeFileMap({
        ...minimal({
          "packages/a/src/uses-foo.ts":
            'import type { Foo } from "foo";\nexport const foo = (value: Foo) => value;\n',
        }),
        declarations: {
          "node_modules/foo/index.d.ts": declaration,
          "node_modules/foo/package.json": JSON.stringify({
            name: "foo",
            types: "index.d.ts",
          }),
        },
      });
      expect(result.capabilities.types.diagnostics).toEqual([diagnostic]);
      expect(result.capabilities.types.unresolvedPackages).toEqual([]);
    }
  );

  it("diagnoses no relative import a wildcard ambient module covers", async () => {
    const result = await analyzeFileMap({
      ...minimal({
        "packages/a/src/uses-foo.ts":
          'import type { Foo } from "foo";\nexport const foo = (value: Foo) => value;\n',
      }),
      declarations: {
        "node_modules/foo/ambient.d.ts":
          'declare module "*.css" { const value: string; export default value; }\n',
        "node_modules/foo/index.d.ts": [
          '/// <reference path="./ambient.d.ts" />',
          '/// <reference path="./absent.d.ts" />',
          'import style from "./theme.css";',
          'import type { Bar } from "./absent";',
          "export type Foo = typeof style | Bar;",
          "",
        ].join("\n"),
        "node_modules/foo/package.json": JSON.stringify({
          name: "foo",
          types: "index.d.ts",
        }),
      },
    });
    expect(result.capabilities.types.diagnostics).toEqual([
      "TS2307: Cannot find module './absent' from 'node_modules/foo/index.d.ts'.",
      "TS6053: File 'node_modules/foo/absent.d.ts' referenced from 'node_modules/foo/index.d.ts' not found.",
    ]);
    expect(result.capabilities.types.unresolvedPackages).toEqual([]);
  });

  it("diagnoses no relative reference a supplied declaration resolves", async () => {
    const result = await analyzeFileMap({
      ...minimal({
        "packages/a/src/uses-foo.ts":
          'import type { Foo } from "foo";\nexport const foo = (value: Foo) => value;\n',
      }),
      declarations: {
        "node_modules/foo/bar.d.ts": "export type Bar = 1;\n",
        "node_modules/foo/globals.d.ts": "declare const g: 1;\n",
        "node_modules/foo/index.d.ts":
          '/// <reference path="./globals.d.ts" />\n/// <reference path="globals" />\nimport type { Bar } from "./bar";\nexport type Foo = Bar;\n',
        "node_modules/foo/package.json": JSON.stringify({
          name: "foo",
          types: "index.d.ts",
        }),
      },
    });
    expect(result.capabilities.types.diagnostics).toEqual([]);
  });

  it("does not report a package a supplied declaration declares as an ambient module", async () => {
    const result = await analyzeFileMap({
      ...minimal({
        "packages/a/src/uses-foo.ts":
          'import type { Foo } from "foo";\nexport const foo = (value: Foo) => value;\n',
      }),
      declarations: {
        "node_modules/foo/ambient.d.ts":
          'declare module "bar" { export type Missing = 1; }\n',
        "node_modules/foo/index.d.ts":
          '/// <reference path="./ambient.d.ts" />\nimport type { Missing } from "bar";\nexport type Foo = Missing;\n',
        "node_modules/foo/package.json": JSON.stringify({
          name: "foo",
          types: "index.d.ts",
        }),
      },
    });
    expect(result.capabilities.types.unresolvedPackages).toEqual([]);
  });

  it("keeps a declared types entry and diagnoses its missing declaration", async () => {
    const result = await analyzeFileMap({
      ...minimal({
        "tsconfig.json": JSON.stringify({
          compilerOptions: { types: ["node"] },
        }),
      }),
      tsconfig: "tsconfig.json",
    });
    expect(result.capabilities.types.typesOption).toEqual(["node"]);
    expect(result.capabilities.types.typesOptionSource).toBe("tsconfig");
    expect(result.capabilities.types.diagnostics.join("\n")).toContain(
      "TS2688: Cannot find type definition file for 'node'."
    );
  });

  it("classifies edges as dependency-cruiser does", async () => {
    const targets = Object.fromEntries(
      ["a", "b", "c", "d", "e", "f", "g"].map((name) => [
        `packages/a/src/${name}.ts`,
        "export type T = 1;\nexport const v = 1;\n",
      ])
    );
    const input = minimal({
      ...targets,
      "packages/a/src/u.ts": [
        'import type { T } from "./a";',
        'import { type T as T2 } from "./b";',
        'import { type T as T4, v } from "./c";',
        'export type { T as T3 } from "./d";',
        'export const lazy = () => import("./e");',
        'export type Q = import("./f").T;',

        'import type { T as T5 } from "./a";',
        'import { v as v2 } from "./a";',
        'export { v as v3 } from "./g";',
        'import "./missing";',
        "",
      ].join("\n"),
    });
    const result = await prepareFileMap(input);
    const sourceOf = (modules: CruisedModule[]) =>
      modules.find((mod) => mod.source === "packages/a/src/u.ts");
    const u = sourceOf(result.prepared.moduleGraph.modules);
    expect(u).toEqual(sourceOf(await cruiseWorkspace(materialize(input))));

    expect(
      u?.dependencies
        .filter((dep) => dep.dependencyTypes.includes("type-only"))
        .map((dep) => dep.resolved)
        .sort()
    ).toEqual([
      "packages/a/src/a.ts",
      "packages/a/src/b.ts",
      "packages/a/src/d.ts",
    ]);
    expect(result.capabilities.moduleGraph.unresolved).toEqual([
      { from: "packages/a/src/u.ts", specifier: "./missing" },
    ]);
  }, 60_000);
});

describe("history, roots and native parity", () => {
  it("reports Git history as unavailable, never as empty", async () => {
    const full = await prepareFileMap(minimal({}));
    expect(full.prepared.history).toEqual({
      analyzedAt: NOW.toISOString(),
      available: false,
      reason: "not-git-repository",
      root: ROOT,
    });
    expect(full.capabilities.history.available).toBe(false);
    const temporal = await prepareFileMap({
      ...minimal({}),
      profile: "temporal",
    });
    expect(temporal.prepared.history).toMatchObject({
      reason: "not-collected",
    });
  });

  it("gives the same result under another virtual root", async () => {
    const input = { files: record(fixture), now: NOW, root: ROOT };
    const one = await analyzeFileMap(input);
    const other = await analyzeFileMap({ ...input, root: "/elsewhere/repo" });
    expect(
      JSON.stringify(withoutRuntime(other.derivation)).replaceAll(
        "/elsewhere/repo",
        ROOT
      )
    ).toBe(JSON.stringify(withoutRuntime(one.derivation)));
  });

  it("equals native preparation of the semantics fixture on disk", async () => {
    const input = { files: record(fixture), now: NOW, root: ROOT };
    const root = materialize(input);
    const fileMap = await analyzeFileMap({ ...input, root });

    expect(fileMap.prepared.targets).toEqual([
      "apps/a",
      "packages/b",
      "tooling/c",
    ]);
    expect(fileMap.prepared.discovery).toEqual(
      discoverSemanticsUnits(root, DEFAULT_CONFIGURATION)
    );
    const native = await nativeDerivation(
      input,
      root,
      fileMap.prepared.targets
    );
    expect(withoutRuntime(fileMap.locals)).toEqual(
      withoutRuntime(native.locals)
    );
    expect(withoutRuntime(fileMap.derivation)).toEqual(
      withoutRuntime(native.derivation)
    );
  }, 120_000);

  it("defers a package source's owner error to package-local analysis, as natively", async () => {
    const input: RepositoryFileMapInput = {
      files: {
        "package.json": JSON.stringify({
          private: true,
          workspaces: ["packages/*"],
        }),
        "packages/a/package.json": JSON.stringify({
          exports: "./src/nested/index.ts",
          name: "@fixture/a",
          private: true,
        }),
        "packages/a/src/nested/index.ts":
          "export function twice(x: number) { return x * 2; }\n",
        "packages/a/src/nested/package.json": "{broken",
      },
      now: NOW,
      root: ROOT,
    };
    const root = materialize(input);
    const prepared = await prepareFileMap({ ...input, root });
    const [local] = prepared.locals;
    if (local === undefined) {
      throw new Error("the map's package was not prepared");
    }
    expect(local.files.map((file) => "ownerError" in file)).toEqual([true]);
    expect(withoutRuntime(analyzePreparedPackageLocal(local))).toEqual(
      withoutRuntime(analyzePackageLocal({ root, target: "packages/a" }))
    );
  }, 60_000);

  it("equals native preparation of the typed workspace under its tsconfig, edges included", async () => {
    const input = { ...TYPED, tsconfig: "tsconfig.json" };
    const root = materialize(input);
    const fileMap = await analyzeFileMap({ ...input, root });
    const native = await nativeDerivation(
      input,
      root,
      fileMap.prepared.targets
    );
    expect(withoutRuntime(fileMap.locals)).toEqual(
      withoutRuntime(native.locals)
    );
    expect(withoutRuntime(fileMap.derivation)).toEqual(
      withoutRuntime(native.derivation)
    );

    expect(
      fileMap.derivation.packages["packages/app"]?.dependencies.outgoing.map(
        (dep) => [
          dep.package,
          dep.modules.map((edge) => `${edge.fromFile} -> ${edge.toFile}`),
        ]
      )
    ).toEqual([
      [
        "@t/shared",
        ["packages/app/src/alias.ts -> packages/shared/src/index.ts"],
      ],
    ]);
  }, 120_000);
});

describe("the module graph is the native cruise of the same bytes", () => {
  const solo = {
    "package.json": JSON.stringify({ name: "solo" }),
    "src/index.ts": "export const value = 1;\n",
    "src/legacy.js": 'module.exports = require("./index");\n',
  };
  const excluded = {
    "build/out.cjs": "module.exports = 1;\n",
    "dist/generated.js": "module.exports = 1;\n",
    "src/nested/dist/bundle.mjs": "export default 1;\n",
    "vitest.config.js": "module.exports = {};\n",
  };
  const workspace = {
    "package.json": JSON.stringify({
      name: "workspace",
      workspaces: ["packages/a"],
    }),
    "packages/a/dist/index.js": "module.exports = 1;\n",
    "packages/a/eslint.config.mjs": "export default [];\n",
    "packages/a/package.json": JSON.stringify({ name: "a" }),
    "packages/a/src/index.ts": "export const value = 1;\n",
    "packages/a/src/legacy.js": "module.exports = 3;\n",
    "packages/ab/src/legacy.js": "module.exports = 3;\n",
  };

  const forms = {
    ...TYPED.files,
    "packages/app/src/forms.ts": [
      '/// <reference types="typed-dep" />',
      'import "./side";',
      'import type { Gadget } from "@t/shared";',
      'import fs from "node:fs";',
      'import legacy = require("./legacy-cjs");',
      'export { helper } from "./nested/helper.js";',
      'export type { WidgetRecord } from "~shared/index";',
      'const lazy = () => import("./lazy");',
      'const required = require("./required");',
      'type Tool = typeof import("~shared/index");',
      'const missing = require("does-not-exist");',
      "export const all = [fs, legacy, lazy, required, missing] as unknown as Gadget[] & Tool[];",
      "",
    ].join("\n"),
    "packages/app/src/lazy.ts": "export const lazy = 1;\n",
    "packages/app/src/legacy-cjs.ts": "export = { legacy: true };\n",
    "packages/app/src/nested/helper.ts": "export const helper = 2;\n",
    "packages/app/src/required.ts": "module.exports = 5;\n",
    "packages/app/src/side.ts": "export {};\n",
    "packages/app/src/unimported.js":
      'const forms = require("./forms");\nimport("./lazy");\nmodule.exports = { forms };\n',
    "packages/shared/src/cjs-only.cjs":
      'module.exports = require("./esm-only.mjs");\n',
    "packages/shared/src/esm-only.mjs":
      'export { toGadget } from "./index.ts";\n',
  };
  const fileMapGraph = async (input: RepositoryFileMapInput) =>
    (await prepareFileMap(input)).prepared.moduleGraph.modules;
  const nativeGraph = async (input: RepositoryFileMapInput) =>
    await cruiseWorkspace(materialize(input), input.tsconfig);

  it.each([
    [
      "a standalone package with scripts and excluded files",
      { ...solo, ...excluded },
    ],
    ["a workspace with script modules outside its packages", workspace],
  ])(
    "matches for %s",
    async (_label, files) => {
      const input = { files, now: NOW, root: ROOT };
      expect(await fileMapGraph(input)).toEqual(await nativeGraph(input));
    },
    60_000
  );

  it.each([
    ["the synthesized workspace aliases", undefined],
    [
      "the tsconfig, which native cruising does not merge with workspace aliases",
      "tsconfig.json",
    ],
  ])(
    "matches every import form under %s",
    async (_label, tsconfig) => {
      const input: RepositoryFileMapInput = {
        ...TYPED,
        files: forms,
        ...(tsconfig !== undefined && { tsconfig }),
      };
      const graph = await fileMapGraph(input);
      expect(graph).toEqual(await nativeGraph(input));
      expect(graph.map((mod) => mod.source)).toEqual(
        expect.arrayContaining([
          "packages/app/src/unimported.js",
          "packages/shared/src/cjs-only.cjs",
          "packages/shared/src/esm-only.mjs",
        ])
      );
    },
    60_000
  );

  it("reports what the cruise could not resolve", async () => {
    const { capabilities } = await prepareFileMap({
      ...TYPED,
      files: forms,
    });
    expect(capabilities.moduleGraph.source).toBe("dependency-cruiser");
    expect(capabilities.moduleGraph.unresolved).toEqual(
      expect.arrayContaining([
        { from: "packages/app/src/forms.ts", specifier: "does-not-exist" },
      ])
    );
  }, 60_000);
});
