import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = resolve(root, "src");
const components = resolve(source, "components");
const SOURCE_FILE = /\.tsx?$/;
const EXTENSION = /\.tsx?$/;
const MUTABLE_DECLARATION = /^(let|var)\s/;

const STATEFUL = new Set([
  "useEffect",
  "useKeyboard",
  "useLayoutEffect",
  "useOnResize",
  "useReducer",
  "useRef",
  "useState",
  "useSyncExternalStore",
  "useTerminalDimensions",
  "useTimeline",
]);
const TIMERS = new Set([
  "requestAnimationFrame",
  "setImmediate",
  "setInterval",
  "setTimeout",
]);
const PACKAGES_OUTSIDE_COMPONENTS = [
  "@foundry.sh/marbles",
  "@modelcontextprotocol/sdk",
  "bun",
  "evlog",
];
const RUNTIME = ["harness", "backlog"].map((name) => resolve(source, name));
const VIEWS = resolve(source, "views");
const HOOKS = resolve(source, "hooks");
const THEME_HOOK = resolve(HOOKS, "use-theme");

function within(directory: string, path: string): boolean {
  const inside = relative(directory, path);
  return !(inside.startsWith("..") || isAbsolute(inside));
}

function specifierOf(node: ts.Node): string | undefined {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  ) {
    const [first] = node.arguments;
    return first &&
      (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
      ? first.text
      : "<dynamic>";
  }
  return undefined;
}

function resolved(path: string, specifier: string): string | undefined {
  if (specifier.startsWith("@/")) {
    return resolve(source, specifier.slice(2)).replace(EXTENSION, "");
  }
  if (specifier.startsWith(".")) {
    return resolve(dirname(path), specifier).replace(EXTENSION, "");
  }
  return undefined;
}

function isPackage(specifier: string, name: string): boolean {
  return specifier === name || specifier.startsWith(`${name}/`);
}

function reachesRuntime(path: string, specifier: string): boolean {
  const target = resolved(path, specifier);
  return (
    target !== undefined &&
    RUNTIME.some((runtime) => target === runtime || within(runtime, target))
  );
}

function componentImportBanned(path: string, specifier: string): boolean {
  if (specifier === "<dynamic>" || reachesRuntime(path, specifier)) {
    return true;
  }
  if (PACKAGES_OUTSIDE_COMPONENTS.some((name) => isPackage(specifier, name))) {
    return true;
  }
  const target = resolved(path, specifier);
  if (target === undefined) {
    return false;
  }
  return (
    within(VIEWS, target) || (within(HOOKS, target) && target !== THEME_HOOK)
  );
}

const LAYERS = ["ui", "blocks", "layouts"].map((layer) =>
  resolve(components, layer)
);

function layerOf(path: string): number {
  return LAYERS.findIndex((layer) => within(layer, path));
}

function reachesHigherLayer(path: string, specifier: string): boolean {
  const target = resolved(path, specifier);
  return (
    target !== undefined &&
    within(components, target) &&
    layerOf(target) > layerOf(path)
  );
}

function calledName(node: ts.CallExpression): string | undefined {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text;
  }
  return undefined;
}

function topLevelMutable(
  file: ts.SourceFile,
  node: ts.Node
): string | undefined {
  if (!(ts.isVariableStatement(node) && ts.isSourceFile(node.parent))) {
    return undefined;
  }
  const declaration = node.declarationList.getText(file);
  return MUTABLE_DECLARATION.test(declaration)
    ? `module-level ${declaration.split("=")[0]?.trim()}`
    : undefined;
}

