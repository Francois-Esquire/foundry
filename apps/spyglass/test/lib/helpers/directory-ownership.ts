import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";
import { nativeRepositoryReader } from "../../../src/lib/boundary";
import {
  manifestOwnerAt,
  workspaceMemberDirs,
} from "../../../src/lib/boundary-manifest";
import type {
  DirectoryOwnership,
  DirectoryVerdict,
} from "../../../src/lib/boundary-model";

const SKIPPED_DIRS = new Set([".git", "node_modules"]);

export function snapshotDirectoryOwnership(root: string): DirectoryOwnership {
  const members = workspaceMemberDirs(nativeRepositoryReader, root);
  const verdicts = new Map<string, DirectoryVerdict>();
  const unwalked = new Set<string>();
  const record = (dir: string) => {
    try {
      const owner = manifestOwnerAt(nativeRepositoryReader, root, members, dir);
      if (owner !== undefined) {
        verdicts.set(dir, { owner });
      }
    } catch (error) {
      verdicts.set(dir, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const pending = [root];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      unwalked.add(dir);
      continue;
    }

    if (
      dir !== root &&
      entries.some((entry) => entry.name.toLowerCase() === "package.json")
    ) {
      record(dir);
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isSymbolicLink() || SKIPPED_DIRS.has(entry.name)) {
        unwalked.add(child);
      } else if (entry.isDirectory()) {
        pending.push(child);
      }
    }
  }
  return { root, unwalked, verdicts };
}
