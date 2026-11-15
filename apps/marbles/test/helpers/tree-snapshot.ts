import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";

/**
 * What is at every path under each of `roots`, the roots included, keyed
 * by absolute path: a directory's mode and modification time (so an entry
 * made and removed again shows), a file's mode, size, modification time
 * and a digest of its bytes, a link's mode, time and target. Access times
 * are left out: reading changes them. A root that is not there has no key,
 * so one made later shows; a path in `ignored` is left out, whole.
 */
export function snapshotTrees(
  roots: readonly string[],
  ignored: ReadonlySet<string> = new Set()
): Record<string, string> {
  const found: Record<string, string> = {};
  const visit = (path: string): void => {
    if (ignored.has(path)) {
      return;
    }
    let stats: Stats;
    try {
      stats = lstatSync(path);
    } catch {
      return;
    }
    // The whole mode, kind bits too: a change of either shows.
    const mode = stats.mode.toString(8);
    if (stats.isSymbolicLink()) {
      found[path] =
        `link ${mode} ${String(stats.mtimeMs)} -> ${readlinkSync(path)}`;
    } else if (stats.isDirectory()) {
      found[path] = `directory ${mode} ${String(stats.mtimeMs)}`;
      for (const name of readdirSync(path).sort()) {
        visit(join(path, name));
      }
    } else if (stats.isFile()) {
      const digest = createHash("sha256")
        .update(readFileSync(path))
        .digest("hex");
      found[path] =
        `file ${mode} ${String(stats.size)} ${String(stats.mtimeMs)} ${digest}`;
    } else {
      found[path] = `other ${mode} ${String(stats.mtimeMs)}`;
    }
  };
  for (const root of roots) {
    visit(root);
  }
  return found;
}
