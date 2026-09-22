import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const SANDBOX_SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");

export const REPO_ROOT = resolve(SANDBOX_SRC, "../../..");

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

const SKIP_DIRS = new Set([
  "dist",
  "node_modules",
  ".cache",
  ".turbo",
  "out",
  "storybook-static",
]);

export function sourceFiles(root: string): string[] {
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
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
      } else if (SOURCE_EXTENSIONS.has(extname(child))) {
        files.push(child);
      }
    }
  }
  return files.sort();
}

function repoRelative(path: string): string {
  return relative(REPO_ROOT, path).replaceAll("\\", "/");
}

export interface ParsedImport {
  readonly line: number;
  readonly specifier: string;
  readonly typeOnly: boolean;
}

/**
 * Import and re-export specifiers parsed from the AST, so comment mentions of a
 * specifier are never matched and `import type` versus value is exact.
 */
export function parseImports(path: string, source: string): ParsedImport[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const imports: ParsedImport[] = [];
  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
    1;

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.importClause;
      const namedTypeOnly =
        clause?.namedBindings !== undefined &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((element) => element.isTypeOnly);
      imports.push({
        line: lineOf(node),
        specifier: node.moduleSpecifier.text,
        typeOnly:
          clause !== undefined &&
          (clause.phaseModifier === ts.SyntaxKind.TypeKeyword ||
            (clause.name === undefined && namedTypeOnly)),
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push({
        line: lineOf(node),
        specifier: node.moduleSpecifier.text,
        typeOnly: node.isTypeOnly,
      });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const [argument] = node.arguments;
      if (argument !== undefined && ts.isStringLiteralLike(argument)) {
        imports.push({
          line: lineOf(node),
          specifier: argument.text,
          typeOnly: false,
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return imports;
}

export interface ImportSite {
  readonly import: ParsedImport;
  readonly path: string;
  readonly relativePath: string;
}

/**
 * Every parsed import site across a file set, as repo-relative sites the rules
 * can filter and name in a failure message.
 */
export function importSites(files: readonly string[]): ImportSite[] {
  return files.flatMap((path) => {
    const relativePath = repoRelative(path);
    return parseImports(relativePath, readFileSync(path, "utf8")).map(
      (parsed) => ({ import: parsed, path, relativePath })
    );
  });
}

export interface Manifest {
  readonly dependencyNames: ReadonlySet<string>;
  readonly name: string;
  readonly path: string;
  readonly relativePath: string;
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export function readManifest(path: string): Manifest {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    name?: string;
  } & Partial<
    Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>
  >;
  const dependencyNames = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(parsed[field] ?? {})) {
      dependencyNames.add(name);
    }
  }
  return {
    dependencyNames,
    name: parsed.name ?? "",
    path,
    relativePath: repoRelative(path),
  };
}
