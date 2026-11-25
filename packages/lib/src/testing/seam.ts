import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const NODE_GLOBALS = new Set([
  "process",
  "Buffer",
  "Bun",
  "__dirname",
  "__filename",
  "setImmediate",
]);
const JS_EXT_PATTERN = /\.(?:mjs|cjs|js)$/;

interface PackageManifest {
  readonly exports?: Record<string, unknown>;
  readonly name?: string;
}

function readManifest(packageDir: string): PackageManifest {
  return JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8")
  ) as PackageManifest;
}

function resolveExportTarget(target: unknown): string | undefined {
  if (typeof target === "string") {
    return target;
  }
  if (typeof target === "object" && target !== null) {
    const record = target as Record<string, unknown>;
    return (
      resolveExportTarget(record.default) ?? resolveExportTarget(record.import)
    );
  }
  return undefined;
}

function workspacePackages(startDir: string): Map<string, string> {
  const packages = new Map<string, string>();
  let dir = resolve(startDir);
  for (;;) {
    const packagesDir = join(dir, "packages");
    if (existsSync(packagesDir)) {
      loadWorkspacePackages(packagesDir, packages);
      return packages;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return packages;
    }
    dir = parent;
  }
}

function loadWorkspacePackages(
  packagesDir: string,
  out: Map<string, string>
): void {
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pkgDir = join(packagesDir, entry.name);
    if (!existsSync(join(pkgDir, "package.json"))) {
      continue;
    }
    const { name } = readManifest(pkgDir);
    if (name?.startsWith("@foundry/")) {
      out.set(name, pkgDir);
    }
  }
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

function isNodeSubpath(specifier: string): boolean {
  return (
    specifier === "./node" ||
    specifier.startsWith("./node/") ||
    specifier.endsWith("/node") ||
    specifier.includes("/node/")
  );
}

