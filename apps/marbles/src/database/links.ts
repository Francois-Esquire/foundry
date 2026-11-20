import { randomUUID } from "node:crypto";
import { promises as filesystem, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readlink,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { hasErrorCode } from "@foundry/lib/atomic-file";
import {
  FileLockTimeoutError,
  tryFileLock,
  withFileLock,
} from "@foundry/lib/file-lock";
import type { ArtifactFile, ResourceView } from "~/database/resources";
import { artifactBlobs } from "~/database/stores";
import { workspaceLinks } from "~/layout";
import type { ResourceRef } from "~/lib/resources";

export interface LinksReport {
  readonly kept: readonly string[];
  readonly linked: number;
  readonly refused: readonly string[];
  readonly unlinkable: number;
}

export class LinksPlacementError extends Error {
  override readonly name = "LinksPlacementError";
}

const ARTIFACTS_DIR = "artifacts";
const LOCK_FILE = ".lock";
const SHARED_PREFIX = "@";
const NAME_BYTES = 255;
const LOCK_WAIT_MS = 60_000;
const LOCK_RETRY_MS = 10;
const ATTEMPTS = 3;
const KEPT = /^[a-z0-9\-_.!~*'()]$/;

export function linkName(name: string): string {
  let encoded = "";
  for (const character of name) {
    encoded += KEPT.test(character) ? character : escaped(character);
  }
  return encoded === "." || encoded === ".."
    ? encoded.replaceAll(".", "%2E")
    : encoded;
}

function escaped(character: string): string {
  return [...new TextEncoder().encode(character)]
    .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
    .join("");
}

export function artifactPlace(
  ref: ResourceRef,
  workspace: string
): readonly string[] {
  return ref.owner === workspace
    ? [linkName(ref.id)]
    : [`${SHARED_PREFIX}${linkName(ref.owner)}`, linkName(ref.id)];
}

export interface RebuildLinksOptions {
  readonly artifacts: string;
  readonly root: string;
  readonly view: ResourceView;
  readonly workspace: string;
}

const REBUILD_ROUNDS = 3;

export async function rebuildLinks(
  options: RebuildLinksOptions
): Promise<LinksReport> {
  const { artifacts, root, view, workspace } = options;
  const tree = new LinkTree(root, artifacts);
  await tree.open(true);
  return tree.locked(async () => {
    let wanted = await wantedLinks(view, workspace, artifacts);
    let report = emptyReport();
    for (let round = 0; round < REBUILD_ROUNDS; round += 1) {
      report = await tree.reconcile([], wanted, new Map());
      const again = await wantedLinks(view, workspace, artifacts);
      if (sameLinks(again.links, wanted.links)) {
        break;
      }
      wanted = again;
    }
    return report;
  });
}

export interface RelinkArtifactOptions {
  readonly artifacts: string;
  readonly files:
    | readonly ArtifactFile[]
    | (() => Promise<readonly ArtifactFile[]>);
  readonly ref: ResourceRef;
  readonly root: string;
  readonly signal?: AbortSignal;
  readonly workspace: string;
}

export async function relinkArtifact(
  options: RelinkArtifactOptions
): Promise<LinksReport | undefined> {
  const { artifacts, files, ref, root, signal, workspace } = options;
  const tree = new LinkTree(root, artifacts);
  if (!(await tree.open(false))) {
    return;
  }
  const read =
    typeof files === "function" ? files : () => Promise.resolve(files);
  const place = artifactPlace(ref, workspace);
  const ahead = linksOf(place, artifacts, ref, await read());
  const prepared = await tree.prepare(ahead.links);
  try {
    return await tree.locked(
      async () =>
        tree.reconcile(
          place,
          linksOf(place, artifacts, ref, await read()),
          prepared
        ),
      signal
    );
  } finally {
    await tree.discard(prepared);
  }
}

interface WantedLink {
  readonly segments: readonly string[];
  readonly target: string;
}

interface Wanted {
  readonly links: ReadonlyMap<string, WantedLink>;
  readonly unlinkable: number;
}

async function wantedLinks(
  view: ResourceView,
  workspace: string,
  artifacts: string
): Promise<Wanted> {
  const links = new Map<string, WantedLink>();
  let unlinkable = 0;
  for (const { ref } of await view.artifacts()) {
    const one = linksOf(
      artifactPlace(ref, workspace),
      artifacts,
      ref,
      await view.artifactFiles(ref)
    );
    for (const [key, link] of one.links) {
      links.set(key, link);
    }
    unlinkable += one.unlinkable;
  }
  return { links, unlinkable };
}

function linksOf(
  place: readonly string[],
  artifacts: string,
  ref: ResourceRef,
  files: readonly ArtifactFile[]
): Wanted {
  const blobs = artifactBlobs(resolve(artifacts), ref.owner);
  const links = new Map<string, WantedLink>();
  let unlinkable = 0;
  for (const file of files) {
    const path = file.path.split("/");
    const segments = [...place, ...path];
    if (
      file.blob === null ||
      !isSegment(file.blob) ||
      !segments.every(isSegment)
    ) {
      unlinkable += 1;
      continue;
    }
    links.set(segments.join("/"), {
      segments,
      target: join(blobs, file.blob),
    });
  }
  return { links, unlinkable };
}

function isSegment(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    Buffer.byteLength(name) <= NAME_BYTES
  );
}

function sameLinks(
  a: ReadonlyMap<string, WantedLink>,
  b: ReadonlyMap<string, WantedLink>
): boolean {
  return (
    a.size === b.size &&
    [...a].every(([key, link]) => b.get(key)?.target === link.target)
  );
}

function emptyReport(): LinksReport {
  return { kept: [], linked: 0, refused: [], unlinkable: 0 };
}

class Refused extends Error {}

interface Tally {
  readonly kept: Set<string>;
  linked: number;
  readonly refused: Set<string>;
  unlinkable: number;
}

type Prepared = Map<string, { readonly path: string; readonly target: string }>;

class LinkTree {
  readonly #root: string;
  readonly #top: string;
  readonly #dir: string;
  readonly #ours: string;
  #realTop: string | undefined;

  constructor(root: string, artifacts: string) {
    this.#root = resolve(root);
    this.#top = workspaceLinks(this.#root);
    this.#dir = join(this.#top, ARTIFACTS_DIR);
    this.#ours = `${join(resolve(artifacts), "workspaces")}${sep}`;
  }

  async open(create: boolean): Promise<boolean> {
    const top = await lstatOrUndefined(this.#top);
    if (top === undefined && !create) {
      return false;
    }
    try {
      if (top === undefined) {
        await makeDirectory(this.#top);
      }
      const realRoot = await filesystem.realpath(this.#root);
      const found = await lstat(this.#top);
      const realTop = await filesystem.realpath(this.#top);
      if (!isRealDirectory(found) || realTop !== join(realRoot, ".marbles")) {
        throw new Refused(this.#top);
      }
      this.#realTop = realTop;
      await this.#directory(this.#dir);
      await ignoredByGit(this.#top);
    } catch (error) {
      if (error instanceof Refused) {
        throw new LinksPlacementError(
          `${error.message} is not a directory Marbles made; move it away to link the workspace's artifacts`,
          { cause: error }
        );
      }
      throw error;
    }
    return true;
  }

  async locked<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const path = join(this.#top, LOCK_FILE);
    if (signal === undefined) {
      return withFileLock(path, work, {
        breakStale: true,
        waitMs: LOCK_WAIT_MS,
      });
    }
    const deadline = performance.now() + LOCK_WAIT_MS;
    for (;;) {
      signal.throwIfAborted();
      const attempt = tryFileLock(path, { breakStale: true });
      if ("release" in attempt) {
        try {
          return await work();
        } finally {
          attempt.release();
        }
      }
      if (performance.now() >= deadline) {
        throw new FileLockTimeoutError(path, attempt.holder);
      }
      await pause(LOCK_RETRY_MS, signal);
    }
  }

  async prepare(links: ReadonlyMap<string, WantedLink>): Promise<Prepared> {
    const prepared: Prepared = new Map();
    for (const [key, link] of links) {
      const path = await this.#temporary(link).catch(() => undefined);
      if (path !== undefined) {
        prepared.set(key, { path, target: link.target });
      }
    }
    return prepared;
  }

  async discard(prepared: Prepared): Promise<void> {
    for (const { path } of prepared.values()) {
      await this.#checked(dirname(path))
        .then(() => removeLink(path))
        .catch(() => undefined);
    }
  }

  async reconcile(
    scope: readonly string[],
    wanted: Wanted,
    prepared: Prepared
  ): Promise<LinksReport> {
    const report: Tally = {
      kept: new Set(),
      linked: 0,
      refused: new Set(),
      unlinkable: wanted.unlinkable,
    };
    const scoped = await this.#existing(scope);
    if (scoped === "refused") {
      report.refused.add(this.#shown(scope));
      return reportOf(report);
    }
    if (scoped !== undefined) {
      await this.#prune(scoped, [...scope], wanted.links, prepared, report);
    }
    for (const [key, link] of wanted.links) {
      await this.#link(link, prepared.get(key), report);
    }
    if (wanted.links.size === 0) {
      await this.#removeEmptyScope(scope);
    }
    return reportOf(report);
  }

  async #removeEmptyScope(scope: readonly string[]): Promise<void> {
    for (let depth = scope.length; depth > 0; depth -= 1) {
      const path = join(this.#dir, ...scope.slice(0, depth));
      try {
        await this.#checked(path);
        await this.#checked(dirname(path));
      } catch (error) {
        if (error instanceof Refused) {
          return;
        }
        throw error;
      }
      await removeEmpty(path);
    }
  }

  async #existing(
    segments: readonly string[]
  ): Promise<string | "refused" | undefined> {
    let path = this.#dir;
    for (const segment of segments) {
      path = join(path, segment);
      if ((await lstatOrUndefined(path)) === undefined) {
        return;
      }
      try {
        await this.#checked(path);
      } catch (error) {
        if (error instanceof Refused) {
          return "refused";
        }
        throw error;
      }
    }
    return path;
  }

  async #prune(
    dir: string,
    segments: string[],
    wanted: ReadonlyMap<string, WantedLink>,
    prepared: Prepared,
    report: Tally
  ): Promise<void> {
    const keep = new Set([...prepared.values()].map(({ path }) => path));
    try {
      for (const entry of await entriesOf(dir)) {
        const path = join(dir, entry.name);
        const at = [...segments, entry.name];
        if (entry.isSymbolicLink()) {
          await this.#pruneLink(dir, path, at, wanted, keep, report);
        } else if (entry.isDirectory()) {
          await this.#pruneDirectory(dir, path, at, wanted, prepared, report);
        } else {
          report.kept.add(this.#shown(at));
        }
      }
    } catch (error) {
      if (!(error instanceof Refused)) {
        throw error;
      }
      report.refused.add(this.#shown(segments));
    }
  }

  async #pruneLink(
    dir: string,
    path: string,
    at: readonly string[],
    wanted: ReadonlyMap<string, WantedLink>,
    keep: ReadonlySet<string>,
    report: Tally
  ): Promise<void> {
    const target = await readlinkOrUndefined(path);
    if (target === undefined || keep.has(path)) {
      return;
    }
    if (!target.startsWith(this.#ours)) {
      report.kept.add(this.#shown(at));
    } else if (wanted.get(at.join("/"))?.target !== target) {
      await this.#checked(dir);
      await removeLink(path);
    }
  }

  async #pruneDirectory(
    dir: string,
    path: string,
    at: string[],
    wanted: ReadonlyMap<string, WantedLink>,
    prepared: Prepared,
    report: Tally
  ): Promise<void> {
    try {
      await this.#checked(path);
    } catch (error) {
      if (!(error instanceof Refused)) {
        throw error;
      }
      report.refused.add(this.#shown(at));
      return;
    }
    await this.#prune(path, at, wanted, prepared, report);
    await this.#checked(dir);
    await removeEmpty(path);
  }

  async #link(
    link: WantedLink,
    prepared: { readonly path: string; readonly target: string } | undefined,
    report: Tally
  ): Promise<void> {
    let ready = prepared;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        const outcome = await this.#place(link, ready, report);
        if (outcome === "done") {
          return;
        }
      } catch (error) {
        if (error instanceof Refused) {
          report.refused.add(this.#shown(link.segments));
          return;
        }
        if (hasErrorCode(error, "ENAMETOOLONG")) {
          report.unlinkable += 1;
          return;
        }
        if (!hasErrorCode(error, "ENOENT") || attempt === ATTEMPTS) {
          throw error;
        }
      }
      ready = undefined;
    }
  }

  async #place(
    link: WantedLink,
    prepared: { readonly path: string; readonly target: string } | undefined,
    report: Tally
  ): Promise<"done" | "again"> {
    const parent = await this.#directories(link.segments.slice(0, -1));
    const path = join(parent, link.segments.at(-1) ?? "");
    const current = await this.#current(path, link.target);
    if (current === "kept") {
      report.kept.add(this.#shown(link.segments));
      return "done";
    }
    if (current === "right") {
      report.linked += 1;
      return "done";
    }
    const usable =
      prepared !== undefined &&
      prepared.target === link.target &&
      dirname(prepared.path) === parent &&
      (await readlinkOrUndefined(prepared.path)) === link.target;
    const temporary = usable ? prepared.path : await this.#temporary(link);
    const placed =
      temporary === undefined
        ? await this.#replace(parent, path, link.target, current === "stale")
        : await this.#renamed(parent, temporary, path);
    if (placed) {
      report.linked += 1;
      return "done";
    }
    return "again";
  }

  async #renamed(
    parent: string,
    temporary: string,
    path: string
  ): Promise<boolean> {
    await this.#checked(parent);
    await filesystem.rename(temporary, path);
    await this.#madeIn(parent, path, removeLink);
    return true;
  }

  async #replace(
    parent: string,
    path: string,
    target: string,
    stale: boolean
  ): Promise<boolean> {
    if (stale) {
      await this.#checked(parent);
      await removeLink(path);
    }
    await this.#checked(parent);
    try {
      await symlink(target, path);
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) {
        return false;
      }
      throw error;
    }
    await this.#madeIn(parent, path, removeLink);
    return true;
  }

  async #current(
    path: string,
    target: string
  ): Promise<"right" | "kept" | "missing" | "stale"> {
    const found = await lstatOrUndefined(path);
    if (found === undefined) {
      return "missing";
    }
    if (!found.isSymbolicLink()) {
      return "kept";
    }
    const current = await readlinkOrUndefined(path);
    if (current === target) {
      return "right";
    }
    if (current === undefined) {
      return "missing";
    }
    return current.startsWith(this.#ours) ? "stale" : "kept";
  }

  async #temporary(link: WantedLink): Promise<string | undefined> {
    const name = `.${link.segments.at(-1) ?? ""}.${randomUUID().slice(0, 8)}.link`;
    if (Buffer.byteLength(name) > NAME_BYTES) {
      return;
    }
    const parent = await this.#directories(link.segments.slice(0, -1));
    const path = join(parent, name);
    await this.#checked(parent);
    await symlink(link.target, path);
    await this.#madeIn(parent, path, removeLink);
    return path;
  }

  async #directories(segments: readonly string[]): Promise<string> {
    let path = this.#dir;
    await this.#checked(path);
    for (const segment of segments) {
      path = join(path, segment);
      await this.#directory(path);
    }
    return path;
  }

  async #directory(path: string): Promise<void> {
    if ((await lstatOrUndefined(path)) === undefined) {
      const parent = dirname(path);
      await this.#checked(parent);
      if (await makeDirectory(path)) {
        await this.#madeIn(parent, path, removeEmpty);
      }
    }
    await this.#checked(path);
  }

  async #madeIn(
    parent: string,
    path: string,
    remove: (path: string) => Promise<void>
  ): Promise<void> {
    try {
      await this.#checked(parent);
    } catch (error) {
      await remove(path).catch(() => undefined);
      throw error;
    }
  }

  async #checked(dir: string): Promise<void> {
    const top = this.#realTop;
    const found = await lstatOrUndefined(dir);
    if (top === undefined || found === undefined || !isRealDirectory(found)) {
      throw new Refused(dir);
    }
    let real: string;
    try {
      real = await filesystem.realpath(dir);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
        throw new Refused(dir, { cause: error });
      }
      throw error;
    }
    if (real !== top && !real.startsWith(`${top}${sep}`)) {
      throw new Refused(dir);
    }
  }

  #shown(segments: readonly string[]): string {
    return join(".marbles", ARTIFACTS_DIR, ...segments);
  }
}

