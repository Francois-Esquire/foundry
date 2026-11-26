import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import ts from "typescript";

const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];
const GENERATED_DIRS = [
  "node_modules",
  "dist",
  "out",
  ".cache",
  ".turbo",
  "storybook-static",
];
const JS_FILE_PATTERN = /\.[cm]?jsx?$/;

const NODE_GLOBALS = new Set([
  "process",
  "Buffer",
  "Bun",
  "__dirname",
  "__filename",
  "setImmediate",
]);
const NODE_IMPORT_META = new Set(["dirname", "filename"]);
const MOCK_METHODS = new Set(["mock", "doMock"]);

export interface SourceFileOptions {
  readonly extensions?: readonly string[];
  readonly skipDirs?: readonly string[];
}

export function sourceFiles(
  root: string,
  {
    extensions = SOURCE_EXTENSIONS,
    skipDirs = GENERATED_DIRS,
  }: SourceFileOptions = {}
): string[] {
  const wanted = (path: string): boolean => extensions.includes(extname(path));
  if (statSync(root).isFile()) {
    return wanted(root) ? [root] : [];
  }
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.includes(entry.name)) {
          walk(path);
        }
      } else if (wanted(path)) {
        files.push(path);
      }
    }
  };
  walk(root);
  return files.sort();
}

function scriptKindOf(file: string): ts.ScriptKind {
  const jsx = file.endsWith("x");
  if (JS_FILE_PATTERN.test(file)) {
    return jsx ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  }
  return jsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

export function parseSourceFile(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    scriptKindOf(file)
  );
}

export type ModuleImportKind =
  | "dynamic"
  | "export"
  | "import"
  | "mock"
  | "require"
  | "type";

export interface ModuleImport {
  readonly kind: ModuleImportKind;
  readonly line: number;
  readonly specifier: string;
  readonly typeOnly: boolean;
}

type FoundImport = Omit<ModuleImport, "line">;

function literalText(node: ts.Node | undefined): string | null {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : null;
}

function foundImport(
  kind: ModuleImportKind,
  node: ts.Node | undefined,
  typeOnly = false
): FoundImport | null {
  const specifier = literalText(node);
  return specifier === null ? null : { kind, specifier, typeOnly };
}

function isTypeOnlyImportClause(clause: ts.ImportClause | undefined): boolean {
  if (clause === undefined) {
    return false;
  }
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) {
    return true;
  }
  const bindings = clause.namedBindings;
  return (
    clause.name === undefined &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  const clause = node.exportClause;
  return (
    node.isTypeOnly ||
    (clause !== undefined &&
      ts.isNamedExports(clause) &&
      clause.elements.length > 0 &&
      clause.elements.every((element) => element.isTypeOnly))
  );
}

function callImport(node: ts.CallExpression): FoundImport | null {
  const { expression } = node;
  const [argument] = node.arguments;
  if (expression.kind === ts.SyntaxKind.ImportKeyword) {
    return foundImport("dynamic", argument);
  }
  if (ts.isIdentifier(expression) && expression.text === "require") {
    return foundImport("require", argument);
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "vi" &&
    MOCK_METHODS.has(expression.name.text)
  ) {
    return foundImport("mock", argument);
  }
  return null;
}

function moduleImportOf(node: ts.Node): FoundImport | null {
  if (ts.isImportDeclaration(node)) {
    return foundImport(
      "import",
      node.moduleSpecifier,
      isTypeOnlyImportClause(node.importClause)
    );
  }
  if (ts.isExportDeclaration(node)) {
    return foundImport("export", node.moduleSpecifier, isTypeOnlyExport(node));
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference)
  ) {
    return foundImport(
      "require",
      node.moduleReference.expression,
      node.isTypeOnly
    );
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
    return foundImport("type", node.argument.literal, true);
  }
  return ts.isCallExpression(node) ? callImport(node) : null;
}

function collectModuleImports(sourceFile: ts.SourceFile): ModuleImport[] {
  const imports: ModuleImport[] = [];
  const visit = (node: ts.Node): void => {
    const found = moduleImportOf(node);
    if (found !== null) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile)
      );
      imports.push({ ...found, line: line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
}

export function parseModuleImports(file: string): ModuleImport[] {
  return collectModuleImports(parseSourceFile(file));
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
  } else if (ts.isElementAccessExpression(node)) {
    owner = node.expression;
    name = literalText(node.argumentExpression);
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

function isGuardedUse(node: ts.Node, name: string): boolean {
  let prev: ts.Node = node;
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (isGuardedBranch(cur, prev, name)) {
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

function isTypeSubtree(node: ts.Node): boolean {
  return (
    ts.isTypeNode(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)
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
      isTypeSubtree(node) ||
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

export function scanSource(sourceFile: ts.SourceFile): {
  readonly globals: string[];
  readonly specifiers: string[];
} {
  return {
    globals: unguardedNodeGlobals(sourceFile),
    specifiers: collectModuleImports(sourceFile)
      .filter(({ kind, typeOnly }) => !typeOnly && kind !== "mock")
      .map(({ specifier }) => specifier),
  };
}
