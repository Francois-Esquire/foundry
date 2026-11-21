import { readFileSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { JavaScriptLoader, PluginBuilder } from "bun";
import { JSONC, resolveSync, TOML, YAML } from "bun";
import type {
  ExportAllDeclaration,
  ExportNamedDeclaration,
  ImportDeclaration,
  Program,
  parseSync,
  Visitor,
} from "oxc-parser";
import { copyOf, copyPath, newLoad, sourcePath } from "~/authoring/load-tag";

const COPY = /\?marbles-load=\d+(?:&format=\w+)?$/;
const BY_PATH = /^(?:\.{1,2}(?:\/|$)|\/|file:)/;
const MARBLES = realpathSync(
  fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "../.." : "..", import.meta.url)
  )
);
const MARBLES_CODE = [join(MARBLES, "src"), join(MARBLES, "dist")];
const LOADERS: Readonly<Record<string, JavaScriptLoader>> = {
  ".cjs": "js",
  ".cts": "ts",
  ".js": "js",
  ".jsx": "jsx",
  ".mjs": "js",
  ".mts": "ts",
  ".ts": "ts",
  ".tsx": "tsx",
};
type DataFormat = "json" | "jsonc" | "text" | "toml" | "yaml";
const DATA: Readonly<Record<string, DataFormat>> = {
  ".json": "json",
  ".jsonc": "jsonc",
  ".toml": "toml",
  ".txt": "text",
  ".yaml": "yaml",
  ".yml": "yaml",
};
const TYPES: Readonly<Record<string, DataFormat>> = {
  json: "json",
  jsonc: "jsonc",
  text: "text",
  toml: "toml",
  yaml: "yaml",
};
const PARSERS: Readonly<Record<DataFormat, (text: string) => unknown>> = {
  json: (text) => JSON.parse(text),
  jsonc: (text) => JSONC.parse(text),
  text: (text) => text,
  toml: (text) => TOML.parse(text),
  yaml: (text) => YAML.parse(text),
};
let parse: typeof parseSync | undefined;
let visitor: typeof Visitor | undefined;

async function parser(): Promise<typeof parseSync> {
  if (parse === undefined) {
    try {
      ({ parseSync: parse, Visitor: visitor } = await import("oxc-parser"));
    } catch (error) {
      throw new Error(
        `Marbles reads a workspace's source with oxc-parser, and its native binding for ${process.platform}-${process.arch} could not be loaded: ${error instanceof Error ? error.message : String(error)}. Reinstall @foundry.sh/marbles with optional dependencies included, or install @oxc-parser/binding-wasm32-wasi and set NAPI_RS_FORCE_WASI=1`,
        { cause: error }
      );
    }
  }
  return parse;
}

const IMPORT_FROM = Symbol.for("marbles.importFrom");

const roots = new Map<number, string>();
const libraries = new Map<
  string,
  (load: number) => Readonly<Record<string, unknown>>
>();

export function linkLibrary(
  specifier: string,
  ofLoad: (load: number) => Readonly<Record<string, unknown>>
): void {
  libraries.set(specifier, ofLoad);
}

function libraryOf(specifier: string, load: number): string {
  return `marbles-load:${String(load)}/${specifier}`;
}
let modules: PluginBuilder | undefined;

function inside(directory: string, file: string): boolean {
  return file.startsWith(`${directory}${sep}`);
}

function located(specifier: string, directory: string): string {
  const named = specifier.startsWith("file:")
    ? fileURLToPath(specifier)
    : specifier;
  const target = resolveSync(named, directory);
  return isAbsolute(target) ? realpathSync(target) : target;
}

function resolved(specifier: string, directory: string): string | undefined {
  try {
    return located(specifier, directory);
  } catch (error) {
    // biome-ignore lint/correctness/noUndeclaredVariables: ResolveMessage is the Bun global that resolveSync throws
    if (error instanceof ResolveMessage) {
      return;
    }
    throw error;
  }
}

function copyFor(
  target: string,
  load: number,
  type?: string
): string | undefined {
  if (
    !(roots.has(load) && isAbsolute(target)) ||
    target.includes(`${sep}node_modules${sep}`) ||
    MARBLES_CODE.some((directory) => inside(directory, target))
  ) {
    return;
  }
  const extension = extname(target);
  if (type === undefined && LOADERS[extension] !== undefined) {
    return copyPath(target, load);
  }
  const format = type === undefined ? DATA[extension] : TYPES[type];
  return format === undefined ? undefined : copyPath(target, load, format);
}

