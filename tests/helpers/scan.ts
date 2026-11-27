import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import ts from "typescript";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");
export const PACKAGES_DIR = join(REPO_ROOT, "packages");
export const APPS_DIR = join(REPO_ROOT, "apps");

export const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export interface PackageManifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly exports?: Record<string, unknown>;
  readonly name?: string;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly peerDependenciesMeta?: Record<
    string,
    { readonly optional?: boolean }
  >;
}

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
const MOCK_METHODS = new Set(["mock", "doMock"]);

export interface SourceFileOptions {
  readonly extensions?: readonly string[];
  readonly skipDirs?: readonly string[];
}

export function packageDirs(root = PACKAGES_DIR): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        existsSync(join(root, entry.name, "package.json"))
    )
    .map((entry) => join(root, entry.name))
    .sort();
}

export function readManifest(packageDir: string): PackageManifest {
  return JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8")
  ) as PackageManifest;
}

export function resolveExportTarget(target: unknown): string | undefined {
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

type ModuleImportKind =
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

export function collectModuleImports(
  sourceFile: ts.SourceFile
): ModuleImport[] {
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
