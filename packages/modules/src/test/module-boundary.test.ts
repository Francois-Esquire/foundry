import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createSourceFile,
  forEachChild,
  type ImportClause,
  isCallExpression,
  isExportDeclaration,
  isImportDeclaration,
  isNamedExports,
  isNamedImports,
  isStringLiteralLike,
  type Node,
  ScriptTarget,
  SyntaxKind,
} from "typescript";
import { describe, expect, it } from "vitest";

import {
  isModuleAllowedImport,
  MODULE_ALLOWED_PACKAGE_IMPORTS,
  MODULE_FORBIDDEN_VOCABULARY,
  MODULE_NODE_ALLOWED_PACKAGE_IMPORTS,
  MODULE_NOUNS,
  MODULE_PLATFORM_ALLOWED_PACKAGE_IMPORTS,
} from "../boundary";

const MODULES_SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(MODULES_SRC, "../../..");
const PROGRAM_SUPERVISOR_SRC = join(
  MODULES_SRC,
  "platform/program-supervisor.ts"
);
const TARGET_ROOTS = [MODULES_SRC] as const;
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const TEST_OR_STORY_FILE = /\.(?:test|stories)\.(?:ts|tsx)$/u;
const TEST_DIRECTORY = /\/(?:tests|test|testing)\//u;
const GUEST_SOURCE_DIRECTORY = /\/(?:sdk|template)\//u;
const NODE_OR_GUEST_SOURCE_DIRECTORY = /\/(?:node|sdk|template)\//u;
const NODE_ADAPTER_SPECIFIER = /(?:^|\/)node(?:\/|$)/u;

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  if (statSync(root).isFile()) {
    return SOURCE_EXTENSIONS.has(extname(root)) ? [root] : [];
  }
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined) {
      continue;
    }
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (["dist", "node_modules", ".cache", ".turbo"].includes(entry.name)) {
        continue;
      }
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
      } else if (
        statSync(child).isFile() &&
        SOURCE_EXTENSIONS.has(extname(child))
      ) {
        files.push(child);
      }
    }
  }
  return files.sort();
}

/**
 * Production source under the import boundary. `sdk/emit.ts` is the build-time
 * SDK compiler script: no runtime module imports it, so its compiler and
 * filesystem imports stay off the runtime graph.
 */
function targetSourceFiles(): string[] {
  return TARGET_ROOTS.flatMap(sourceFiles).filter((path) => {
    const relativePath = relative(MODULES_SRC, path);
    return (
      !(
        relativePath.startsWith("test/") || relativePath.startsWith("testing/")
      ) &&
      relativePath !== "boundary.ts" &&
      relativePath !== "sdk/emit.ts"
    );
  });
}