function stateViolations(file: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = calledName(node);
      if (name && (STATEFUL.has(name) || TIMERS.has(name))) {
        found.push(name);
      }
    }
    if (ts.isImportSpecifier(node)) {
      const imported = (node.propertyName ?? node.name).text;
      if (STATEFUL.has(imported)) {
        found.push(`import ${imported}`);
      }
    }
    const mutable = topLevelMutable(file, node);
    if (mutable) {
      found.push(mutable);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

type Rule = (path: string, specifier: string) => boolean;

function importViolations(file: ts.SourceFile, rule: Rule): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const specifier = specifierOf(node);
    if (specifier !== undefined && rule(file.fileName, specifier)) {
      found.push(specifier);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}

async function filesUnder(directory: string): Promise<ts.SourceFile[]> {
  const names = await readdir(directory, { recursive: true });
  return Promise.all(
    names
      .filter((name) => SOURCE_FILE.test(name))
      .map(async (name) => {
        const path = resolve(directory, name);
        return parse(path, await readFile(path, "utf8"));
      })
  );
}

async function sweep(
  directories: readonly string[],
  check: (file: ts.SourceFile) => string[]
): Promise<string[]> {
  const files = (await Promise.all(directories.map(filesUnder))).flat();
  return files.flatMap((file) =>
    check(file).map(
      (violation) => `${relative(root, file.fileName)}: ${violation}`
    )
  );
}

it("components hold no state, effects, key listeners, or timers", async () => {
  expect(await sweep([components], stateViolations)).toEqual([]);
});

it("components import no harness, views, stateful hooks, or runtime packages", async () => {
  expect(
    await sweep([components], (file) =>
      importViolations(file, componentImportBanned)
    )
  ).toEqual([]);
});

it("ui imports no blocks or layouts, and blocks import no layouts", async () => {
  expect(
    await sweep([components], (file) =>
      importViolations(file, reachesHigherLayer)
    )
  ).toEqual([]);
});

it("model, hooks, views, and stories never reach the harness or backlog", async () => {
  expect(
    await sweep(
      ["model", "hooks", "views"]
        .map((name) => resolve(source, name))
        .concat(resolve(root, "stories")),
      (file) => importViolations(file, reachesRuntime)
    )
  ).toEqual([]);
});

describe("the classifier", () => {
  const block = resolve(components, "blocks", "example.tsx");
  const primitive = resolve(components, "ui", "example.tsx");

  it.each([
    'import { useMemo } from "react";',
    'import { SyntaxStyle } from "@opentui/core";',
    'import { useTheme } from "@/hooks/use-theme";',
    'import { Panel } from "@/components/ui/panel";',
    'import { Hint } from "./hint";',
    'import type { Thread } from "@/model/thread";',
  ])("allows %s", (text) => {
    expect(importViolations(parse(block, text), componentImportBanned)).toEqual(
      []
    );
  });

  it.each([
    ['import { run } from "@/harness";', "@/harness"],
    ['import { backlog } from "../../backlog";', "../../backlog"],
    ['import { HarnessView } from "@/views/harness";', "@/views/harness"],
    ['import { useThread } from "@/hooks/use-thread";', "@/hooks/use-thread"],
    ['import { agent } from "@foundry.sh/marbles";', "@foundry.sh/marbles"],
    [
      'import { Engine } from "@foundry.sh/marbles/lib";',
      "@foundry.sh/marbles/lib",
    ],
    ['import { initLogger } from "evlog";', "evlog"],
    ['import { sleep } from "bun";', "bun"],
    ["const harness = import(name);", "<dynamic>"],
  ])("refuses %s", (text, specifier) => {
    expect(importViolations(parse(block, text), componentImportBanned)).toEqual(
      [specifier]
    );
  });

  it.each([
    ["const [a, b] = useState(0);", "useState"],
    ["const [a, b] = React.useState(0);", "useState"],
    ["useEffect(() => undefined, []);", "useEffect"],
    ["const ref = useRef(null);", "useRef"],
    ["useKeyboard(() => undefined);", "useKeyboard"],
    ["const size = useTerminalDimensions();", "useTerminalDimensions"],
    ["const [s, d] = useReducer(f, 0);", "useReducer"],
    ["setInterval(tick, 80);", "setInterval"],
    ["setTimeout(tick, 80);", "setTimeout"],
    ['import { useState as hold } from "react";', "import useState"],
    ['import { useKeyboard } from "@opentui/react";', "import useKeyboard"],
    ["let frame = 0;", "module-level let frame"],
    ["var frame = 0;", "module-level var frame"],
  ])("refuses %s", (text, violation) => {
    expect(stateViolations(parse(block, text))).toEqual([violation]);
  });

  it("allows constants, memos, and the theme", () => {
    const text = [
      "const FRAMES = [1, 2];",
      "export function Row() {",
      "  let local = 0;",
      "  const theme = useTheme();",
      "  return useMemo(() => local + theme.size, [theme]);",
      "}",
    ].join("\n");
    expect(stateViolations(parse(block, text))).toEqual([]);
  });

  it("refuses a primitive that reaches a block or layout", () => {
    const text = [
      'import { Conversation } from "@/components/blocks/conversation";',
      'import { HarnessLayout } from "../layouts/harness";',
      'import { Panel } from "./panel";',
    ].join("\n");
    expect(
      importViolations(parse(primitive, text), reachesHigherLayer)
    ).toEqual(["@/components/blocks/conversation", "../layouts/harness"]);
  });
});