function typeOf(options: ImportCallOptions | undefined): string | undefined {
  const given = options as
    | {
        readonly assert?: { readonly type?: unknown };
        readonly with?: { readonly type?: unknown };
      }
    | undefined;
  const type = given?.with?.type ?? given?.assert?.type;
  return typeof type === "string" ? type : undefined;
}

async function importFrom(
  file: string,
  load: number,
  specifier: unknown,
  options?: ImportCallOptions
): Promise<unknown> {
  const named = String(specifier);
  if (libraries.has(named)) {
    return await import(libraryOf(named, load), options);
  }
  const target = located(named, dirname(file));
  const copy = BY_PATH.test(named)
    ? copyFor(target, load, typeOf(options))
    : undefined;
  return await import(copy ?? target, options);
}

interface Edit {
  readonly end: number;
  readonly start: number;
  readonly text: string;
}

function literal(code: string): string | undefined {
  const [quote] = code;
  if (
    (quote === '"' || quote === "'") &&
    code.at(-1) === quote &&
    !code.includes("\\")
  ) {
    return code.slice(1, -1);
  }
}

function specifierEdit(
  file: string,
  load: number,
  span: { readonly end: number; readonly start: number },
  value: string,
  type?: string
): Edit | undefined {
  if (libraries.has(value)) {
    return {
      end: span.end,
      start: span.start,
      text: JSON.stringify(libraryOf(value, load)),
    };
  }
  if (!BY_PATH.test(value)) {
    return;
  }
  const target = resolved(value, dirname(file));
  const copy = target === undefined ? undefined : copyFor(target, load, type);
  return copy === undefined
    ? undefined
    : { end: span.end, start: span.start, text: JSON.stringify(copy) };
}

interface Request {
  readonly end: number;
  readonly start: number;
  readonly value: string;
}

interface ImportSyntax {
  readonly reexports: readonly Request[];
  readonly types: ReadonlyMap<number, string>;
  readonly withOptions: ReadonlySet<number>;
}

function importSyntax(walker: typeof Visitor, program: Program): ImportSyntax {
  const reexports: Request[] = [];
  const types = new Map<number, string>();
  const withOptions = new Set<number>();
  const attributed = (
    node: ImportDeclaration | ExportNamedDeclaration | ExportAllDeclaration
  ) => {
    const type = node.attributes.find(
      ({ key }) => (key.type === "Identifier" ? key.name : key.value) === "type"
    );
    if (node.source !== null && type !== undefined) {
      types.set(node.source.start, type.value.value);
    }
  };
  new walker({
    ExportAllDeclaration: attributed,
    ExportNamedDeclaration: (node) => {
      attributed(node);
      if (node.source !== null) {
        const { end, start, value } = node.source;
        reexports.push({ end, start, value });
      }
    },
    ImportDeclaration: attributed,
    ImportExpression: (node) => {
      if (node.options !== null) {
        withOptions.add(node.source.start);
      }
    },
  }).visit(program);
  return { reexports, types, withOptions };
}

function commonJsUse(
  walker: typeof Visitor,
  program: Program
): string | undefined {
  let use: string | undefined;
  new walker({
    CallExpression: (node) => {
      if (node.callee.type === "Identifier" && node.callee.name === "require") {
        use ??= "require()";
      }
    },
    MemberExpression: (node) => {
      if (node.object.type !== "Identifier") {
        return;
      }
      if (node.object.name === "exports") {
        use ??= "exports";
      }
      if (
        node.object.name === "module" &&
        node.property.type === "Identifier" &&
        node.property.name === "exports"
      ) {
        use ??= "module.exports";
      }
    },
  }).visit(program);
  return use;
}

