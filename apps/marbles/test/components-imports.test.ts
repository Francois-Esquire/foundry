import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const source = fileURLToPath(new URL("../src/", import.meta.url));
const components = resolve(source, "components");
const TYPE_ONLY_TIERS = ["model", "lib"];
const SOURCE_FILE = /\.tsx?$/;

type ModuleReference =
  | {
      readonly kind: "static";
      readonly specifier: string;
      readonly typeOnly: boolean;
    }
  | { readonly kind: "dynamic"; readonly expression: string };

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

function staticSpecifier(node: ts.Node | undefined): string | undefined {
  return node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

function moduleReference(
  file: ts.SourceFile,
  node: ts.Node | undefined,
  typeOnly: boolean
): ModuleReference {
  const specifier = staticSpecifier(node);
  return specifier === undefined
    ? { expression: node?.getText(file) ?? "", kind: "dynamic" }
    : { kind: "static", specifier, typeOnly };
}

function isModuleCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  );
}

function referenceOf(
  file: ts.SourceFile,
  node: ts.Node
): ModuleReference | undefined {
  if (ts.isImportDeclaration(node)) {
    return moduleReference(
      file,
      node.moduleSpecifier,
      importIsTypeOnly(node.importClause)
    );
  }
  if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
    return moduleReference(file, node.moduleSpecifier, exportIsTypeOnly(node));
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference)
  ) {
    return moduleReference(
      file,
      node.moduleReference.expression,
      node.isTypeOnly
    );
  }
  if (isModuleCall(node)) {
    return moduleReference(file, node.arguments[0], false);
  }
  if (ts.isImportTypeNode(node)) {
    const { argument } = node;
    return moduleReference(
      file,
      ts.isLiteralTypeNode(argument) ? argument.literal : argument,
      true
    );
  }
  return undefined;
}

function references(file: ts.SourceFile): ModuleReference[] {
  const found: ModuleReference[] = [];
  const visit = (node: ts.Node) => {
    const reference = referenceOf(file, node);
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
  if (reference.kind === "dynamic") {
    return false;
  }
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

const LAYERS = ["ui", "blocks", "layouts"].map((layer) =>
  resolve(components, layer)
);

function layerOf(path: string): number {
  return LAYERS.findIndex((layer) => within(layer, path));
}

function reachesHigherLayer(path: string, reference: ModuleReference): boolean {
  if (reference.kind === "dynamic") {
    return false;
  }
  const resolved = target(path, reference.specifier);
  return (
    resolved !== undefined &&
    within(components, resolved) &&
    layerOf(resolved) > layerOf(path)
  );
}

function describeReference(reference: ModuleReference): string {
  return reference.kind === "dynamic"
    ? `unresolvable module reference ${reference.expression}`
    : reference.specifier;
}

type Rule = (path: string, reference: ModuleReference) => boolean;

function violations(path: string, text: string, rule: Rule): string[] {
  const parsed = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  return references(parsed)
    .filter((reference) => rule(path, reference))
    .map(describeReference);
}

const forbidden: Rule = (path, reference) => !allowed(path, reference);

async function componentViolations(rule: Rule): Promise<string[]> {
  const files = await readdir(components, { recursive: true });
  const found: string[] = [];
  for (const file of files.filter((name) => SOURCE_FILE.test(name))) {
    const path = resolve(components, file);
    const text = await readFile(path, "utf8");
    for (const violation of violations(path, text, rule)) {
      found.push(`${file}: ${violation}`);
    }
  }
  return found;
}

it("components import only React, OpenTUI, components, and model or lib types", async () => {
  expect(await componentViolations(forbidden)).toEqual([]);
});

it("ui imports no blocks or layouts, and blocks import no layouts", async () => {
  expect(await componentViolations(reachesHigherLayer)).toEqual([]);
});

function templateNaming(prefix: string, variable: string): string {
  return `\`${prefix}$\{${variable}}\``;
}

const CLI_MODULE = templateNaming("~/cli/", "name");

describe("component import classifier", () => {
  const block = resolve(components, "blocks", "example.tsx");
  const primitive = resolve(components, "ui", "example.tsx");

  it.each([
    'import { useState } from "react";',
    'import { RGBA } from "@opentui/core";',
    'import { Text } from "~/components/ui/text";',
    'import { Badge } from "../ui/badge";',
    'import type { JsonValue } from "~/model/json";',
    'import { type FeedEntrySnapshot } from "~/lib/feed/read";',
    'export type { LogEntry } from "~/model/log";',
    'type Entry = import("~/model/log").LogEntry;',
    'import type Json = require("~/model/json");',
    "const ui = import(`~/components/ui/text`);",
  ])("allows %s", (text) => {
    expect(violations(block, text, forbidden)).toEqual([]);
  });

  it.each([
    ['import { theme } from "~/cli/theme";', "~/cli/theme"],
    [
      'import { canRunSchedule } from "~/model/dashboard";',
      "~/model/dashboard",
    ],
    [
      'export { reduce } from "~/cli/state/dashboard-state";',
      "~/cli/state/dashboard-state",
    ],
    ['import "node:fs";', "node:fs"],
    [
      'const state = require("~/cli/state/dashboard-state");',
      "~/cli/state/dashboard-state",
    ],
    [
      'import state = require("~/cli/state/dashboard-state");',
      "~/cli/state/dashboard-state",
    ],
    ['import Json = require("~/model/json");', "~/model/json"],
    [
      "const state = import(`~/cli/state/dashboard-state`);",
      "~/cli/state/dashboard-state",
    ],
    [
      "const state = require(`~/cli/state/dashboard-state`);",
      "~/cli/state/dashboard-state",
    ],
  ])("refuses %s", (text, specifier) => {
    expect(violations(block, text, forbidden)).toEqual([specifier]);
  });

  it.each([
    [`const state = import(${CLI_MODULE});`, CLI_MODULE],
    ["const state = import(name);", "name"],
    ["const state = require(name);", "name"],
    [`const state = require(${CLI_MODULE});`, CLI_MODULE],
  ])("refuses the unresolvable reference in %s", (text, expression) => {
    expect(violations(block, text, forbidden)).toEqual([
      `unresolvable module reference ${expression}`,
    ]);
  });

  it("refuses a primitive that reaches a block or layout", () => {
    const text = [
      'import { Catalog } from "~/components/blocks/catalog";',
      'const layout = require("../layouts/dashboard");',
      'import { Badge } from "./badge";',
    ].join("\n");
    expect(violations(primitive, text, reachesHigherLayer)).toEqual([
      "~/components/blocks/catalog",
      "../layouts/dashboard",
    ]);
  });
});