function hasTypeofGuard(expr: ts.Expression, name: string): boolean {
  let guarded = false;
  const walk = (node: ts.Node): void => {
    if (guarded) {
      return;
    }
    if (
      ts.isTypeOfExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      guarded = true;
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(expr);
  return guarded;
}

function isGuardedBranch(cur: ts.Node, prev: ts.Node, name: string): boolean {
  if (ts.isTypeOfExpression(cur)) {
    return true;
  }
  if (
    ts.isBinaryExpression(cur) &&
    (cur.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      cur.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return cur.right === prev && hasTypeofGuard(cur.left, name);
  }
  if (ts.isConditionalExpression(cur)) {
    return cur.condition !== prev && hasTypeofGuard(cur.condition, name);
  }
  if (ts.isIfStatement(cur)) {
    return cur.expression !== prev && hasTypeofGuard(cur.expression, name);
  }
  return false;
}

function isGuardedGlobal(node: ts.Identifier): boolean {
  let prev: ts.Node = node;
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (isGuardedBranch(cur, prev, node.text)) {
      return true;
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

function importRuntimeSpecifier(node: ts.ImportDeclaration): string | null {
  if (!ts.isStringLiteral(node.moduleSpecifier)) {
    return null;
  }
  const clause = node.importClause;
  if (clause === undefined) {
    return node.moduleSpecifier.text;
  }
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) {
    return null;
  }
  const allNamedTypeOnly =
    clause.name === undefined &&
    clause.namedBindings !== undefined &&
    ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((el) => el.isTypeOnly);
  return allNamedTypeOnly ? null : node.moduleSpecifier.text;
}

function exportRuntimeSpecifier(node: ts.ExportDeclaration): string | null {
  if (
    node.isTypeOnly ||
    node.moduleSpecifier === undefined ||
    !ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return null;
  }
  const allNamedTypeOnly =
    node.exportClause !== undefined &&
    ts.isNamedExports(node.exportClause) &&
    node.exportClause.elements.length > 0 &&
    node.exportClause.elements.every((el) => el.isTypeOnly);
  return allNamedTypeOnly ? null : node.moduleSpecifier.text;
}

function dynamicImportSpecifier(node: ts.CallExpression): string | null {
  if (node.expression.kind !== ts.SyntaxKind.ImportKeyword) {
    return null;
  }
  const [arg] = node.arguments;
  return arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text : null;
}

function isTypeSubtree(node: ts.Node): boolean {
  return (
    ts.isTypeNode(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)
  );
}

function isUnguardedNodeGlobal(node: ts.Node): node is ts.Identifier {
  return (
    ts.isIdentifier(node) &&
    NODE_GLOBALS.has(node.text) &&
    !isNonReferenceIdentifier(node) &&
    !isGuardedGlobal(node)
  );
}

function scanSource(sourceFile: ts.SourceFile): {
  readonly globals: string[];
  readonly specifiers: string[];
} {
  const specifiers: string[] = [];
  const globals: string[] = [];
  const addSpec = (spec: string | null): void => {
    if (spec !== null) {
      specifiers.push(spec);
    }
  };

  const visit = (node: ts.Node): void => {
    if (isTypeSubtree(node)) {
      return;
    }
    if (ts.isImportDeclaration(node)) {
      addSpec(importRuntimeSpecifier(node));
      return;
    }
    if (ts.isExportDeclaration(node)) {
      addSpec(exportRuntimeSpecifier(node));
      return;
    }
    if (ts.isCallExpression(node)) {
      addSpec(dynamicImportSpecifier(node));
    } else if (isUnguardedNodeGlobal(node)) {
      globals.push(node.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { globals, specifiers };
}

function resolveWorkspaceEntry(
  specifier: string,
  workspace: ReadonlyMap<string, string>
): string | null {
  const parts = specifier.split("/");
  const depDir = workspace.get(`${parts[0] ?? ""}/${parts[1] ?? ""}`);
  if (!depDir) {
    return null;
  }
  const rest = parts.slice(2).join("/");
  const depSubpath = rest.length === 0 ? "." : `./${rest}`;
  const depTarget = resolveExportTarget(
    readManifest(depDir).exports?.[depSubpath]
  );
  const depFile = depTarget ? resolve(depDir, depTarget) : undefined;
  return depFile && existsSync(depFile) ? depFile : null;
}

function inspectSpecifier(
  file: string,
  label: string,
  specifier: string,
  workspace: ReadonlyMap<string, string>,
  violations: string[]
): string | null {
  if (specifier.startsWith("node:")) {
    violations.push(`${label}: forbidden node:* import "${specifier}"`);
    return null;
  }
  if (isNodeSubpath(specifier)) {
    violations.push(`${label}: forbidden /node subpath import "${specifier}"`);
    return null;
  }
  if (specifier.startsWith(".")) {
    return resolveRelative(file, specifier);
  }
  if (specifier.startsWith("@foundry/")) {
    return resolveWorkspaceEntry(specifier, workspace);
  }
  return null;
}

function collectSeedEntries(
  absDir: string,
  pkgName: string,
  exportsMap: Record<string, unknown>,
  subpaths: readonly string[],
  violations: string[]
): string[] {
  for (const key of Object.keys(exportsMap)) {
    if (key.includes("*")) {
      violations.push(
        `${pkgName}/package.json: wildcard export "${key}" is forbidden`
      );
    }
  }
  const entries: string[] = [];
  for (const subpath of subpaths) {
    const target = resolveExportTarget(exportsMap[subpath]);
    const entry = target ? resolve(absDir, target) : undefined;
    if (entry && existsSync(entry)) {
      entries.push(entry);
    } else {
      violations.push(
        `${pkgName}/package.json: missing or unresolved export "${subpath}"`
      );
    }
  }
  return entries;
}

export function auditWebStandardExports(
  packageDir: string,
  subpaths: readonly string[]
): string[] {
  const absDir = resolve(packageDir);
  const manifest = readManifest(absDir);
  const violations: string[] = [];
  const pending = collectSeedEntries(
    absDir,
    manifest.name ?? absDir,
    manifest.exports ?? {},
    subpaths,
    violations
  );
  const workspace = workspacePackages(absDir);
  const visited = new Set<string>();

  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || visited.has(file)) {
      continue;
    }
    visited.add(file);
    const label = relative(absDir, file).replaceAll("\\", "/");
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const { globals, specifiers } = scanSource(sourceFile);
    for (const globalName of globals) {
      violations.push(`${label}: unguarded Node/Bun global "${globalName}"`);
    }
    for (const specifier of specifiers) {
      const next = inspectSpecifier(
        file,
        label,
        specifier,
        workspace,
        violations
      );
      if (next !== null) {
        pending.push(next);
      }
    }
  }

  return violations;
}

export function assertWebStandardExports(
  packageDir: string,
  subpaths: readonly string[]
): void {
  const violations = auditWebStandardExports(packageDir, subpaths);
  if (violations.length > 0) {
    throw new Error(
      `Web-standard export seam violations:\n- ${violations.join("\n- ")}`
    );
  }
}
