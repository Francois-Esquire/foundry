import { readFileSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { JavaScriptLoader, PluginBuilder } from "bun";
import { JSONC, resolveSync, TOML, YAML } from "bun";
import type { parseSync } from "oxc-parser";
import { copyOf, copyPath, newLoad, sourcePath } from "~/authoring/load-tag";

/**
 * Each load of a workspace's source imports its own copy of every module
 * of its source that its entries reach, by path, so what one load
 * evaluated, or failed to evaluate, is never what another gets: a module
 * cannot be unloaded, but a copy is a different module. A copy is the
 * file's path with its load's tag in the query (`authoring/load-tag.ts`);
 * stack frames name it, so its code says which load it belongs to, and
 * `fileURLToPath(import.meta.url)` still names the file.
 *
 * A load is one module of its own (`marbles-load:<n>`) that imports a copy
 * of each entry in order. A copy is the file's own text with its imports
 * pointed at copies of the same load, found by parsing it, so nothing but
 * an import's specifier is ever changed:
 *
 * - each specifier of an `import`, `export … from`, type-only or
 *   side-effect import, or a literal `import()`, that names a module by its
 *   path (anywhere but under `node_modules` or in Marbles' own code) names
 *   that module's copy; one named as a package never does;
 * - every other `import()` goes through `importFrom`, which resolves what
 *   it is given from the importing file as Bun would, and imports the copy
 *   of the same load when that is a module of the workspace;
 * - a linked library (`linkLibrary`: `@foundry.sh/marbles` and its
 *   `prebuilt`) is the load's own binding of it, whose words name the load
 *   whenever they are called.
 *
 * A data file named by path (JSON, JSONC, TOML, YAML, text, by its
 * extension or the import's `type` attribute) is a copy too, read afresh
 * for each load. So a module two entries import is one module, an import
 * computed at run time gets the load's own copy, and packages, Marbles
 * included, stay one instance per process. Bun calls no resolve hook for
 * an extensionless import, which is why imports are rewritten rather than
 * resolved. `require` is left as written. A file that does not parse is
 * the load's error, never loaded unrewritten.
 *
 * Each load evaluates again every module and data file its source reaches
 * by path, and Bun keeps a load's copies for as long as the process runs.
 */

const COPY = /\?marbles-load=\d+(?:&format=\w+)?$/;
/** An import's `with { type: … }` (or `assert`), right after its specifier. */
const ATTRIBUTE = /^\s*(?:with|assert)\s*\{\s*type\s*:\s*["']([\w-]+)["']/;
/** A dynamic import given options after its specifier. */
const OPTIONS = /^\s*,/;
/** A specifier that names a file by its path, not a package by its name. */
const BY_PATH = /^(?:\.{1,2}\/|\/|file:)/;
/**
 * Marbles' own code, which every load shares: a copy of it would be a
 * second Marbles. Its examples and templates are authored source.
 */
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
/** How each kind of data file a load copies is read, by extension. */
const DATA: Readonly<Record<string, DataFormat>> = {
  ".json": "json",
  ".jsonc": "jsonc",
  ".toml": "toml",
  ".txt": "text",
  ".yaml": "yaml",
  ".yml": "yaml",
};
/** The same, by an import's `type` attribute. */
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

/**
 * `oxc-parser`, loaded at the first load: a missing native binding is that
 * load's error, saying what to install, not an import that fails before
 * anything runs.
 */
async function parser(): Promise<typeof parseSync> {
  if (parse === undefined) {
    try {
      ({ parseSync: parse } = await import("oxc-parser"));
    } catch (error) {
      throw new Error(
        `Marbles reads a workspace's source with oxc-parser, and its native binding for ${process.platform}-${process.arch} could not be loaded: ${error instanceof Error ? error.message : String(error)}. Reinstall @foundry.sh/marbles with optional dependencies included, or install @oxc-parser/binding-wasm32-wasi and set NAPI_RS_FORCE_WASI=1`,
        { cause: error }
      );
    }
  }
  return parse;
}

/** Where a copy's computed `import()` calls in; set once the hook is registered. */
const IMPORT_FROM = Symbol.for("marbles.importFrom");

/** Each load's workspace root, by real path. */
const roots = new Map<number, string>();
/** What each load imports in place of a package, by the package's specifier. */
const libraries = new Map<
  string,
  (load: number) => Readonly<Record<string, unknown>>
>();

/**
 * Give every load's copies `ofLoad(load)` where they import `specifier`:
 * the Marbles library, whose words then name the load they were imported
 * by.
 */
export function linkLibrary(
  specifier: string,
  ofLoad: (load: number) => Readonly<Record<string, unknown>>
): void {
  libraries.set(specifier, ofLoad);
}

/** The module load `load` imports in place of `specifier`. */
function libraryOf(specifier: string, load: number): string {
  return `marbles-load:${String(load)}/${specifier}`;
}
let modules: PluginBuilder | undefined;

function inside(directory: string, file: string): boolean {
  return file.startsWith(`${directory}${sep}`);
}

/**
 * Where `specifier` leads from `directory`, as Bun resolves it: a real path
 * for a file, the specifier itself for a builtin, undefined when nothing
 * is there, which Bun reports as the import runs.
 */
function resolved(specifier: string, directory: string): string | undefined {
  const named = specifier.startsWith("file:")
    ? fileURLToPath(specifier)
    : specifier;
  let target: string;
  try {
    target = resolveSync(named, directory);
  } catch (error) {
    if (error instanceof Error) {
      return;
    }
    throw error;
  }
  return isAbsolute(target) ? realpathSync(target) : target;
}

/**
 * The copy of load `load` that `target`, named by its path, is imported
 * as: any module of the workspace's own source, under its root or not,
 * but none under `node_modules` and none of Marbles' own code, which stay
 * one instance per process.
 */
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

/** The `type` an import's options ask for, if any. */
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

/**
 * A computed `import()` in load `load`'s copy of `file`: `specifier`
 * resolved from `file`, and the load's own copy when it is one of the
 * workspace's modules, else what it resolves to.
 */
function importFrom(
  file: string,
  load: number,
  specifier: unknown,
  options?: ImportCallOptions
): Promise<unknown> {
  const named = String(specifier);
  if (libraries.has(named)) {
    return import(libraryOf(named, load), options);
  }
  const target = resolved(named, dirname(file));
  if (target === undefined) {
    return import(named, options);
  }
  const copy = BY_PATH.test(named)
    ? copyFor(target, load, typeOf(options))
    : undefined;
  return import(copy ?? target, options);
}

interface Edit {
  readonly end: number;
  readonly start: number;
  readonly text: string;
}

/** The string a specifier's literal spells, or undefined for anything computed. */
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

/** What to put in place of a relative specifier of load `load`'s copy of `file`, if anything. */
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

/** Every edit that points `file`'s imports at load `load`'s copies. */
function importEdits(file: string, text: string, load: number): Edit[] {
  if (parse === undefined) {
    throw new Error(`${file} is a copy of a load that has not started`);
  }
  const { errors, module } = parse(file, text);
  const [error] = errors;
  if (error !== undefined) {
    // Loaded unrewritten, it would reach stale modules: the load fails.
    throw new SyntaxError(`${file} does not parse: ${error.message}`);
  }
  const requests = [
    ...module.staticImports.map((entry) => entry.moduleRequest),
    ...module.staticExports.flatMap((entry) =>
      entry.entries.flatMap(({ moduleRequest }) =>
        moduleRequest === null ? [] : [moduleRequest]
      )
    ),
  ];
  const edits: Edit[] = [];
  const seen = new Set<number>();
  for (const request of requests) {
    if (seen.has(request.start)) {
      continue;
    }
    seen.add(request.start);
    const type = ATTRIBUTE.exec(text.slice(request.end))?.[1];
    const edit = specifierEdit(file, load, request, request.value, type);
    if (edit !== undefined) {
      edits.push(edit);
    }
  }
  for (const call of module.dynamicImports) {
    const argument = call.moduleRequest;
    const value = literal(text.slice(argument.start, argument.end));
    // Given options (a `type`, say), it goes through `importFrom`, which reads them.
    if (value !== undefined && !OPTIONS.test(text.slice(argument.end))) {
      const edit = specifierEdit(file, load, argument, value);
      if (edit !== undefined) {
        edits.push(edit);
      }
      continue;
    }
    // `import(` and whatever sits before the argument, on the same lines.
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

/** `file`'s text with its imports pointed at load `load`'s copies, and nothing else changed. */
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

/**
 * A data file's exports, as Bun gives them: the value as the default, and
 * each top-level key of an object as a name of its own.
 */
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

/** Every source file each load has read, its modules and data files alike, by load. */
const read = new Map<number, Set<string>>();
/** Who hears of each file a load reads for the first time, by load: while it loads and after. */
const readers = new Map<number, (file: string) => void>();

/**
 * Tell `listener` of each file load `load` reads from now on for the first
 * time, a module or a data file, while it loads and after, as its run-time
 * imports read more; until `forget` is called.
 */
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

/**
 * Every file load `load` read through its copies, its modules and data
 * files alike, sorted, and forget them: what the load depends on, as a
 * fingerprint of it digests them.
 */
export function filesRead(load: number): readonly string[] {
  const files = [...(read.get(load) ?? [])].sort();
  read.delete(load);
  return files;
}

/** Load every copy as a copy of its load; registered once. */
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

/**
 * Import `files`, the entries of the workspace at `root`, in order, each
 * as a copy of load `load`, a new one when omitted. `copyModules` must have
 * been registered.
 */
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