function reportOf(tally: Tally): LinksReport {
  return {
    kept: [...tally.kept].sort(byCodeUnit),
    linked: tally.linked,
    refused: [...tally.refused].sort(byCodeUnit),
    unlinkable: tally.unlinkable,
  };
}

function byCodeUnit(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      done();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function makeDirectory(path: string): Promise<boolean> {
  try {
    await mkdir(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      return false;
    }
    throw error;
  }
}

async function ignoredByGit(top: string): Promise<void> {
  try {
    await writeFile(join(top, ".gitignore"), "*\n", { flag: "wx" });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
  }
}

function isRealDirectory(stats: Stats): boolean {
  return stats.isDirectory() && !stats.isSymbolicLink();
}

async function entriesOf(dir: string) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.sort((a, b) => byCodeUnit(a.name, b.name));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
      return [];
    }
    throw error;
  }
}

async function removeLink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function removeEmpty(dir: string): Promise<void> {
  try {
    await rmdir(dir);
  } catch (error) {
    if (
      !(
        hasErrorCode(error, "ENOENT") ||
        hasErrorCode(error, "ENOTEMPTY") ||
        hasErrorCode(error, "EEXIST") ||
        hasErrorCode(error, "ENOTDIR")
      )
    ) {
      throw error;
    }
  }
}

async function readlinkOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readlink(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "EINVAL")) {
      return;
    }
    throw error;
  }
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENAMETOOLONG")) {
      return;
    }
    throw error;
  }
}
