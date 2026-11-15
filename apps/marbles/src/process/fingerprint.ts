import { createHash } from "node:crypto";
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";

import type { WorkspaceRecord } from "~/lib/state/workspace";
import { DATA_EXTENSIONS, isModulePath } from "~/workspace/source";

/**
 * What an engine generation loaded, as digests the daemon compares to
 * decide when the next one starts: the installation it runs from, and
 * each registered workspace's files. A generation's fingerprint is taken
 * before it loads anything, so an edit made while it loads differs from
 * it at the next poll; it grows as the generation reports files it read
 * outside a workspace's root, each recorded as it was when read.
 *
 * - A workspace's tree is every file under its root a load could read, a
 *   module, a data file or an `.env` file, its path relative to that root
 *   and its content, but those under `SKIPPED` directories: wherever they
 *   sit, whether the last load read them or not, and whether it succeeded
 *   or not. What a run writes there of any other kind counts for nothing.
 * - Files outside the root count only as a generation reported reading
 *   them: what it depends on there, and nothing another generation read.
 *
 * Contents are digested only for a file whose size or modification time
 * changed since it was last digested (`FileDigests`), so a poll costs a
 * stat per file.
 */

/** Directories a workspace tree leaves out: dependencies, history, Marbles' own, and builds. */
const SKIPPED = new Set([
  ".cache",
  ".git",
  ".marbles",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

/** A tree past this many files is digested from its entries' folder alone. */
const TREE_LIMIT = 20_000;

/** A file outside the root that changed between its read and its report: matches no digest. */
const CHANGED = "changed since it was read";

/** Content digests of files, each read again only when its size or modification time changed. */
export class FileDigests {
  readonly #known = new Map<
    string,
    { readonly hash: string; readonly mtimeMs: number; readonly size: number }
  >();

  /** The digest of `file`'s content now; `undefined` when it is not there. */
  of(file: string): string | undefined {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(file);
    } catch {
      this.#known.delete(file);
      return;
    }
    const known = this.#known.get(file);
    if (
      known !== undefined &&
      known.size === stat.size &&
      known.mtimeMs === stat.mtimeMs
    ) {
      return known.hash;
    }
    let hash: string;
    try {
      hash = createHash("sha256").update(readFileSync(file)).digest("hex");
    } catch {
      return;
    }
    this.#known.set(file, { hash, mtimeMs: stat.mtimeMs, size: stat.size });
    return hash;
  }

  /** When `file` was last modified; `undefined` when it is not there. */
  modified(file: string): number | undefined {
    return statSync(file, { throwIfNoEntry: false })?.mtimeMs;
  }
}

/** One workspace's part of a fingerprint. */
export interface WorkspacePrint {
  /** Each file under the root, by its path relative to the root, with its digest: what `tree` digests. */
  readonly files: ReadonlyMap<string, string>;
  /** Each file read outside the root, by absolute path, with its digest as recorded. */
  readonly outside: ReadonlyMap<string, string>;
  /** The digest of every file under the root. */
  readonly tree: string;
}

export interface Fingerprint {
  readonly digest: string;
  readonly installation: string;
  /** Each registered workspace's part, by workspace id. */
  readonly sources: ReadonlyMap<string, WorkspacePrint>;
}

/** The workspace's root, as its registration names it. */
type Registration = Pick<WorkspaceRecord, "config" | "id" | "root">;

/** Whether `file` is under `root`. */
function isUnder(root: string, file: string): boolean {
  const path = relative(root, file);
  return path !== "" && !path.startsWith("..") && !path.startsWith(sep);
}

/**
 * Whether a load could read `file`: a module, a data file it imports by
 * path, or an environment file its schema loads. What a run writes under
 * the root (a log, a report) is none of them, and never starts a switch.
 */
function importable(file: string): boolean {
  return (
    isModulePath(file) ||
    DATA_EXTENSIONS.has(extname(file)) ||
    basename(file).startsWith(".env")
  );
}

/** The entries of `dir`; none when it cannot be read. */
function entriesOf(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Every file under `dir`, sorted, but those under skipped directories or
 * any of `ignored`; `undefined` past `limit`.
 */
function filesBelow(
  dir: string,
  limit: number,
  ignored: ReadonlySet<string>
): string[] | undefined {
  const files: string[] = [];
  const pending = [dir];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    for (const entry of entriesOf(at)) {
      const path = join(at, entry.name);
      if (SKIPPED.has(entry.name) || ignored.has(path)) {
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile() && importable(path)) {
        files.push(path);
      }
    }
    if (files.length > limit) {
      return;
    }
  }
  return files.sort();
}

/**
 * The digest of every file under the workspace's root, each by its path
 * relative to the root and its content, but those under `ignored`: the
 * Foundry home, say, when it sits inside the root, whose database changes
 * as Marbles runs. A root past `TREE_LIMIT` files is digested from its
 * source's folder alone.
 */
export function treeDigest(
  registration: Registration,
  digests: FileDigests,
  ignored: ReadonlySet<string> = new Set()
): string {
  return digestOfTree(treeFiles(registration, digests, ignored));
}

/** The files `treeDigest` digests, by path relative to the root, each with its digest. */
function treeFiles(
  registration: Registration,
  digests: FileDigests,
  ignored: ReadonlySet<string>
): ReadonlyMap<string, string> {
  let { root } = registration;
  let files = filesBelow(root, TREE_LIMIT, ignored);
  if (files === undefined && registration.config !== null) {
    root = dirname(registration.config);
    files = filesBelow(root, TREE_LIMIT, ignored);
  }
  const entries = new Map<string, string>();
  for (const file of files ?? []) {
    entries.set(relative(root, file), digests.of(file) ?? "missing");
  }
  return entries;
}

/** The digest of a tree's files, in path order. */
function digestOfTree(files: ReadonlyMap<string, string>): string {
  const hash = createHash("sha256");
  for (const [path, digest] of [...files].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    hash.update(`\0${path}\0${digest}`);
  }
  return hash.digest("hex");
}

/**
 * What differs between `was` and `now`, a line each, for whoever must say
 * why a switch was asked for: the installation, a workspace registered or
 * not, and each file under a root or read outside it that is not as it was.
 */
export function differences(was: Fingerprint, now: Fingerprint): string[] {
  const lines: string[] = [];
  if (was.installation !== now.installation) {
    lines.push("the installation changed");
  }
  const ids = new Set([...was.sources.keys(), ...now.sources.keys()]);
  for (const id of [...ids].sort()) {
    const before = was.sources.get(id);
    const after = now.sources.get(id);
    if (before === undefined || after === undefined) {
      lines.push(
        `workspace ${id} ${before === undefined ? "added" : "removed"}`
      );
      continue;
    }
    for (const [label, one, other] of [
      ["under its root", before.files, after.files],
      ["read outside its root", before.outside, after.outside],
    ] as const) {
      const paths = new Set([...one.keys(), ...other.keys()]);
      for (const path of [...paths].sort()) {
        if (one.get(path) !== other.get(path)) {
          lines.push(
            `workspace ${id}: ${path} ${label} (${one.get(path) ?? "absent"} → ${other.get(path) ?? "absent"})`
          );
        }
      }
    }
  }
  return lines;
}

/**
 * `print` with `file`, which a generation read at `readAt` (ms since the
 * epoch), recorded: by its digest now when it has not changed since it was
 * read, else as changed, which matches no digest, so the next poll starts
 * the next generation. A file under the root, or recorded already, leaves
 * the print as it was.
 */
export function withRead(
  registration: Registration,
  print: WorkspacePrint,
  file: string,
  readAt: number,
  digests: FileDigests
): WorkspacePrint {
  if (isUnder(registration.root, file) || print.outside.has(file)) {
    return print;
  }
  const modified = digests.modified(file);
  const unchanged = modified !== undefined && modified < readAt;
  const outside = new Map(print.outside);
  outside.set(file, (unchanged && digests.of(file)) || CHANGED);
  return { files: print.files, outside, tree: print.tree };
}

/**
 * What `registration` is now, over the files outside its root that
 * `outside` names: those a generation read there, with what they hold now.
 */
export function printNow(
  registration: Registration,
  outside: Iterable<string>,
  digests: FileDigests,
  ignored: ReadonlySet<string> = new Set()
): WorkspacePrint {
  const tree = treeFiles(registration, digests, ignored);
  const read = new Map<string, string>();
  for (const file of outside) {
    read.set(file, digests.of(file) ?? "missing");
  }
  return { files: tree, outside: read, tree: digestOfTree(tree) };
}

/** The fingerprint of `installation` and `sources`, in workspace id and file order. */
export function fingerprintOf(
  installation: string,
  sources: ReadonlyMap<string, WorkspacePrint>
): Fingerprint {
  const hash = createHash("sha256");
  hash.update(installation);
  for (const [id, print] of [...sources].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    hash.update(`\0${id}\0${print.tree}`);
    for (const [file, digest] of [...print.outside].sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      hash.update(`\0${file}\0${digest}`);
    }
  }
  return { digest: hash.digest("hex"), installation, sources };
}

const shared = new FileDigests();

/**
 * Every registration's digest now, by workspace id: its tree, and each of
 * `files` (by workspace id) its loads read outside its root.
 */
export function sourceDigests(
  records: readonly Registration[],
  files: ReadonlyMap<string, readonly string[]>
): ReadonlyMap<string, string> {
  const digests = new Map<string, string>();
  for (const record of records) {
    const outside = (files.get(record.id) ?? []).filter(
      (file) => !isUnder(record.root, file)
    );
    const print = printNow(record, outside, shared);
    digests.set(
      record.id,
      fingerprintOf("", new Map([[record.id, print]])).digest
    );
  }
  return digests;
}

/**
 * A digest of the installation a generation runs from: `version`, and
 * every file under the directory its entry is built into (`dist`), or,
 * run from source, the source directory above it (`src`), by path, size
 * and modification time. Dot files and `node_modules` are left out; paths
 * are taken in sorted order, so the digest does not depend on how a
 * directory lists.
 */
export function installationDigest(entry: string, version: string): string {
  const root = entry.endsWith(".ts") ? dirname(dirname(entry)) : dirname(entry);
  const hash = createHash("sha256");
  hash.update(version);
  for (const file of installationFiles(root)) {
    let stamp = "missing";
    try {
      const stat = statSync(file);
      stamp = `${String(stat.size)}:${String(stat.mtimeMs)}`;
    } catch {
      // Gone since it was listed.
    }
    hash.update(`\0${file}\0${stamp}`);
  }
  return hash.digest("hex");
}

function installationFiles(root: string): string[] {
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