function importEdits(file: string, text: string, load: number): Edit[] {
  if (parse === undefined || visitor === undefined) {
    throw new Error(`${file} is a copy of a load that has not started`);
  }
  const { errors, module, program } = parse(file, text);
  const [error] = errors;
  if (error !== undefined) {
    throw new SyntaxError(`${file} does not parse: ${error.message}`);
  }
  const commonJs = module.hasModuleSyntax
    ? undefined
    : commonJsUse(visitor, program);
  if (commonJs !== undefined) {
    throw new SyntaxError(
      `${file} is CommonJS (it uses ${commonJs}); Marbles source and every file it imports by path must be an ES module`
    );
  }
  const syntax = importSyntax(visitor, program);
  const requests = [
    ...module.staticImports.map((entry) => entry.moduleRequest),
    ...module.staticExports.flatMap((entry) =>
      entry.entries.flatMap(({ moduleRequest }) =>
        moduleRequest === null ? [] : [moduleRequest]
      )
    ),
    ...syntax.reexports,
  ];
  const edits: Edit[] = [];
  const seen = new Set<number>();
  for (const request of requests) {
    if (seen.has(request.start)) {
      continue;
    }
    seen.add(request.start);
    const type = syntax.types.get(request.start);
    const edit = specifierEdit(file, load, request, request.value, type);
    if (edit !== undefined) {
      edits.push(edit);
    }
  }
  for (const call of module.dynamicImports) {
    const argument = call.moduleRequest;
    const value = literal(text.slice(argument.start, argument.end));
    if (value !== undefined && !syntax.withOptions.has(argument.start)) {
      const edit = specifierEdit(file, load, argument, value);
      if (edit !== undefined) {
        edits.push(edit);
      }
      continue;
    }
    const head = text.slice(call.start, argument.start);
    const lines = head.split("\n").length - 1;
    edits.push({
      end: argument.start,
      start: call.start,
      text: `globalThis[Symbol.for("marbles.importFrom")](${JSON.stringify(file)}, ${String(load)}, ${"\n".repeat(lines)}`,
    });
  }
  return edits;
}

function copied(file: string, load: number): string {
  const text = readFileSync(file, "utf8");
  let result = text;
  for (const edit of importEdits(file, text, load).sort(
    (a, b) => b.start - a.start
  )) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

function dataExports(
  file: string,
  format: DataFormat
): Record<string, unknown> {
  const value = PARSERS[format](readFileSync(file, "utf8"));
  const named =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? value
      : {};
  return { ...named, default: value };
}

const read = new Map<number, Set<string>>();
const readers = new Map<number, (file: string) => void>();

export function onRead(
  load: number,
  listener: (file: string) => void
): { forget(): void } {
  readers.set(load, listener);
  return {
    forget() {
      if (readers.get(load) === listener) {
        readers.delete(load);
      }
    },
  };
}

export function filesRead(load: number): readonly string[] {
  const files = [...(read.get(load) ?? [])].sort();
  read.delete(load);
  return files;
}

export function copyModules(builder: PluginBuilder): void {
  modules = builder;
  (globalThis as Record<symbol, unknown>)[IMPORT_FROM] = importFrom;
  builder.onLoad({ filter: COPY }, (args) => {
    const copy = copyOf(args.path);
    const file = sourcePath(args.path);
    if (copy === undefined || !roots.has(copy.load)) {
      throw new Error(`${args.path} is a copy of no load`);
    }
    const files = read.get(copy.load) ?? new Set();
    if (!files.has(file)) {
      files.add(file);
      readers.get(copy.load)?.(file);
    }
    read.set(copy.load, files);
    if (copy.format !== undefined) {
      return {
        exports: dataExports(file, copy.format as DataFormat),
        loader: "object",
      };
    }
    const loader = LOADERS[extname(file)];
    if (loader === undefined) {
      throw new Error(`${args.path} is a copy of no module`);
    }
    return { contents: copied(file, copy.load), loader };
  });
}

export async function importLoad(
  root: string,
  files: readonly string[],
  load: number = newLoad()
): Promise<void> {
  if (modules === undefined) {
    throw new Error("the source library is not linked yet");
  }
  await parser();
  roots.set(load, realpathSync(root));
  for (const [library, ofLoad] of libraries) {
    const exports = ofLoad(load);
    modules.module(libraryOf(library, load), () => ({
      exports,
      loader: "object",
    }));
  }
  const contents = files
    .map(
      (file) => `import ${JSON.stringify(copyPath(realpathSync(file), load))};`
    )
    .join("\n");
  const specifier = `marbles-load:${String(load)}`;
  modules.module(specifier, () => ({ contents, loader: "js" }));
  await import(specifier);
}
