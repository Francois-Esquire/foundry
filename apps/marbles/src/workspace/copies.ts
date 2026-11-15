import { realpathSync } from "node:fs";
import { dirname, sep } from "node:path";
import type { PluginBuilder } from "bun";
import { resolveSync } from "bun";

/**
 * Each load of a workspace's source imports its own copy of every module
 * under the workspace's root that its entries reach, so what one load
 * evaluated, or failed to evaluate, is never what another gets: a module
 * cannot be unloaded, but a copy is a different module. A copy is the
 * file's path with this load's tag in its query; stack frames and
 * `fileURLToPath(import.meta.url)` still name the file.
 *
 * An import is copied when the module importing it is a copy, and what it
 * names is under that copy's workspace root, outside `node_modules`:
 * packages, Marbles included, stay one instance per process. A module a
 * copy imports later, outside any load, joins the newest load of that
 * module's workspace.
 */

/** What a copy's query starts with. */
const TAG = "?marbles-load=";

/** The newest load that copied each file, by its real path. */
const copiedBy = new Map<string, number>();
/** Each load's workspace root. */
const roots = new Map<number, string>();
let loads = 0;

const RELATIVE_OR_ABSOLUTE = /^(?:\.{1,2}\/|\/)/;

function inside(root: string, file: string): boolean {
  return (
    file.startsWith(`${root}${sep}`) &&
    !file.slice(root.length).includes(`${sep}node_modules${sep}`)
  );
}

function tagged(file: string, load: number): string {
  return `${file}${query(load)}`;
}

function query(load: number): string {
  return `${TAG}${String(load)}`;
}

function untagged(path: string): string {
  const start = path.indexOf("?");
  return start === -1 ? path : path.slice(0, start);
}

/** Resolve the imports of every copy to copies of the same load; registered once. */
export function copyModules(builder: PluginBuilder): void {
  builder.onResolve({ filter: RELATIVE_OR_ABSOLUTE }, (args) => {
    const load = copiedBy.get(untagged(args.importer));
    const root = load === undefined ? undefined : roots.get(load);
    // A copy's own path comes back here once it is chosen: it stays as it is.
    // Bun asks again from the directory, which is no copy, for its own
    // resolution below.
    if (load === undefined || root === undefined || args.path.includes(TAG)) {
      return;
    }
    const file = realpathSync(
      resolveSync(args.path, dirname(untagged(args.importer)))
    );
    if (!inside(root, file)) {
      return;
    }
    copiedBy.set(file, load);
    return { path: tagged(file, load) };
  });
}

/**
 * A new load of the workspace at `root`: what to import each of its
 * entries as, a copy of its own.
 */
export function newLoad(root: string): (file: string) => string {
  loads += 1;
  const load = loads;
  roots.set(load, realpathSync(root));
  return (file) => {
    const real = realpathSync(file);
    copiedBy.set(real, load);
    // A path, not a `file:` URL: Bun keys a URL's module by its path alone.
    return tagged(real, load);
  };
}
