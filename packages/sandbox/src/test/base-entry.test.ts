import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import packageJson from "../../package.json";
import {
  DEFAULT_SANDBOX_WORKING_DIRECTORY,
  normalizeSandboxPath,
  SandboxError,
  sandboxFromAdapter,
} from "../index";
import { MemoryContainerStore } from "../store/memory";
import { createSandboxToolSchemas } from "../tools/index";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_GLOBALS = new Set([
  "process",
  "Buffer",
  "Bun",
  "__dirname",
  "__filename",
  "setImmediate",
]);
const FORBIDDEN_PACKAGES = ["just-bash", "microsandbox", "drizzle-orm"];

function runtimeSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      !node.importClause?.isTypeOnly &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function nodeGlobalReferences(sourceFile: ts.SourceFile): string[] {
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) {
      return;
    }
    if (ts.isIdentifier(node) && NODE_GLOBALS.has(node.text)) {
      const { parent } = node;
      const isPropertyKey =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node) ||
        (ts.isMethodDeclaration(parent) && parent.name === node) ||
        (ts.isBindingElement(parent) && parent.propertyName === node);
      if (!isPropertyKey) {
        hits.push(node.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
}

function graph(entry: string): {
  files: string[];
  packages: Set<string>;
  globalRefs: Map<string, string[]>;
} {
  const files: string[] = [];
  const packages = new Set<string>();
  const globalRefs = new Map<string, string[]>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (files.includes(file)) {
      continue;
    }
    files.push(file);
    const raw = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      raw,
      ts.ScriptTarget.Latest,
      true
    );
    const refs = nodeGlobalReferences(sourceFile);
    if (refs.length > 0) {
      globalRefs.set(relative(SRC, file), refs);
    }
    for (const target of runtimeSpecifiers(sourceFile)) {
      if (!target.startsWith(".")) {
        packages.add(target);
        continue;
      }
      const base = resolve(dirname(file), target);
      const found = [`${base}.ts`, join(base, "index.ts")].find(existsSync);
      if (found) {
        pending.push(found);
      }
    }
  }
  return {
    files: files.map((file) => relative(SRC, file)),
    globalRefs,
    packages,
  };
}

for (const [label, entry, expectedFile] of [
  ["base entry", "index.ts", "sandbox.ts"],
  ["store contract entry", "store/index.ts", "store/index.ts"],
  ["memory store entry", "store/memory.ts", "store/memory.ts"],
  ["tools entry", "tools/index.ts", "tools/toolkit.ts"],
] as const) {
  it(`loads no node:* imports, ./node adapters, optional providers, or Node globals from the ${label}`, () => {
    const { files, packages, globalRefs } = graph(join(SRC, entry));
    expect(files.filter((file) => file.startsWith("node/"))).toEqual([]);
    expect([...packages].filter((name) => name.startsWith("node:"))).toEqual(
      []
    );
    for (const forbidden of FORBIDDEN_PACKAGES) {
      expect(packages.has(forbidden)).toBe(false);
    }
    expect(files).toContain(expectedFile);
    expect([...globalRefs.entries()]).toEqual([]);
  });
}

it("publishes explicit canonical subpaths with no wildcard exports", () => {
  const subpaths = Object.keys(packageJson.exports);
  expect(subpaths.filter((key) => key.includes("*"))).toEqual([]);
  for (const canonical of [
    ".",
    "./node",
    "./node/microsandbox",
    "./store",
    "./store/memory",
    "./store/sqlite",
    "./store/tables",
    "./testing",
    "./testing/store",
    "./tools",
    "./virtual",
  ]) {
    expect(subpaths).toContain(canonical);
  }
});

it("evaluates portable contracts, MemoryContainerStore, and tool schemas without Node adapters", async () => {
  expect(normalizeSandboxPath("notes.md")).toBe(
    `${DEFAULT_SANDBOX_WORKING_DIRECTORY}/notes.md`
  );
  expect(new SandboxError("invalid-contract", "bad").code).toBe(
    "invalid-contract"
  );
  const store = new MemoryContainerStore();
  expect(await store.list()).toEqual([]);
  expect(sandboxFromAdapter).toBeTypeOf("function");
  const schemas = createSandboxToolSchemas();
  expect(Object.keys(schemas.tools)).toContain("read");
});
