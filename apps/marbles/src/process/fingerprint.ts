import { createHash } from "node:crypto";
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";

import type { WorkspaceRecord } from "~/lib/state/workspace";
import { DATA_EXTENSIONS, isModulePath } from "~/workspace/source";

const SKIPPED = new Set([
  ".cache",
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

const TREE_LIMIT = 20_000;

const CHANGED = "changed since it was read";

export class FileDigests {
  readonly #known = new Map<
    string,
    { readonly hash: string; readonly mtimeMs: number; readonly size: number }
  >();

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

  modified(file: string): number | undefined {
    return statSync(file, { throwIfNoEntry: false })?.mtimeMs;
  }
}

export interface WorkspacePrint {
  readonly files: ReadonlyMap<string, string>;
  readonly outside: ReadonlyMap<string, string>;
  readonly root: string;
  readonly tree: string;
}

export interface Fingerprint {
  readonly digest: string;
  readonly installation: string;
  readonly sources: ReadonlyMap<string, WorkspacePrint>;
}

type Registration = Pick<WorkspaceRecord, "config" | "id" | "root">;

function isUnder(root: string, file: string): boolean {
  const path = relative(root, file);
  return path !== "" && !path.startsWith("..") && !path.startsWith(sep);
}

function importable(file: string): boolean {
  return (
    isModulePath(file) ||
    DATA_EXTENSIONS.has(extname(file)) ||
    basename(file).startsWith(".env")
  );
}

function entriesOf(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

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

export function treeDigest(
  registration: Registration,
  digests: FileDigests,
  ignored: ReadonlySet<string> = new Set()
): string {
  return digestOfTree(treeFiles(registration, digests, ignored).files);
}

function treeFiles(
  registration: Registration,
  digests: FileDigests,
  ignored: ReadonlySet<string>
): { readonly files: ReadonlyMap<string, string>; readonly root: string } {
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
  return { files: entries, root };
}

function digestOfTree(files: ReadonlyMap<string, string>): string {
  const hash = createHash("sha256");
  for (const [path, digest] of [...files].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    hash.update(`\0${path}\0${digest}`);
  }
  return hash.digest("hex");
}

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

export function withRead(
  print: WorkspacePrint,
  file: string,
  readAt: number,
  digests: FileDigests
): WorkspacePrint {
  const covered =
    isUnder(print.root, file) && print.files.has(relative(print.root, file));
  if (covered || print.outside.has(file)) {
    return print;
  }
  const modified = digests.modified(file);
  const unchanged = modified !== undefined && modified < readAt;
  const outside = new Map(print.outside);
  outside.set(file, (unchanged && digests.of(file)) || CHANGED);
  return { ...print, outside };
}

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
  return {
    files: tree.files,
    outside: read,
    root: tree.root,
    tree: digestOfTree(tree.files),
  };
}

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

export function watching(
  candidate: Fingerprint,
  watched: Fingerprint | undefined
): Fingerprint {
  if (watched === undefined) {
    return candidate;
  }
  const sources = new Map<string, WorkspacePrint>();
  for (const [id, print] of candidate.sources) {
    const kept = watched.sources.get(id)?.outside ?? new Map<string, string>();
    sources.set(id, {
      ...print,
      outside: new Map([...kept, ...print.outside]),
    });
  }
  return fingerprintOf(candidate.installation, sources);
}

const shared = new FileDigests();

export function sourceDigests(
  records: readonly Registration[],
  files: ReadonlyMap<string, readonly string[]>
): ReadonlyMap<string, string> {
  const digests = new Map<string, string>();
  for (const record of records) {
    const tree = printNow(record, [], shared);
    const outside = (files.get(record.id) ?? []).filter(
      (file) =>
        !(isUnder(tree.root, file) && tree.files.has(relative(tree.root, file)))
    );
    const print = printNow(record, outside, shared);
    digests.set(
      record.id,
      fingerprintOf("", new Map([[record.id, print]])).digest
    );
  }
  return digests;
}

export function installationDigest(entry: string, version: string): string {
  const root = entry.endsWith(".ts") ? dirname(dirname(entry)) : dirname(entry);
  const hash = createHash("sha256");
  hash.update(version);
  for (const file of installationFiles(root)) {
    let stamp: string;
    try {
      const stat = statSync(file);
      stamp = `${String(stat.size)}:${String(stat.mtimeMs)}`;
    } catch {
      stamp = "missing";
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
