import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertExportLayout,
  assertExportNames,
  assertPackageTiers,
  assertWebStandardExports,
  auditExportLayout,
  auditExportNames,
  auditPackageTiers,
  auditWebStandardExports,
  type PackageTier,
  portableSubpaths,
} from "../testing/seam";

const LIB_DIR = resolve(import.meta.dirname, "../..");
const CORE_DIR = resolve(LIB_DIR, "../core");
const PACKAGES_DIR = resolve(LIB_DIR, "..");
const PACKAGE_NAMES = readdirSync(PACKAGES_DIR).filter((name) =>
  existsSync(join(PACKAGES_DIR, name, "package.json"))
);

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("@foundry/lib/testing/seam", () => {
  it("discovers every package under packages/*", () => {
    expect(PACKAGE_NAMES).toEqual(
      expect.arrayContaining(["core", "lib", "workspaces"])
    );
    expect(PACKAGE_NAMES.length).toBeGreaterThanOrEqual(14);
  });

  it.each(PACKAGE_NAMES)(
    "keeps every portable subpath of packages/%s Web-standard",
    (name) => {
      const packageDir = join(PACKAGES_DIR, name);
      const subpaths = portableSubpaths(packageDir);
      expect(subpaths.length).toBeGreaterThan(0);
      expect(() =>
        assertWebStandardExports(packageDir, subpaths)
      ).not.toThrow();
    }
  );

  it("keeps the @foundry/core storage conformance suite Web-standard", () => {
    expect(() =>
      assertWebStandardExports(CORE_DIR, ["./testing/storage"])
    ).not.toThrow();
  });

  it("audits conditional async-scope and turns among portable @foundry/lib subpaths", () => {
    const subpaths = portableSubpaths(LIB_DIR);
    expect(subpaths).toContain("./async-scope");
    expect(subpaths).toContain("./emitter");
    expect(subpaths).toContain("./turns");
    expect(subpaths).not.toContain("./testing/seam");
  });

  it("flags node:* imports, opt-in subpaths, and unguarded globals while ignoring typeof guards", () => {
    const dir = mkdtempSync(join(tmpdir(), "seam-audit-"));
    tempDirs.push(dir);
    writeFileSync(
      join(dir, "src-helper.ts"),
      `import { readFileSync } from "node:fs";
import { join as bareJoin } from "path";
import { thisProcess } from "@foundry/lib/node/process-identity";
export const guardedAnd = typeof process !== "undefined" && process.env.OK === "1";
export const guardedTernary = typeof process === "undefined" ? "" : process.env.OK;
export const unsafePolarity = typeof process === "undefined" && process.env.BAD === "1";
export const unsafeElse = typeof process !== "undefined" ? "" : process.env.ALSO_BAD;
export const unguarded = process.env.SECRET;
export const buf = Buffer.from("x");
export { bareJoin, readFileSync, thisProcess };
`
    );
    writeFileSync(
      join(dir, "index.ts"),
      `export * from "./src-helper";\nexport * from "./missing-file";\nexport * from "@foundry/core/does-not-exist";\n`
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        exports: {
          ".": { default: "./index.ts", import: "./index.ts" },
        },
        name: "@foundry/fake-pkg",
      })
    );

    const violations = auditWebStandardExports(dir, ["."]);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('forbidden Node built-in import "node:fs"'),
        expect.stringContaining('forbidden Node built-in import "path"'),
        expect.stringContaining(
          'forbidden opt-in subpath import "@foundry/lib/node/process-identity"'
        ),
        expect.stringContaining('unguarded Node/Bun global "process"'),
        expect.stringContaining('unguarded Node/Bun global "Buffer"'),
        expect.stringContaining('unresolved relative import "./missing-file"'),
        expect.stringContaining(
          'unresolved workspace import "@foundry/core/does-not-exist"'
        ),
      ])
    );
    expect(
      violations.filter((entry) => entry.includes('"process"'))
    ).toHaveLength(3);
    expect(() => assertWebStandardExports(dir, ["."])).toThrow(
      "Web-standard export seam violations:"
    );
  });
});

function writePackage(
  packagesDir: string,
  directory: string,
  manifest: Record<string, unknown>,
  sources: Record<string, string> = {}
): void {
  const dir = join(packagesDir, directory);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  for (const [file, content] of Object.entries(sources)) {
    mkdirSync(join(dir, "src", file, ".."), { recursive: true });
    writeFileSync(join(dir, "src", file), content);
  }
}

