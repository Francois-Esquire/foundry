import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
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

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

interface PackageManifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly exports?: Record<string, unknown>;
  readonly name?: string;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
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

type GuardState = "defined" | "undefined";

function unwrapParens(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (ts.isParenthesizedExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

function isTypeofTarget(expr: ts.Expression, name: string): boolean {
  const inner = unwrapParens(expr);
  return (
    ts.isTypeOfExpression(inner) &&
    ts.isIdentifier(inner.expression) &&
    inner.expression.text === name
  );
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

function isGuardedBranch(cur: ts.Node, prev: ts.Node, name: string): boolean {
  if (ts.isTypeOfExpression(cur)) {
    return true;
  }
  if (ts.isBinaryExpression(cur) && cur.right === prev) {
    if (cur.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return provesState(cur.left, name, "defined");
    }
    if (cur.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      return provesState(cur.left, name, "undefined");
    }
  }
  if (ts.isConditionalExpression(cur)) {
    if (cur.whenTrue === prev) {
      return provesState(cur.condition, name, "defined");
    }
    if (cur.whenFalse === prev) {
      return provesState(cur.condition, name, "undefined");
    }
  }
  if (ts.isIfStatement(cur)) {
    if (cur.thenStatement === prev) {
      return provesState(cur.expression, name, "defined");
    }
    if (cur.elseStatement === prev) {
      return provesState(cur.expression, name, "undefined");
    }
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
  if (specifier.startsWith("node:") || isBuiltin(specifier)) {
    violations.push(`${label}: forbidden Node built-in import "${specifier}"`);
    return null;
  }
  if (isNodeSubpath(specifier)) {
    violations.push(`${label}: forbidden /node subpath import "${specifier}"`);
    return null;
  }
  if (specifier.startsWith(".")) {
    const resolved = resolveRelative(file, specifier);
    if (resolved === null) {
      violations.push(`${label}: unresolved relative import "${specifier}"`);
    }
    return resolved;
  }
  if (specifier.startsWith("@foundry/")) {
    const resolved = resolveWorkspaceEntry(specifier, workspace);
    if (resolved === null) {
      violations.push(`${label}: unresolved workspace import "${specifier}"`);
    }
    return resolved;
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

export function portableSubpaths(packageDir: string): string[] {
  const { exports = {} } = readManifest(resolve(packageDir));
  return Object.keys(exports).filter(
    (subpath) =>
      subpath === "./testing/store" ||
      !(isNodeSubpath(subpath) || subpath.startsWith("./testing/"))
  );
}

export type PackageTier = "primitives" | "tools" | "domains";

export const PACKAGE_TIERS: Readonly<Record<string, PackageTier>> = {
  "@foundry/agents": "domains",
  "@foundry/artifacts": "domains",
  "@foundry/core": "primitives",
  "@foundry/lib": "primitives",
  "@foundry/models": "tools",
  "@foundry/modules": "domains",
  "@foundry/prompts": "tools",
  "@foundry/queue": "domains",
  "@foundry/sandbox": "domains",
  "@foundry/scheduling": "domains",
  "@foundry/tasks": "domains",
  "@foundry/usage": "tools",
  "@foundry/workflows": "domains",
  "@foundry/workspaces": "domains",
};

const TIER_RANK: Readonly<Record<PackageTier, number>> = {
  domains: 2,
  primitives: 0,
  tools: 1,
};

const UNTIERED_WORKSPACE_PACKAGES: ReadonlySet<string> = new Set([
  "@foundry/tsconfig",
]);

function packageDirectories(packagesDir: string): string[] {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => join(packagesDir, entry.name));
}

function foundryDependencies(manifest: PackageManifest): string[] {
  const names = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (
        name.startsWith("@foundry/") &&
        !UNTIERED_WORKSPACE_PACKAGES.has(name)
      ) {
        names.add(name);
      }
    }
  }
  return [...names].sort();
}

function findCycle(graph: ReadonlyMap<string, readonly string[]>): string[] {
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (name: string): string[] | null => {
    const onPath = path.indexOf(name);
    if (onPath >= 0) {
      return [...path.slice(onPath), name];
    }
    if (done.has(name)) {
      return null;
    }
    path.push(name);
    for (const dependency of graph.get(name) ?? []) {
      const cycle = visit(dependency);
      if (cycle) {
        return cycle;
      }
    }
    path.pop();
    done.add(name);
    return null;
  };
  for (const name of graph.keys()) {
    const cycle = visit(name);
    if (cycle) {
      return cycle;
    }
  }
  return [];
}

function auditDependencyTiers(
  name: string,
  dependencies: readonly string[],
  graph: ReadonlyMap<string, readonly string[]>,
  tiers: Readonly<Record<string, PackageTier>>
): string[] {
  const tier = tiers[name];
  const violations: string[] = [];
  for (const dependency of dependencies) {
    const dependencyTier = tiers[dependency];
    if (!graph.has(dependency)) {
      violations.push(`${name}: depends on ${dependency} outside packages/*`);
    } else if (tier && dependencyTier === undefined) {
      violations.push(`${name}: depends on unclassified ${dependency}`);
    } else if (
      tier &&
      dependencyTier &&
      TIER_RANK[dependencyTier] > TIER_RANK[tier]
    ) {
      violations.push(
        `${name} (${tier}) must not depend on ${dependency} (${dependencyTier})`
      );
    }
  }
  return violations;
}

function readPackageGraph(
  packagesDir: string,
  violations: string[]
): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const dir of packageDirectories(packagesDir)) {
    const label = relative(resolve(packagesDir, ".."), dir);
    if (!existsSync(join(dir, "package.json"))) {
      violations.push(`${label}: missing package.json`);
      continue;
    }
    const manifest = readManifest(dir);
    graph.set(manifest.name ?? label, foundryDependencies(manifest));
  }
  return graph;
}

export function auditPackageTiers(
  packagesDir: string,
  tiers: Readonly<Record<string, PackageTier>> = PACKAGE_TIERS
): string[] {
  const violations: string[] = [];
  const graph = readPackageGraph(resolve(packagesDir), violations);

  for (const name of graph.keys()) {
    if (!(name in tiers)) {
      violations.push(`${name}: not classified in PACKAGE_TIERS`);
    }
  }
  for (const name of Object.keys(tiers)) {
    if (!graph.has(name)) {
      violations.push(`${name}: classified in PACKAGE_TIERS but not found`);
    }
  }
  for (const [name, dependencies] of graph) {
    violations.push(...auditDependencyTiers(name, dependencies, graph, tiers));
  }

  const cycle = findCycle(graph);
  if (cycle.length > 0) {
    violations.push(`dependency cycle: ${cycle.join(" -> ")}`);
  }

  return violations;
}

export function assertPackageTiers(packagesDir: string): void {
  const violations = auditPackageTiers(packagesDir);
  if (violations.length > 0) {
    throw new Error(`Package tier violations:\n- ${violations.join("\n- ")}`);
  }
}

const FORBIDDEN_EXPORT_NAMES: readonly {
  readonly pattern: RegExp;
  readonly reason: string;
}[] = [
  { pattern: /Manager$/, reason: "*Manager is reserved for apps/*" },
  {
    pattern: /(?<!File)System$/,
    reason: "*System obscures depth (only *FileSystem is allowed)",
  },
  { pattern: /InMemory/, reason: "name in-memory adapters Memory*" },
];

const SOURCE_FILE_PATTERN = /\.tsx?$/;
const DECLARATION_FILE_PATTERN = /\.d\.ts$/;
const NON_PUBLIC_SOURCE_DIRS = new Set(["node_modules", "test", "testing"]);

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!NON_PUBLIC_SOURCE_DIRS.has(entry.name)) {
        files.push(...sourceFiles(path));
      }
    } else if (
      SOURCE_FILE_PATTERN.test(entry.name) &&
      !DECLARATION_FILE_PATTERN.test(entry.name)
    ) {
      files.push(path);
    }
  }
  return files;
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    )
  );
}

