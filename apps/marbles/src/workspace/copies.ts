import { readFileSync, realpathSync } from "node:fs";
import { dirname, extname, sep } from "node:path";
import type { JavaScriptLoader, PluginBuilder } from "bun";
import { resolveSync, Transpiler } from "bun";

/**
 * Each load of a workspace's source imports its own copy of every module
 * under the workspace's root that its entries reach, so what one load
 * evaluated, or failed to evaluate, is never what another gets: a module
 * cannot be unloaded, but a copy is a different module. A copy is the
 * file's path with its load's tag in the query; stack frames and
 * `fileURLToPath(import.meta.url)` still name the file.
 *
 * A load is one module of its own (`marbles-load:<n>`) that imports a copy
 * of each entry in order. A copy is the file's own text with each relative
 * import that names a module under the workspace's root, outside
 * `node_modules`, pointed at that module's copy of the same load, so a
 * module two entries import is one module, and packages, Marbles
 * included, stay one instance per process. Bun calls no resolve hook for
 * an extensionless import, so imports are rewritten as each copy loads
 * rather than resolved.
 */

/** What a copy's path ends with, before its load's number. */
const TAG = "?marbles-load=";
const COPY = /\?marbles-load=(\d+)$/;
const RELATIVE = /^\.{1,2}\//;
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

/** Each load's workspace root, by real path. */
const roots = new Map<number, string>();
let loads = 0;
let modules: PluginBuilder | undefined;

function copyOf(file: string, load: number): string {
  return `${file}${TAG}${String(load)}`;
}

function inside(root: string, file: string): boolean {
  return (
    file.startsWith(`${root}${sep}`) &&
    !file.slice(root.length).includes(`${sep}node_modules${sep}`)
  );
}

/** Where `specifier` leads from `directory`; undefined when nothing is there, which Bun reports as it loads. */
function resolved(specifier: string, directory: string): string | undefined {
  try {
    return realpathSync(resolveSync(specifier, directory));
  } catch (error) {
    // Left as written: Bun reports the missing module as the copy loads.
    if (error instanceof Error) {
      return;
    }
    throw error;
  }
}

/** `file`'s text with its relative imports of the workspace pointed at their copies. */
function copied(
  file: string,
  load: number,
  root: string,
  loader: JavaScriptLoader
): string {
  let text = readFileSync(file, "utf8");
  const specifiers = new Set(
    new Transpiler({ loader })
      .scanImports(text)
      .map(({ path }) => path)
      .filter((path) => RELATIVE.test(path))
  );
  for (const specifier of specifiers) {
    const target = resolved(specifier, dirname(file));
    // Only modules are copied: JSON, text and the like are read as they are.
    if (
      target === undefined ||
      !inside(root, target) ||
      LOADERS[extname(target)] === undefined
    ) {
      continue;
    }
    const to = JSON.stringify(copyOf(target, load));
    text = text
      .replaceAll(JSON.stringify(specifier), to)
      .replaceAll(`'${specifier}'`, to);
  }
  return text;
}

/** Load every copy as a copy of its load; registered once. */
export function copyModules(builder: PluginBuilder): void {
  modules = builder;
  builder.onLoad({ filter: COPY }, (args) => {
    const load = Number(COPY.exec(args.path)?.[1]);
    const file = args.path.slice(0, args.path.lastIndexOf(TAG));
    const root = roots.get(load);
    const loader = LOADERS[extname(file)];
    if (root === undefined || loader === undefined) {
      throw new Error(`${args.path} is a copy of no load`);
    }
    return { contents: copied(file, load, root, loader), loader };
  });
}

/**
 * Import `files`, the entries of the workspace at `root`, in order, each
 * as a copy of this load's own. `copyModules` must have been registered.
 */
export async function importLoad(
  root: string,
  files: readonly string[]
): Promise<void> {
  if (modules === undefined) {
    throw new Error("the source library is not linked yet");
  }
  loads += 1;
  const load = loads;
  roots.set(load, realpathSync(root));
  const contents = files
    .map(
      (file) => `import ${JSON.stringify(copyOf(realpathSync(file), load))};`
    )
    .join("\n");
  const specifier = `marbles-load:${String(load)}`;
  modules.module(specifier, () => ({ contents, loader: "js" }));
  await import(specifier);
}