function tempPackages(): string {
  const root = mkdtempSync(join(tmpdir(), "seam-packages-"));
  tempDirs.push(root);
  const packagesDir = join(root, "packages");
  mkdirSync(packagesDir);
  return packagesDir;
}

const FIXTURE_TIERS: Record<string, PackageTier> = {
  "@foundry/base": "primitives",
  "@foundry/engine": "tools",
  "@foundry/feature": "domains",
};

function fixturePackage(
  exportsMap: Record<string, unknown>,
  sources: Record<string, string>
): string {
  const packagesDir = tempPackages();
  writePackage(
    packagesDir,
    "fixture",
    { exports: exportsMap, name: "@foundry/fixture" },
    sources
  );
  return join(packagesDir, "fixture");
}

function auditSource(source: string): string[] {
  const dir = fixturePackage({ ".": "./src/index.ts" }, { "index.ts": source });
  return auditWebStandardExports(dir, ["."]);
}

describe("@foundry/lib/testing/seam runtime detection", () => {
  it.each([
    "process",
    "Buffer",
    "Bun",
    "setImmediate",
    "__dirname",
    "__filename",
  ])("flags globalThis.%s", (name) => {
    for (const source of [
      `export const x = globalThis.${name};`,
      `export const x = globalThis["${name}"];`,
    ]) {
      expect(auditSource(source)).toEqual([
        `src/index.ts: unguarded Node/Bun global "${name}"`,
      ]);
    }
  });

  it.each([
    [
      "export const x = globalThis.process.pid;",
      'unguarded Node/Bun global "process"',
    ],
    [
      'export const x = require("node:fs");',
      'forbidden Node built-in import "node:fs"',
    ],
    [
      'import fs = require("node:fs");\nexport const x = fs;',
      'forbidden Node built-in import "node:fs"',
    ],
    [
      'export const x = require("bun:sqlite");',
      'forbidden Bun built-in import "bun:sqlite"',
    ],
    [
      'export const x = () => import("bun:sqlite");',
      'forbidden Bun built-in import "bun:sqlite"',
    ],
    [
      "export const x = import.meta.dirname;",
      'unguarded Node/Bun global "import.meta.dirname"',
    ],
    [
      "export const x = import.meta.filename;",
      'unguarded Node/Bun global "import.meta.filename"',
    ],
  ])("flags %s", (source, violation) => {
    expect(auditSource(source)).toEqual([`src/index.ts: ${violation}`]);
  });

  it("allows typeof-guarded globalThis access and non-import require members", () => {
    expect(
      auditSource(`export const a = typeof globalThis.process;
export const b = typeof globalThis.process !== "undefined" && globalThis.process.pid;
export const c = typeof process === "undefined" ? 0 : globalThis.process.pid;
export const d = typeof globalThis.Buffer === "undefined" ? "" : Buffer.from("x");
export const e = (store: { require: (id: string) => void }) => store.require("node:fs");
export type F = typeof import("node:fs");
export const g = import.meta.url;
`)
    ).toEqual([]);
  });

  it.each([
    "./node",
    "./node/live",
    "./providers",
    "./providers/x",
    "./testing",
    "./testing/helper",
  ])("flags a portable import of the %s opt-in subpath", (subpath) => {
    const file = `${subpath.slice(2)}.ts`;
    const dir = fixturePackage(
      { ".": "./src/index.ts", [subpath]: `./src/${file}` },
      {
        [file]: "export const x = 1;",
        "index.ts": `export * from "./${subpath.slice(2)}";`,
      }
    );
    expect(auditWebStandardExports(dir, ["."])).toEqual([
      `src/index.ts: forbidden opt-in subpath import "./${subpath.slice(2)}"`,
    ]);
    expect(
      auditSource(`export * from "@foundry/other/${subpath.slice(2)}";`)
    ).toEqual([
      `src/index.ts: forbidden opt-in subpath import "@foundry/other/${subpath.slice(2)}"`,
    ]);
  });

  it.each([
    "some-pkg/node",
    "some-pkg/node/live",
    "@scope/pkg/providers/x",
    "some-pkg/testing",
  ])("flags a portable import of third-party %s", (specifier) => {
    expect(auditSource(`export * from "${specifier}";`)).toEqual([
      `src/index.ts: forbidden opt-in subpath import "${specifier}"`,
    ]);
  });

  it("allows third-party specifiers outside the opt-in subpaths", () => {
    expect(
      auditSource(`export * from "some-pkg";
export * from "some-pkg/tree/node";
export * from "@scope/node";
export * from "some-pkg/testing/store";
`)
    ).toEqual([]);
  });

  it("follows a relative file named node.ts that no opt-in export targets", () => {
    const exportsMap = { ".": "./src/index.ts" };
    const index = 'export * from "./tree/node";';
    const clean = fixturePackage(exportsMap, {
      "index.ts": index,
      "tree/node.ts": "export const leaf = 1;",
    });
    expect(auditWebStandardExports(clean, ["."])).toEqual([]);
    const dirty = fixturePackage(exportsMap, {
      "index.ts": index,
      "tree/node.ts": "export const leaf = process.pid;",
    });
    expect(auditWebStandardExports(dirty, ["."])).toEqual([
      'src/tree/node.ts: unguarded Node/Bun global "process"',
    ]);
  });
});

