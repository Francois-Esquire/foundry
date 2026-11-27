import { existsSync } from "node:fs";
import { isBuiltin } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  collectModuleImports,
  packageDirs,
  parseSourceFile,
  readManifest,
  resolveExportTarget,
} from "./helpers/scan";

const JS_EXT_PATTERN = /\.(?:mjs|cjs|js)$/;
const BUN_SPECIFIER_PATTERN = /^bun(?::|$)/;
const NODE_GLOBALS = new Set([
  "process",
  "Buffer",
  "Bun",
  "__dirname",
  "__filename",
  "setImmediate",
]);
const NODE_IMPORT_META = new Set(["dirname", "filename"]);

const EXTRA_WEB_STANDARD_SUBPATHS: Readonly<Record<string, readonly string[]>> =
  {
    core: ["./testing/storage"],
    models: ["./providers/gateway", "./providers/vercel"],
  };

const ALLOWED_PORTABLE_EXTERNAL_PACKAGES = new Set([
  "@ai-sdk/mcp",
  "@ai-sdk/openai-compatible",
  "@ai-sdk/provider",
  "@ai-sdk/provider-utils",
  "@ai-sdk/vercel",
  "@noble/hashes",
  "ai",
  "croner",
  "drizzle-orm",
  "effect",
  "evlog",
  "ignore",
  "just-bash",
  "vitest",
  "zod",
]);

function isOptInSubpath(subpath: string): boolean {
  if (subpath === "./testing/store") {
    return false;
  }
  return ["./node", "./providers", "./testing"].some(
    (root) => subpath === root || subpath.startsWith(`${root}/`)
  );
}

function portableSubpaths(packageDir: string): string[] {
  const { exports = {} } = readManifest(packageDir);
  return Object.keys(exports).filter((subpath) => !isOptInSubpath(subpath));
}

