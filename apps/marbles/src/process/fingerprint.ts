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
    hash.update(`\0${file}\0${fileStamp(file)}`);
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

/**
 * Every registration's source digest, by workspace id: its source's entry
 * modules as discovery finds them, so an entry added or removed counts,
 * and every file its last load read (`files`, by workspace id: the
 * modules and data files the loader imported, wherever they are), so a
 * helper or a data file one imports counts too. A workspace no load has
 * read yet is its entries alone.
 */
export function sourceDigests(
  records: readonly Pick<WorkspaceRecord, "config" | "id" | "root">[],
  files: ReadonlyMap<string, readonly string[]>
): ReadonlyMap<string, string> {
  const digests = new Map<string, string>();
  for (const record of records) {
    const source = record.config ?? join(record.root, DEFAULT_SOURCE);
    const hash = createHash("sha256");
    hash.update(sourceDigest(source) ?? "none");
    for (const file of files.get(record.id) ?? []) {
      hash.update(`\0${file}\0${fileStamp(file)}`);
    }
    digests.set(record.id, hash.digest("hex"));
  }
  return digests;
}

/** A file's size and modification time, as source watching takes them. */
function fileStamp(file: string): string {
  try {
    const stat = statSync(file);
    return `${String(stat.size)}:${String(stat.mtimeMs)}`;
  } catch {
    return "missing";
  }
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