describe("@foundry/lib/testing/seam package tiers", () => {
  it("classifies every package under packages/* and allows only downward, acyclic edges", () => {
    expect(() => assertPackageTiers(PACKAGES_DIR)).not.toThrow();
  });

  it("allows same-tier and downward edges, including devDependencies", () => {
    const packagesDir = tempPackages();
    writePackage(packagesDir, "base", { name: "@foundry/base" });
    writePackage(packagesDir, "engine", {
      dependencies: { "@foundry/base": "workspace:*" },
      name: "@foundry/engine",
    });
    writePackage(packagesDir, "feature", {
      dependencies: { "@foundry/engine": "workspace:*" },
      devDependencies: {
        "@foundry/base": "workspace:*",
        "@foundry/tsconfig": "workspace:*",
      },
      name: "@foundry/feature",
    });
    expect(auditPackageTiers(packagesDir, FIXTURE_TIERS)).toEqual([]);
  });

  it("flags unclassified, stale, upward, tools-to-domains, outside, and cyclic dependencies", () => {
    const packagesDir = tempPackages();
    writePackage(packagesDir, "base", {
      dependencies: { "@foundry/engine": "workspace:*" },
      name: "@foundry/base",
    });
    writePackage(packagesDir, "engine", {
      dependencies: { "@foundry/feature": "workspace:*" },
      devDependencies: { "@foundry/base": "workspace:*" },
      name: "@foundry/engine",
    });
    writePackage(packagesDir, "feature", {
      name: "@foundry/feature",
      peerDependencies: { "@foundry/app": "workspace:*" },
    });
    writePackage(packagesDir, "stray", { name: "@foundry/stray" });
    const violations = auditPackageTiers(packagesDir, {
      ...FIXTURE_TIERS,
      "@foundry/ghost": "domains",
    });
    expect(violations).toEqual(
      expect.arrayContaining([
        "@foundry/stray: not classified in PACKAGE_TIERS",
        "@foundry/ghost: classified in PACKAGE_TIERS but not found",
        "@foundry/base (primitives) must not depend on @foundry/engine (tools)",
        "@foundry/engine (tools) must not depend on @foundry/feature (domains)",
        "@foundry/feature: depends on @foundry/app outside packages/*",
        "dependency cycle: @foundry/base -> @foundry/engine -> @foundry/base",
      ])
    );
  });
});

describe("@foundry/lib/testing/seam export names", () => {
  it("finds no *Manager, *System, or InMemory* exports under packages/*", () => {
    expect(() => assertExportNames(PACKAGES_DIR)).not.toThrow();
  });

  it("flags forbidden suffixes but allows *FileSystem and ignores test sources and non-exports", () => {
    const packagesDir = tempPackages();
    writePackage(
      packagesDir,
      "fixture",
      { name: "@foundry/fixture" },
      {
        "index.ts": `export class ArtifactManager {}
export interface WorkspaceSystem {}
export type InMemoryThing = string;
export function createInMemoryStore() {}
export const { DestructuredManager } = { DestructuredManager: 1 };
export const [ArrayedSystem] = [1];
export * as NamespacedManager from "./other";
export const MemoryFooStore = 1;
export interface WorkspaceFileSystem {}
export const nodeFileSystem = 1;
class PrivateManager {}
export { PrivateManager as ExposedSystem };
`,
        "other.ts": "export const ok = 1;\n",
        "plain.js": "export class ScriptManager {}\n",
        "test/helper.ts": "export class HelperManager {}\n",
        "testing/store.ts": "export class SuiteSystem {}\n",
      }
    );
    const violations = auditExportNames(packagesDir);
    expect(violations).toHaveLength(9);
    expect(violations.join("\n")).toContain('"ArtifactManager"');
    expect(violations.join("\n")).toContain('"WorkspaceSystem"');
    expect(violations.join("\n")).toContain('"InMemoryThing"');
    expect(violations.join("\n")).toContain('"createInMemoryStore"');
    expect(violations.join("\n")).toContain('"ExposedSystem"');
    expect(violations.join("\n")).toContain('"DestructuredManager"');
    expect(violations.join("\n")).toContain('"ArrayedSystem"');
    expect(violations.join("\n")).toContain('"NamespacedManager"');
    expect(violations.join("\n")).toContain('"ScriptManager"');
  });
});

