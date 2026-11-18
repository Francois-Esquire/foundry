import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type TS from "typescript";

export interface CallSite {
  readonly column: number;
  readonly file: string;
  readonly line: number;
}

export function originOf(site: CallSite): string {
  return `${site.file}:${String(site.line)}`;
}

const LIB_DIR = dirname(fileURLToPath(import.meta.url));

function pathOf(fileName: string): string {
  const path = fileName.startsWith("file://")
    ? fileURLToPath(fileName)
    : fileName;
  const query = path.indexOf("?");
  return query === -1 ? path : path.slice(0, query);
}

const FRAME = /^\s*at\s+(?:.*?\()?(.+?):(\d+):(\d+)\)?$/;

const STACK_DEPTH = 50;

function formattedStack(): unknown {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = STACK_DEPTH;
  try {
    return new Error("call site").stack;
  } finally {
    Error.stackTraceLimit = limit;
  }
}

export function callSite(): CallSite | undefined {
  const stack = formattedStack();
  if (typeof stack !== "string") {
    return undefined;
  }
  for (const text of stack.split("\n")) {
    const match = FRAME.exec(text);
    if (!match) {
      continue;
    }
    const [, fileName = "", line = "", column = ""] = match;
    const file = pathOf(fileName);
    if (file.startsWith(LIB_DIR) || file.startsWith("node:")) {
      continue;
    }
    return { column: Number(column), file, line: Number(line) };
  }
  return undefined;
}

type Parser = Pick<
  typeof TS,
  "createSourceFile" | "ScriptTarget" | "SyntaxKind"
>;

const parsers = new Map<string, Parser | null>();

function parserFor(file: string): Parser | null {
  const dir = dirname(file);
  const cached = parsers.get(dir);
  if (cached !== undefined) {
    return cached;
  }
  let parser: Parser | null = null;
  try {
    const loaded = createRequire(pathToFileURL(file))("typescript") as
      | Partial<Parser>
      | undefined;
    if (typeof loaded?.createSourceFile === "function") {
      parser = loaded as Parser;
    }
  } catch {
    parser = null;
  }
  parsers.set(dir, parser);
  return parser;
}

interface Binding {
  readonly end: number;
  readonly initializer: TS.Node;
  readonly name: string;
  readonly source: TS.SourceFile;
  readonly start: number;
}

const bindings = new Map<string, readonly Binding[] | null>();

function bindingsOf(file: string): readonly Binding[] | null {
  const cached = bindings.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const ts = parserFor(file);
  let found: readonly Binding[] | null = null;
  if (ts) {
    try {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true
      );
      found = topLevelBindings(ts, source);
    } catch {
      found = null;
    }
  }
  bindings.set(file, found);
  return found;
}

function topLevelBindings(ts: Parser, source: TS.SourceFile): Binding[] {
  const result: Binding[] = [];
  for (const statement of source.statements) {
    if (statement.kind !== ts.SyntaxKind.VariableStatement) {
      continue;
    }
    const { declarationList } = statement as TS.VariableStatement;
    for (const declaration of declarationList.declarations) {
      const { initializer, name } = declaration;
      if (!initializer || name.kind !== ts.SyntaxKind.Identifier) {
        continue;
      }
      result.push({
        end: initializer.end,
        initializer,
        name: (name as TS.Identifier).text,
        source,
        start: initializer.getStart(source),
      });
    }
  }
  return result;
}

function callAt(
  ts: Parser,
  source: TS.SourceFile,
  root: TS.Node,
  offset: number
): TS.Node | undefined {
  let found: TS.Node | undefined;
  const visit = (node: TS.Node): void => {
    if (offset < node.getStart(source) || offset >= node.end) {
      return;
    }
    if (node.kind === ts.SyntaxKind.CallExpression) {
      found = node;
    }
    node.forEachChild(visit);
  };
  visit(root);
  return found;
}

function owns(ts: Parser, call: TS.Node, initializer: TS.Node): boolean {
  const calleeKinds = new Set([
    ts.SyntaxKind.AsExpression,
    ts.SyntaxKind.AwaitExpression,
    ts.SyntaxKind.CallExpression,
    ts.SyntaxKind.ElementAccessExpression,
    ts.SyntaxKind.NonNullExpression,
    ts.SyntaxKind.ParenthesizedExpression,
    ts.SyntaxKind.PropertyAccessExpression,
    ts.SyntaxKind.SatisfiesExpression,
    ts.SyntaxKind.TypeAssertionExpression,
  ]);
  let node = call;
  while (node !== initializer) {
    const { parent } = node;
    if (!(parent && calleeKinds.has(parent.kind))) {
      return false;
    }
    if ((parent as { expression?: TS.Node }).expression !== node) {
      return false;
    }
    node = parent;
  }
  return true;
}

function offsetOf(text: string, line: number, column: number): number {
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const next = text.indexOf("\n", offset);
    if (next === -1) {
      return text.length;
    }
    offset = next + 1;
  }
  return offset + column;
}

const texts = new Map<string, string>();

function textOf(file: string): string {
  const cached = texts.get(file);
  if (cached !== undefined) {
    return cached;
  }
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    text = "";
  }
  texts.set(file, text);
  return text;
}

export function bindingAt(site: CallSite): string | undefined {
  const found = bindingsOf(site.file);
  const ts = parserFor(site.file);
  if (!(found && ts)) {
    return undefined;
  }
  const offset = offsetOf(textOf(site.file), site.line, site.column);
  const match = found.find(
    (binding) => offset + 1 >= binding.start && offset - 1 < binding.end
  );
  if (!match) {
    return undefined;
  }
  const call = callAt(ts, match.source, match.initializer, offset);
  return call && owns(ts, call, match.initializer) ? match.name : undefined;
}

export function canInfer(file: string): boolean {
  return parserFor(file) !== null;
}

export function resetIdentity(): void {
  bindings.clear();
  texts.clear();
  parsers.clear();
}
