import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertExportNames,
  assertPackageTiers,
  assertWebStandardExports,
  auditExportNames,
  auditPackageTiers,
  auditWebStandardExports,
  type PackageTier,
  portableSubpaths,
} from "../testing/seam";

const LIB_DIR = resolve(import.meta.dirname, "../..");
const CORE_DIR = resolve(LIB_DIR, "../core");
const PACKAGES_DIR = resolve(LIB_DIR, "..");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("@foundry/lib/testing/seam", () => {
  it("passes on all @foundry/core subpaths", () => {
    expect(() =>
      assertWebStandardExports(CORE_DIR, [
        "./agents",
        "./pagination",
        "./storage",
        "./testing/storage",
      ])
    ).not.toThrow();
  });

  it("passes on all portable @foundry/lib subpaths (including conditional async-scope and turns)", () => {
    const subpaths = portableSubpaths(LIB_DIR);
    expect(subpaths).toContain("./async-scope");
    expect(subpaths).toContain("./emitter");
    expect(subpaths).toContain("./turns");
    expect(subpaths).not.toContain("./testing/seam");
    expect(() => assertWebStandardExports(LIB_DIR, subpaths)).not.toThrow();
  });

  it("flags wildcard exports, node:* imports, /node subpaths, and unguarded globals while ignoring typeof guards", () => {
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
          "./*": "./*.ts",
        },
        name: "@foundry/fake-pkg",
      })
    );

    const violations = auditWebStandardExports(dir, ["."]);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('wildcard export "./*"'),
        expect.stringContaining('forbidden Node built-in import "node:fs"'),
        expect.stringContaining('forbidden Node built-in import "path"'),
        expect.stringContaining(
          'forbidden /node subpath import "@foundry/lib/node/process-identity"'
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
export const MemoryFooStore = 1;
export interface WorkspaceFileSystem {}
export const nodeFileSystem = 1;
class PrivateManager {}
export { PrivateManager as ExposedSystem };
`,
        "test/helper.ts": "export class HelperManager {}\n",
        "testing/store.ts": "export class SuiteSystem {}\n",
      }
    );
    const violations = auditExportNames(packagesDir);
    expect(violations).toHaveLength(5);
    expect(violations.join("\n")).toContain('"ArtifactManager"');
    expect(violations.join("\n")).toContain('"WorkspaceSystem"');
    expect(violations.join("\n")).toContain('"InMemoryThing"');
    expect(violations.join("\n")).toContain('"createInMemoryStore"');
    expect(violations.join("\n")).toContain('"ExposedSystem"');
  });
});
