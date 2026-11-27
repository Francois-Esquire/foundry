import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  PACKAGES_DIR,
  packageDirs,
  parseSourceFile,
  readManifest,
  sourceFiles,
} from "./helpers/scan";

const PERMITTED_CONDITIONAL_TARGETS: Readonly<Record<string, string>> = {
  "@foundry/lib ./async-scope bun": "./src/node/async-scope.ts",
  "@foundry/lib ./async-scope node": "./src/node/async-scope.ts",
};

const DECLARATION_FILE_PATTERN = /\.d\.[cm]?ts$/;
const NON_PUBLIC_SOURCE_DIRS = ["node_modules", "test", "testing"];

const FORBIDDEN_EXPORT_NAMES = [
  { pattern: /Manager$/, reason: "*Manager is reserved for apps/*" },
  {
    pattern: /(?<!File)System$/,
    reason: "*System obscures depth (only *FileSystem is allowed)",
  },
  { pattern: /InMemory/, reason: "name in-memory adapters Memory*" },
] as const;

interface ConditionalTarget {
  readonly condition: string;
  readonly target: string;
}

function runtimeTargets(value: unknown, condition = ""): ConditionalTarget[] {
  if (typeof value === "string") {
    return [{ condition, target: value }];
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value)
    .filter(([key]) => key !== "types")
    .flatMap(([key, nested]) =>
      runtimeTargets(nested, condition ? `${condition}.${key}` : key)
    );
}

function mirroredTargets(subpath: string): string[] {
  return subpath === "."
    ? ["./src/index.ts"]
    : [`./src/${subpath.slice(2)}.ts`, `./src/${subpath.slice(2)}/index.ts`];
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? bindingNames(element.name) : []
  );
}

function exportedNames(sourceFile: ts.SourceFile): string[] {
  return sourceFile.statements.flatMap((statement) => {
    if (ts.isExportDeclaration(statement)) {
      const { exportClause } = statement;
      if (exportClause && ts.isNamedExports(exportClause)) {
        return exportClause.elements.map((element) => element.name.text);
      }
      return exportClause && ts.isNamespaceExport(exportClause)
        ? [exportClause.name.text]
        : [];
    }
    const isExported =
      ts.canHaveModifiers(statement) &&
      (ts.getModifiers(statement) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
      );
    if (!isExported) {
      return [];
    }
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.flatMap((declaration) =>
        bindingNames(declaration.name)
      );
    }
    if (
      ts.isClassDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      return statement.name ? [statement.name.text] : [];
    }
    return [];
  });
}

describe("package export layout and naming", () => {
  it("mirrors every packages/* export key to its src path with no wildcards", () => {
    const violations: string[] = [];
    for (const dir of packageDirs()) {
      const manifest = readManifest(dir);
      const label = manifest.name ?? relative(PACKAGES_DIR, dir);
      for (const [subpath, value] of Object.entries(manifest.exports ?? {})) {
        if (subpath.includes("*")) {
          violations.push(`${label}: wildcard export "${subpath}"`);
          continue;
        }
        const targets = runtimeTargets(value);
        if (targets.length === 0) {
          violations.push(`${label}: export "${subpath}" has no source target`);
          continue;
        }
        for (const { condition, target } of targets) {
          const permitted =
            PERMITTED_CONDITIONAL_TARGETS[`${label} ${subpath} ${condition}`];
          const expected = permitted ? [permitted] : mirroredTargets(subpath);
          if (!expected.includes(target)) {
            violations.push(
              `${label}: export "${subpath}" targets "${target}", expected ${expected.join(" or ")}`
            );
          }
          if (!existsSync(resolve(dir, target))) {
            violations.push(
              `${label}: export "${subpath}" targets missing file "${target}"`
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("forbids *Manager, *System (except *FileSystem), and InMemory* exports under packages/*", () => {
    const violations: string[] = [];
    for (const dir of packageDirs()) {
      const srcDir = join(dir, "src");
      if (!existsSync(srcDir)) {
        continue;
      }
      const files = sourceFiles(srcDir, {
        skipDirs: NON_PUBLIC_SOURCE_DIRS,
      }).filter((file) => !DECLARATION_FILE_PATTERN.test(file));
      for (const file of files) {
        for (const name of exportedNames(parseSourceFile(file))) {
          for (const { pattern, reason } of FORBIDDEN_EXPORT_NAMES) {
            if (pattern.test(name)) {
              const label = relative(PACKAGES_DIR, file).replaceAll("\\", "/");
              violations.push(`${label}: exported name "${name}": ${reason}`);
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