describe("@foundry/lib/testing/seam portableSubpaths", () => {
  it("excludes only ./node, ./node/*, ./providers, ./providers/*, and ./testing/* other than ./testing/store", () => {
    const dir = mkdtempSync(join(tmpdir(), "seam-subpaths-"));
    tempDirs.push(dir);
    const target = { default: "./x.ts" };
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        exports: {
          ".": target,
          "./adapters/node/helper": target,
          "./adapters/providers/x": target,
          "./live/node": target,
          "./node": target,
          "./node/live": target,
          "./provider": target,
          "./providers": target,
          "./providers/x": target,
          "./testing": target,
          "./testing/seam": target,
          "./testing/store": target,
        },
        name: "@foundry/fixture",
      })
    );
    expect(portableSubpaths(dir)).toEqual([
      ".",
      "./adapters/node/helper",
      "./adapters/providers/x",
      "./live/node",
      "./provider",
      "./testing/store",
    ]);
  });
});

describe("@foundry/lib/testing/seam export layout", () => {
  it("verifies every package under packages/* mirrors its export keys to src paths", () => {
    expect(() => assertExportLayout(PACKAGES_DIR)).not.toThrow();
  });

  it("flags non-mirroring export targets and wildcards", () => {
    const packagesDir = tempPackages();
    writePackage(
      packagesDir,
      "sample",
      {
        exports: {
          ".": { import: "./src/index.ts" },
          "./*": "./src/*.ts",
          "./foo": { import: "./src/foo/bar.ts" },
          "./ok": { import: "./src/ok.ts", types: "./dist/ok.d.ts" },
          "./ok-dir": { import: "./src/ok-dir/index.ts" },
        },
        name: "@foundry/sample",
      },
      {
        "foo/bar.ts": "",
        "index.ts": "",
        "ok-dir/index.ts": "",
        "ok.ts": "",
      }
    );
    expect(auditExportLayout(packagesDir)).toEqual([
      '@foundry/sample: wildcard export "./*"',
      '@foundry/sample: export "./foo" targets "./src/foo/bar.ts", expected ./src/foo.ts or ./src/foo/index.ts',
    ]);
  });

  it("checks every runtime condition and that each target exists", () => {
    const packagesDir = tempPackages();
    writePackage(
      packagesDir,
      "sample",
      {
        exports: {
          "./async-scope": {
            default: "./src/async-scope.ts",
            node: "./src/node/async-scope.ts",
          },
          "./gone": "./src/gone.ts",
          "./node": { default: "./src/node.ts", import: "./wrong.ts" },
          "./typed": { types: "./dist/typed.d.ts" },
        },
        name: "@foundry/sample",
      },
      { "async-scope.ts": "", "node.ts": "", "node/async-scope.ts": "" }
    );
    expect(auditExportLayout(packagesDir)).toEqual([
      '@foundry/sample: export "./async-scope" targets "./src/node/async-scope.ts", expected ./src/async-scope.ts or ./src/async-scope/index.ts',
      '@foundry/sample: export "./gone" targets missing file "./src/gone.ts"',
      '@foundry/sample: export "./node" targets "./wrong.ts", expected ./src/node.ts or ./src/node/index.ts',
      '@foundry/sample: export "./node" targets missing file "./wrong.ts"',
      '@foundry/sample: export "./typed" has no source target',
    ]);
  });

  it("permits only the @foundry/lib async-scope node and bun conditions to diverge", () => {
    const packagesDir = tempPackages();
    const conditional = {
      bun: "./src/node/async-scope.ts",
      default: "./src/async-scope.ts",
      import: "./src/node/async-scope.ts",
      node: "./src/node/async-scope.ts",
    };
    writePackage(
      packagesDir,
      "lib",
      { exports: { "./async-scope": conditional }, name: "@foundry/lib" },
      { "async-scope.ts": "", "node/async-scope.ts": "" }
    );
    expect(auditExportLayout(packagesDir)).toEqual([
      '@foundry/lib: export "./async-scope" targets "./src/node/async-scope.ts", expected ./src/async-scope.ts or ./src/async-scope/index.ts',
    ]);
  });
});
