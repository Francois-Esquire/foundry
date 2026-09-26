import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type TS from "typescript";

/**
 * Durable names for nameless definitions. `step()` captures where the config
 * called it; when the definition is finished, the top-level `const` whose
 * initializer contains that call names it. The file is read as source: Bun
 * loads `quirks.config.ts` without a transpile step, so positions match, and
 * TypeScript's parser (the author's own copy) finds the binding.
 */

export interface CallSite {
  readonly column: number;
  readonly file: string;
  readonly line: number;
}

/** Where this module lives; frames under it belong to the lib, not the config. */
const LIB_DIR = dirname(fileURLToPath(import.meta.url));

function pathOf(fileName: string): string {
  return fileName.startsWith("file://") ? fileURLToPath(fileName) : fileName;
}

/** The first frame outside the lib, or `undefined` when there is none. */
export function callSite(): CallSite | undefined {
  const previous = Error.prepareStackTrace;
  Error.prepareStackTrace = (_error, structured) => structured;
  const holder: { stack?: unknown } = {};
  let sites: NodeJS.CallSite[] = [];
  try {
    Error.captureStackTrace(holder, callSite);
    // Formatting is lazy in V8: read the stack while our formatter is in place.
    sites = Array.isArray(holder.stack) ? holder.stack : [];
  } finally {
    Error.prepareStackTrace = previous;
  }
  for (const site of sites) {
    const fileName = site.getFileName();
    const line = site.getLineNumber();
    const column = site.getColumnNumber();
    if (!fileName || line === null || column === null) {
      continue;
    }
    const file = pathOf(fileName);
    if (file.startsWith(LIB_DIR) || file.startsWith("node:")) {
      continue;
    }
    return { column, file, line };
  }
  return undefined;
}

type Parser = Pick<
  typeof TS,
  "createSourceFile" | "ScriptTarget" | "SyntaxKind"
>;

const parsers = new Map<string, Parser | null>();

/** The author's `typescript`, resolved from the config's location; `null` when absent. */
function parserFor(file: string): Parser | null {
  const dir = dirname(file);
  const cached = parsers.get(dir);
  if (cached !== undefined) {
    return cached;
  }
  let parser: Parser | null = null;
  try {
    parser = createRequire(pathToFileURL(file))("typescript") as Parser;
  } catch {
    parser = null;
  }
  parsers.set(dir, parser);
  return parser;
}

/** Top-level `const` bindings of one file: identifier by initializer span. */
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

/** The innermost call expression whose span holds the offset, under `root`. */
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

/**
 * Whether `call` is the initializer's own definition: every step from the
 * call up to the initializer goes through a callee position (`x` in
 * `x(...)`, `x.y`, `(x)`, `x as T`, `x!`, `await x`). A call reached
 * through an argument list is a definition passed to another one, and a
 * call inside a function body belongs to whoever calls that function;
 * neither takes the const's name.
 */
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

/**
 * The top-level `const` whose initializer *is* this call, or `undefined`
 * for a call inside a function, a call passed as an argument to another
 * definition, or a file TypeScript cannot read. Call-site columns are
 * one-based in some runtimes and zero-based in others; the call's own span
 * holds either, and a one-column tolerance covers the initializer's edge.
 */
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

/** Whether a TypeScript parser is reachable from `file`. */
export function canInfer(file: string): boolean {
  return parserFor(file) !== null;
}

/** Tests only: forget parsed files so a rewritten fixture is re-read. */
export function resetIdentity(): void {
  bindings.clear();
  texts.clear();
  parsers.clear();
}