function splitSpecifier(specifier: string): {
  readonly name: string;
  readonly subpath: string;
} {
  const parts = specifier.split("/");
  const nameLength = specifier.startsWith("@") ? 2 : 1;
  const rest = parts.slice(nameLength).join("/");
  return {
    name: parts.slice(0, nameLength).join("/"),
    subpath: rest.length === 0 ? "." : `./${rest}`,
  };
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const stem = base.replace(JS_EXT_PATTERN, "");
  for (const candidate of [
    base,
    `${stem}.ts`,
    `${stem}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (
      existsSync(candidate) &&
      (candidate.endsWith(".ts") || candidate.endsWith(".tsx"))
    ) {
      return candidate;
    }
  }
  return null;
}

type GuardState = "defined" | "undefined";

function unwrapParens(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (ts.isParenthesizedExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

function qualifiedGlobalName(node: ts.Node): string | null {
  let name: string | null = null;
  let owner: ts.Expression | null = null;
  if (ts.isPropertyAccessExpression(node)) {
    owner = node.expression;
    name = node.name.text;
  } else if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    owner = node.expression;
    name = node.argumentExpression.text;
  }
  if (owner === null || name === null) {
    return null;
  }
  const target = unwrapParens(owner);
  return ts.isIdentifier(target) &&
    target.text === "globalThis" &&
    NODE_GLOBALS.has(name)
    ? name
    : null;
}

function importMetaName(node: ts.Node): string | null {
  return ts.isPropertyAccessExpression(node) &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    NODE_IMPORT_META.has(node.name.text)
    ? `import.meta.${node.name.text}`
    : null;
}

function isTypeofTarget(expr: ts.Expression, name: string): boolean {
  const inner = unwrapParens(expr);
  if (!ts.isTypeOfExpression(inner)) {
    return false;
  }
  const operand = unwrapParens(inner.expression);
  return ts.isIdentifier(operand)
    ? operand.text === name
    : (qualifiedGlobalName(operand) ?? importMetaName(operand)) === name;
}

function typeofComparisonState(
  expr: ts.BinaryExpression,
  name: string
): GuardState | null {
  const op = expr.operatorToken.kind;
  const isEqualOp =
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.EqualsEqualsToken;
  const isNotEqualOp =
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken;
  if (!(isEqualOp || isNotEqualOp)) {
    return null;
  }
  const left = unwrapParens(expr.left);
  const right = unwrapParens(expr.right);
  let literal: string | null = null;
  if (isTypeofTarget(left, name) && ts.isStringLiteralLike(right)) {
    literal = right.text;
  } else if (isTypeofTarget(right, name) && ts.isStringLiteralLike(left)) {
    literal = left.text;
  }
  if (literal === null) {
    return null;
  }
  if (literal === "undefined") {
    return isNotEqualOp ? "defined" : "undefined";
  }
  return isEqualOp ? "defined" : null;
}

function provesState(
  expr: ts.Expression,
  name: string,
  target: GuardState
): boolean {
  const inner = unwrapParens(expr);
  if (
    ts.isPrefixUnaryExpression(inner) &&
    inner.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return provesState(
      inner.operand,
      name,
      target === "defined" ? "undefined" : "defined"
    );
  }
  if (ts.isBinaryExpression(inner)) {
    const compared = typeofComparisonState(inner, name);
    if (compared !== null) {
      return compared === target;
    }
    if (
      target === "defined" &&
      inner.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      return (
        provesState(inner.left, name, "defined") ||
        provesState(inner.right, name, "defined")
      );
    }
    if (
      target === "undefined" &&
      inner.operatorToken.kind === ts.SyntaxKind.BarBarToken
    ) {
      return (
        provesState(inner.left, name, "undefined") &&
        provesState(inner.right, name, "undefined")
      );
    }
  }
  return false;
}

function isGuardedUse(node: ts.Node, name: string): boolean {
  let prev: ts.Node = node;
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isTypeOfExpression(cur)) {
      return true;
    }
    if (ts.isBinaryExpression(cur) && cur.right === prev) {
      if (
        cur.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        provesState(cur.left, name, "defined")
      ) {
        return true;
      }
      if (
        cur.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
        provesState(cur.left, name, "undefined")
      ) {
        return true;
      }
    }
    if (ts.isConditionalExpression(cur)) {
      if (
        cur.whenTrue === prev &&
        provesState(cur.condition, name, "defined")
      ) {
        return true;
      }
      if (
        cur.whenFalse === prev &&
        provesState(cur.condition, name, "undefined")
      ) {
        return true;
      }
    }
    if (ts.isIfStatement(cur)) {
      if (
        cur.thenStatement === prev &&
        provesState(cur.expression, name, "defined")
      ) {
        return true;
      }
      if (
        cur.elseStatement === prev &&
        provesState(cur.expression, name, "undefined")
      ) {
        return true;
      }
    }
    prev = cur;
    cur = cur.parent;
  }
  return false;
}

function isNonReferenceIdentifier(node: ts.Identifier): boolean {
  const { parent } = node;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node)
  );
}

function nodeGlobalName(node: ts.Node): string | null {
  if (ts.isIdentifier(node)) {
    return NODE_GLOBALS.has(node.text) && !isNonReferenceIdentifier(node)
      ? node.text
      : null;
  }
  return qualifiedGlobalName(node) ?? importMetaName(node);
}

function unguardedNodeGlobals(sourceFile: ts.SourceFile): string[] {
  const globals: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isTypeNode(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node)
    ) {
      return;
    }
    const name = nodeGlobalName(node);
    if (name !== null && !isGuardedUse(node, name)) {
      globals.push(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return globals;
}

function buildWorkspaceGraph(): {
  readonly optIn: ReadonlySet<string>;
  readonly workspace: ReadonlyMap<string, string>;
} {
  const workspace = new Map<string, string>();
  const optIn = new Set<string>();
  const portable = new Set<string>();

  for (const dir of packageDirs()) {
    const manifest = readManifest(dir);
    if (manifest.name?.startsWith("@foundry/")) {
      workspace.set(manifest.name, dir);
    }
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      const resolved = resolveExportTarget(target);
      if (resolved !== undefined) {
        (isOptInSubpath(subpath) ? optIn : portable).add(
          resolve(dir, resolved)
        );
      }
    }
  }

  return {
    optIn: new Set([...optIn].filter((file) => !portable.has(file))),
    workspace,
  };
}

function auditWebStandard(
  packageDir: string,
  subpaths: readonly string[],
  graph: ReturnType<typeof buildWorkspaceGraph>
): string[] {
  const manifest = readManifest(packageDir);
  const violations: string[] = [];
  const pending: string[] = [];

  for (const subpath of subpaths) {
    const target = resolveExportTarget(manifest.exports?.[subpath]);
    const entry = target ? resolve(packageDir, target) : undefined;
    if (entry && existsSync(entry)) {
      pending.push(entry);
    } else {
      violations.push(
        `${manifest.name ?? packageDir}/package.json: missing or unresolved export "${subpath}"`
      );
    }
  }

  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || visited.has(file)) {
      continue;
    }
    visited.add(file);

    const label = relative(packageDir, file).replaceAll("\\", "/");
    const sourceFile = parseSourceFile(file);

    for (const globalName of unguardedNodeGlobals(sourceFile)) {
      violations.push(`${label}: unguarded Node/Bun global "${globalName}"`);
    }

    const specifiers = collectModuleImports(sourceFile)
      .filter(({ kind, typeOnly }) => !typeOnly && kind !== "mock")
      .map(({ specifier }) => specifier);

    for (const specifier of specifiers) {
      if (specifier.startsWith("node:") || isBuiltin(specifier)) {
        violations.push(`${label}: forbidden Node built-in "${specifier}"`);
      } else if (BUN_SPECIFIER_PATTERN.test(specifier)) {
        violations.push(`${label}: forbidden Bun built-in "${specifier}"`);
      } else if (specifier.startsWith(".")) {
        const next = resolveRelative(file, specifier);
        if (next === null) {
          violations.push(
            `${label}: unresolved relative import "${specifier}"`
          );
        } else if (graph.optIn.has(next)) {
          violations.push(
            `${label}: forbidden opt-in subpath import "${specifier}"`
          );
        } else {
          pending.push(next);
        }
      } else if (isOptInSubpath(splitSpecifier(specifier).subpath)) {
        violations.push(
          `${label}: forbidden opt-in subpath import "${specifier}"`
        );
      } else if (specifier.startsWith("@foundry/")) {
        const { name, subpath } = splitSpecifier(specifier);
        const depDir = graph.workspace.get(name);
        const target = depDir
          ? resolveExportTarget(readManifest(depDir).exports?.[subpath])
          : undefined;
        const next = depDir && target ? resolve(depDir, target) : undefined;
        if (next && existsSync(next)) {
          pending.push(next);
        } else {
          violations.push(
            `${label}: unresolved workspace import "${specifier}"`
          );
        }
      } else {
        const externalName = splitSpecifier(specifier).name;
        if (!ALLOWED_PORTABLE_EXTERNAL_PACKAGES.has(externalName)) {
          violations.push(
            `${label}: unreviewed external package "${externalName}" in portable subpath`
          );
        }
      }
    }
  }

  return violations;
}

const WORKSPACE_GRAPH = buildWorkspaceGraph();
const ALL_PACKAGES = packageDirs().map((dir) => ({
  dir,
  name: basename(dir),
}));

describe("Web-standard portable exports", () => {
  it("discovers every package under packages/*", () => {
    const names = ALL_PACKAGES.map(({ name }) => name);
    expect(names).toEqual(
      expect.arrayContaining(["core", "lib", "workspaces"])
    );
    expect(names.length).toBeGreaterThanOrEqual(14);
  });

  it.each(ALL_PACKAGES)(
    "keeps every portable subpath of packages/$name Web-standard",
    ({ dir, name }) => {
      const subpaths = [
        ...new Set([
          ...portableSubpaths(dir),
          ...(EXTRA_WEB_STANDARD_SUBPATHS[name] ?? []),
        ]),
      ];
      expect(subpaths.length).toBeGreaterThan(0);
      expect(auditWebStandard(dir, subpaths, WORKSPACE_GRAPH)).toEqual([]);
    }
  );
});