function productionSourceFiles(root: string): string[] {
  return sourceFiles(root).filter(
    (path) => !(TEST_OR_STORY_FILE.test(path) || TEST_DIRECTORY.test(path))
  );
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const expression =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/g;
  for (const match of source.matchAll(expression)) {
    const [, specifier] = match;
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

interface ModuleImport {
  readonly specifier: string;
  /** Erased at compile time: `import type`, or every named binding `type`-qualified. */
  readonly typeOnly: boolean;
}

/**
 * Every static import, re-export, and literal dynamic import in `path`, read
 * from its syntax tree so specifiers inside emitted source strings don't count.
 */
function moduleImports(path: string): ModuleImport[] {
  const source = createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ScriptTarget.Latest,
    true
  );
  const imports: ModuleImport[] = [];
  const visit = (node: Node): void => {
    if (
      isImportDeclaration(node) &&
      isStringLiteralLike(node.moduleSpecifier)
    ) {
      imports.push({
        specifier: node.moduleSpecifier.text,
        typeOnly: isTypeOnlyImportClause(node.importClause),
      });
    } else if (
      isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      isStringLiteralLike(node.moduleSpecifier)
    ) {
      const clause = node.exportClause;
      imports.push({
        specifier: node.moduleSpecifier.text,
        typeOnly:
          node.isTypeOnly ||
          (clause !== undefined &&
            isNamedExports(clause) &&
            clause.elements.length > 0 &&
            clause.elements.every((element) => element.isTypeOnly)),
      });
    } else if (
      isCallExpression(node) &&
      node.expression.kind === SyntaxKind.ImportKeyword
    ) {
      const [argument] = node.arguments;
      if (argument !== undefined && isStringLiteralLike(argument)) {
        imports.push({ specifier: argument.text, typeOnly: false });
      }
    }
    forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

function isTypeOnlyImportClause(clause: ImportClause | undefined): boolean {
  if (clause === undefined) {
    return false;
  }
  if (clause.phaseModifier === SyntaxKind.TypeKeyword) {
    return true;
  }
  if (clause.name !== undefined) {
    return false;
  }
  const bindings = clause.namedBindings;
  return (
    bindings !== undefined &&
    isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

describe("Modules boundary", () => {
  it("names only the target durable vocabulary", () => {
    expect(MODULE_NOUNS).toEqual([
      "Module",
      "Artifact",
      "Version",
      "Installation",
      "Program",
      "ModuleGateway",
      "Capability",
      "Grant",
      "Binding",
      "Invocation",
    ]);
  });

  it("allows Artifact, storage contracts, shared utilities, and local seams", () => {
    expect(MODULE_ALLOWED_PACKAGE_IMPORTS).toEqual([
      "@foundry/artifacts",
      "@foundry/core/storage",
      "@foundry/core/pagination",
      "@foundry/lib/digest",
      "@foundry/lib/encoding",
      "@foundry/lib/json",
      "@foundry/lib/ordering",
      "@foundry/lib/pagination",
      "node:async_hooks",
      "typescript",
      "zod",
    ]);
    for (const specifier of MODULE_ALLOWED_PACKAGE_IMPORTS) {
      expect(isModuleAllowedImport(specifier)).toBe(true);
    }
    expect(
      isModuleAllowedImport("./domain", join(MODULES_SRC, "management.ts"))
    ).toBe(true);
    expect(
      isModuleAllowedImport("../domain", join(MODULES_SRC, "gateway/types.ts"))
    ).toBe(true);
    // A relative specifier resolves against its importer; with none, it can't.
    expect(isModuleAllowedImport("./domain")).toBe(false);
    expect(
      isModuleAllowedImport("../legacy/module", join(MODULES_SRC, "domain.ts"))
    ).toBe(false);
    expect(isModuleAllowedImport("@foundry/agents")).toBe(false);
    expect(isModuleAllowedImport("@foundry/models")).toBe(false);
    expect(isModuleAllowedImport("@foundry/workflows")).toBe(false);
    expect(isModuleAllowedImport("@foundry/workspaces")).toBe(false);
  });

  it("admits platform's Sandbox type sources by exact specifier only", () => {
    const platformFile = join(MODULES_SRC, "platform/container-runtime.ts");
    expect(MODULE_PLATFORM_ALLOWED_PACKAGE_IMPORTS).toEqual([
      "@foundry/sandbox/container/constraints",
      "@foundry/sandbox/container/containers",
      "@foundry/sandbox/container/types",
    ]);
    for (const specifier of MODULE_PLATFORM_ALLOWED_PACKAGE_IMPORTS) {
      expect(isModuleAllowedImport(specifier)).toBe(false);
      expect(
        isModuleAllowedImport(specifier, join(MODULES_SRC, "domain.ts"))
      ).toBe(false);
      expect(isModuleAllowedImport(specifier, platformFile)).toBe(true);
      expect(isModuleAllowedImport(`${specifier}/nested`, platformFile)).toBe(
        false
      );
    }
    for (const specifier of [
      "@foundry/sandbox",
      "@foundry/sandbox/container",
      "@foundry/sandbox/container/microsandbox-runtime",
      "@foundry/sandbox/container/store",
      "@foundry/sandbox/testing",
      "@foundry/sandbox/types",
    ]) {
      expect(isModuleAllowedImport(specifier, platformFile)).toBe(false);
    }
  });

  it("admits every production import through the boundary allowlist", () => {
    const violations = targetSourceFiles().flatMap((path) =>
      moduleImports(path)
        .filter(({ specifier }) => !isModuleAllowedImport(specifier, path))
        .map(
          ({ specifier }) => `${relative(REPO_ROOT, path)} imports ${specifier}`
        )
    );
    expect(violations).toEqual([]);
  });

  it("keeps platform's Sandbox imports type-only", () => {
    const violations = targetSourceFiles()
      .filter((path) => relative(MODULES_SRC, path).startsWith("platform/"))
      .flatMap((path) =>
        moduleImports(path)
          .filter(({ specifier }) => specifier.startsWith("@foundry/sandbox"))
          .filter(({ typeOnly }) => !typeOnly)
          .map(
            ({ specifier }) =>
              `${relative(REPO_ROOT, path)} imports a value from ${specifier}`
          )
      );
    expect(violations).toEqual([]);
  });

  it("confines filesystem access to the Node entry", () => {
    expect(MODULE_NODE_ALLOWED_PACKAGE_IMPORTS).toEqual([
      "node:events",
      "node:crypto",
      "node:fs/promises",
      "node:path",
    ]);
    for (const specifier of MODULE_NODE_ALLOWED_PACKAGE_IMPORTS) {
      expect(isModuleAllowedImport(specifier)).toBe(false);
      expect(
        isModuleAllowedImport(
          specifier,
          "/repo/packages/modules/src/node/checkouts.ts"
        )
      ).toBe(true);
    }
    // The SDK and Template carry guest source as text; their `node:` imports
    // belong to the generated Module, not to this package's runtime.
    const violations = targetSourceFiles()
      .filter((path) => !GUEST_SOURCE_DIRECTORY.test(path))
      .flatMap((path) =>
        importSpecifiers(readFileSync(path, "utf8"))
          .filter((specifier) => specifier.startsWith("node:"))
          .filter((specifier) => !isModuleAllowedImport(specifier, path))
          .map(
            (specifier) => `${relative(REPO_ROOT, path)} imports ${specifier}`
          )
      );
    expect(violations).toEqual([]);
  });

  it("publishes deep source paths through one wildcard and no role barrels", () => {
    const packageJson = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/modules/package.json"), "utf8")
    ) as { exports: Record<string, unknown> };
    expect(Object.keys(packageJson.exports).sort()).toEqual([
      "./*",
      "./package.json",
    ]);
    const barrels = [
      "index.ts",
      "gateway/index.ts",
      "node/index.ts",
      "platform/index.ts",
      "template/index.ts",
      "testing/index.ts",
    ].filter((path) => existsSync(join(MODULES_SRC, path)));
    expect(barrels).toEqual([]);
  });

  it("keeps portable filesystem contracts independent of Node adapters", () => {
    const violations = targetSourceFiles()
      .filter((path) => !NODE_OR_GUEST_SOURCE_DIRECTORY.test(path))
      .flatMap((path) =>
        importSpecifiers(readFileSync(path, "utf8"))
          .filter((specifier) => NODE_ADAPTER_SPECIFIER.test(specifier))
          .map(
            (specifier) => `${relative(REPO_ROOT, path)} imports ${specifier}`
          )
      );
    expect(violations).toEqual([]);
  });

  it("keeps reset target paths free of retired module vocabulary", () => {
    const violations = targetSourceFiles().flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return MODULE_FORBIDDEN_VOCABULARY.filter((term) =>
        new RegExp(`\\b${term}\\b`).test(source)
      ).map((term) => `${relative(REPO_ROOT, path)} contains ${term}`);
    });
    expect(violations).toEqual([]);
  });

  it("keeps one active-Program registry in the supervisor", () => {
    const supervisor = readFileSync(PROGRAM_SUPERVISOR_SRC, "utf8");
    expect(
      supervisor.match(/new Map<InstallationId, ActiveRecord>\(\)/g)
    ).toHaveLength(1);
  });

  it("loads the microsandbox package only in its VM adapter", () => {
    const adapter = "packages/sandbox/src/container/microsandbox-runtime.ts";
    // Type-only imports are erased at compile time, so they never load it.
    const violations = productionSourceFiles(
      join(REPO_ROOT, "packages")
    ).flatMap((path) =>
      moduleImports(path)
        .filter(
          ({ specifier, typeOnly }) => specifier === "microsandbox" && !typeOnly
        )
        .filter(() => relative(REPO_ROOT, path) !== adapter)
        .map(
          () =>
            `${relative(REPO_ROOT, path)} imports microsandbox outside ${adapter}`
        )
    );
    expect(violations).toEqual([]);
  });
});
