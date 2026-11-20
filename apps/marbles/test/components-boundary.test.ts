import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const source = fileURLToPath(new URL("../src/", import.meta.url));
const components = resolve(source, "components");
const TYPE_ONLY_TIERS = ["model", "lib"];
const SOURCE_FILE = /\.tsx?$/;

interface ModuleReference {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

function namedTypeOnly(
  elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>
): boolean {
  return elements.length > 0 && elements.every((element) => element.isTypeOnly);
}

function importIsTypeOnly(clause: ts.ImportClause | undefined): boolean {
  if (!clause) {
    return false;
  }
  if (clause.isTypeOnly) {
    return true;
  }
  const bindings = clause.namedBindings;
  return (
    clause.name === undefined &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    namedTypeOnly(bindings.elements)
  );
}

function exportIsTypeOnly(declaration: ts.ExportDeclaration): boolean {
  const clause = declaration.exportClause;
  return (
    declaration.isTypeOnly ||
    (clause !== undefined &&
      ts.isNamedExports(clause) &&
      namedTypeOnly(clause.elements))
  );
}

function literal(node: ts.Node | undefined): string | undefined {
  return node && ts.isStringLiteral(node) ? node.text : undefined;
}

function referenceOf(node: ts.Node): ModuleReference | undefined {
  if (ts.isImportDeclaration(node)) {
    const specifier = literal(node.moduleSpecifier);
    return specifier === undefined
      ? undefined
      : { specifier, typeOnly: importIsTypeOnly(node.importClause) };
  }
  if (ts.isExportDeclaration(node)) {
    const specifier = literal(node.moduleSpecifier);
    return specifier === undefined
      ? undefined
      : { specifier, typeOnly: exportIsTypeOnly(node) };
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword
  ) {
    const specifier = literal(node.arguments[0]);
    return specifier === undefined ? undefined : { specifier, typeOnly: false };
  }
  if (ts.isImportTypeNode(node)) {
    const { argument } = node;
    const specifier = ts.isLiteralTypeNode(argument)
      ? literal(argument.literal)
      : undefined;
    return specifier === undefined ? undefined : { specifier, typeOnly: true };
  }
  return undefined;
}

function references(file: ts.SourceFile): ModuleReference[] {
  const found: ModuleReference[] = [];
  const visit = (node: ts.Node) => {
    const reference = referenceOf(node);
    if (reference) {
      found.push(reference);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function target(path: string, specifier: string): string | undefined {
  if (specifier.startsWith("~/")) {
    return resolve(source, specifier.slice(2));
  }
  if (specifier.startsWith(".")) {
    return resolve(dirname(path), specifier);
  }
  return undefined;
}

function within(directory: string, path: string): boolean {
  const inside = relative(directory, path);
  return !(inside.startsWith("..") || isAbsolute(inside));
}

function allowed(path: string, reference: ModuleReference): boolean {
  const { specifier, typeOnly } = reference;
  if (specifier === "react" || specifier.startsWith("@opentui/")) {
    return true;
  }
  const resolved = target(path, specifier);
  if (resolved === undefined) {
    return false;
  }
  if (within(components, resolved)) {
    return true;
  }
  return (
    typeOnly &&
    TYPE_ONLY_TIERS.some((tier) => within(resolve(source, tier), resolved))
  );
}

it("components import only React, OpenTUI, components, and model or lib types", async () => {
  const files = await readdir(components, { recursive: true });
  const violations: string[] = [];
  for (const file of files.filter((name) => SOURCE_FILE.test(name))) {
    const path = resolve(components, file);
    const text = await readFile(path, "utf8");
    const parsed = ts.createSourceFile(path, text, ts.ScriptTarget.Latest);
    for (const reference of references(parsed)) {
      if (!allowed(path, reference)) {
        violations.push(`${file}: ${reference.specifier}`);
      }
    }
  }
  expect(violations).toEqual([]);
});
