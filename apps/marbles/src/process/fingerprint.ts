import { createHash } from "node:crypto";
import { type Dirent, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import type { WorkspaceRecord } from "~/lib/state/workspace";
import { DEFAULT_SOURCE } from "~/workspace/source";
import { sourceDigest } from "~/workspace/watch";

/**
 * What an engine generation loads, as digests the daemon compares to
 * decide when the next one starts: the installation it runs from, and
 * each registered workspace's source. Digests are of each file's path,
 * size and modification time, as source watching takes them, never its
 * contents.
 */
export interface Fingerprint {
  readonly digest: string;
  readonly installation: string;
  /** Each registered workspace's source digest, by workspace id. */
  readonly sources: ReadonlyMap<string, string>;
}

/**
 * A digest of the installation a generation runs from: `version`, and
 * every file under the directory its entry is built into (`dist`), or,
 * run from source, the source directory above it (`src`). Dot files and
 * `node_modules` are left out; paths are taken in sorted order, so the
 * digest does not depend on how a directory lists.
 */
export function installationDigest(entry: string, version: string): string {
  const root = entry.endsWith(".ts") ? dirname(dirname(entry)) : dirname(entry);
  const hash = createHash("sha256");
  hash.update(version);
  for (const file of filesUnder(root)) {
    hash.update(`\0${file}\0`);
    try {
      const stat = statSync(file);
      hash.update(`${String(stat.size)}:${String(stat.mtimeMs)}`);
    } catch {
      hash.update("missing");
    }
  }
  return hash.digest("hex");
}

function filesUnder(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files.sort();
}

/** Every registration's source digest, by workspace id. */
export function sourceDigests(
  records: readonly Pick<WorkspaceRecord, "config" | "id" | "root">[]
): ReadonlyMap<string, string> {
  const digests = new Map<string, string>();
  for (const record of records) {
    const source = record.config ?? join(record.root, DEFAULT_SOURCE);
    digests.set(record.id, sourceDigest(source) ?? "none");
  }
  return digests;
}

/** The fingerprint of `installation` and `sources`, in workspace id order. */
export function fingerprintOf(
  installation: string,
  sources: ReadonlyMap<string, string>
): Fingerprint {
  const hash = createHash("sha256");
  hash.update(installation);
  for (const [id, digest] of [...sources].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    hash.update(`\0${id}\0${digest}`);
  }
  return { digest: hash.digest("hex"), installation, sources };
}
