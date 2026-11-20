import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";

export function snapshotTrees(
  roots: readonly string[],
  ignored: ReadonlySet<string> = new Set(),
  scratchDirectory?: string
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
    const mode = stats.mode.toString(8);
    if (stats.isSymbolicLink()) {
      found[path] =
        `link ${mode} ${String(stats.mtimeMs)} -> ${readlinkSync(path)}`;
    } else if (stats.isDirectory()) {
      found[path] =
        path === scratchDirectory
          ? `directory ${mode}`
          : `directory ${mode} ${String(stats.mtimeMs)}`;
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