function exportDeclarationNames(statement: ts.ExportDeclaration): string[] {
  const { exportClause } = statement;
  return exportClause && ts.isNamedExports(exportClause)
    ? exportClause.elements.map((element) => element.name.text)
    : [];
}

function exportedDeclarationNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : []
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
}

function exportedNames(sourceFile: ts.SourceFile): string[] {
  return sourceFile.statements.flatMap((statement) => {
    if (ts.isExportDeclaration(statement)) {
      return exportDeclarationNames(statement);
    }
    return hasExportModifier(statement)
      ? exportedDeclarationNames(statement)
      : [];
  });
}

export function auditExportNames(packagesDir: string): string[] {
  const root = resolve(packagesDir);
  const violations: string[] = [];
  for (const dir of packageDirectories(root)) {
    const srcDir = join(dir, "src");
    if (!existsSync(srcDir)) {
      continue;
    }
    for (const file of sourceFiles(srcDir)) {
      const sourceFile = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      );
      for (const name of exportedNames(sourceFile)) {
        for (const { pattern, reason } of FORBIDDEN_EXPORT_NAMES) {
          if (pattern.test(name)) {
            const label = relative(root, file).replaceAll("\\", "/");
            violations.push(`${label}: exported name "${name}": ${reason}`);
          }
        }
      }
    }
  }
  return violations;
}

export function assertExportNames(packagesDir: string): void {
  const violations = auditExportNames(packagesDir);
  if (violations.length > 0) {
    throw new Error(`Export naming violations:\n- ${violations.join("\n- ")}`);
  }
}
