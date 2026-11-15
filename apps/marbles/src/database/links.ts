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

/**
 * A workspace's links to the resources it shows, made from the Marbles
 * database alone. Only resources that are files are linked, and only
 * artifacts so far: each file of an artifact's active Content whose bytes
 * one blob file holds becomes a symbolic link to that file, at
 *
 * - `<root>/.marbles/artifacts/<id>/<path>` for an artifact the workspace
 *   owns, and
 * - `<root>/.marbles/artifacts/@<owner>/<id>/<path>` for one shared with
 *   it,
 *
 * each id and owner encoded by `linkName`. A file whose bytes the
 * database holds inline, or several chunks do, has no file to point at and
 * is left out; no file is made for it, nor for a name too long for the file
 * system.
 *
 * Nothing reads the links back. Rebuilding a workspace and updating one
 * artifact both reconcile what is on disk with what the database says
 * should be there: a link Marbles made (one pointing into the artifact
 * store's `workspaces/` directory) that should not be there, or points
 * elsewhere, is removed; one that should be there is made. Anything else,
 * a file or another link, is left as it is and reported.
 *
 * One at a time. Every rebuild and update of a workspace's links, in any
 * process, holds `.marbles/.lock` while it changes them, and reads what
 * the database says each link should be inside it, right before it puts
 * the link in place; a link is put in place by renaming a link made beside
 * it over the old one. A keeper may make that new link before it takes the
 * lock, as a head start, but one the database no longer agrees with is
 * discarded under the lock and made again.
 *
 * What is checked, and what is not. Before each call that makes or
 * removes anything, the directory it is made or removed in is checked with
 * `lstat` to be a directory and not a link, and with `realpath` to be
 * inside the real `.marbles`; a directory that fails is refused, reported,
 * and nothing is made or removed through it. A directory on the way is
 * made one level at a time, never recursively, and an entry is removed one
 * at a time, never a tree. After each directory or link is made, its
 * parent is checked again, and what was made is removed and the link
 * refused if the parent has left `.marbles` meanwhile. This runtime has no
 * calls relative to an open directory, so a process that can write inside
 * the workspace's own directory can still swap a checked directory for a
 * link in the narrow window between a check and the call after it; the
 * check after a creation undoes such a creation, but a removal cannot be
 * undone.
 */

/** What one reconcile did; its paths sorted, the same on every machine. */
export interface LinksReport {
  /** What was in the way and left as it was: not a link Marbles made. */
  readonly kept: readonly string[];
  /** Links in place, made now or already right. */
  readonly linked: number;
  /** Paths refused because a directory on the way is a link, not a directory, or outside `.marbles`. */
  readonly refused: readonly string[];
  /** Files left unlinked: no one blob file holds their bytes, or their path cannot be a link name. */
  readonly unlinkable: number;
}

/** `.marbles` or `.marbles/artifacts` is not a real directory; nothing was touched. */
export class LinksPlacementError extends Error {
  override readonly name = "LinksPlacementError";
}

const ARTIFACTS_DIR = "artifacts";
const LOCK_FILE = ".lock";
const SHARED_PREFIX = "@";
/** The longest name a file system takes, in bytes. */
const NAME_BYTES = 255;
/** How long a rebuild or update waits for another to finish with the links. */
const LOCK_WAIT_MS = 60_000;
/** How often an update that can be stopped tries the links lock again. */
const LOCK_RETRY_MS = 10;
/** How many times a link is tried again when a concurrent cleanup removed its directory. */
const ATTEMPTS = 3;
/** Characters `encodeURIComponent` leaves as they are, but for uppercase letters. */
const KEPT = /^[a-z0-9\-_.!~*'()]$/;

/**
 * `name` as one path segment that no other name shares, on a
 * case-sensitive or case-insensitive file system: every character but a
 * lowercase letter, a digit and `-_.!~*'()` as its UTF-8 percent escapes,
 * uppercase letters included, and `.` or `..` escaped. `decodeURIComponent`
 * gives the name back. It never starts with `@`, which marks another
 * workspace's artifacts.
 */
export function linkName(name: string): string {
  let encoded = "";
  for (const character of name) {
    encoded += KEPT.test(character) ? character : escaped(character);
  }
  return encoded === "." || encoded === ".."
    ? encoded.replaceAll(".", "%2E")
    : encoded;
}

/** `character`'s UTF-8 bytes as `%XX` escapes; a lone surrogate as U+FFFD's. */
function escaped(character: string): string {
  return [...new TextEncoder().encode(character)]
    .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
    .join("");
}

/** Where `ref` is linked in the workspace `workspace`, under `.marbles/artifacts`. */
export function artifactPlace(
  ref: ResourceRef,
  workspace: string
): readonly string[] {
  return ref.owner === workspace
    ? [linkName(ref.id)]
    : [`${SHARED_PREFIX}${linkName(ref.owner)}`, linkName(ref.id)];
}

export interface RebuildLinksOptions {
  /** The shared artifact store, whose blob files the links point at. */
  readonly artifacts: string;
  /** The workspace's root. */
  readonly root: string;
  /** The workspace's own view of its resources. */
  readonly view: ResourceView;
  /** The workspace's id. */
  readonly workspace: string;
}

/** Reads, rounds of reconciling, before a rebuild settles for what it last read. */
const REBUILD_ROUNDS = 3;

/**
 * Make the workspace's links match what its view shows, holding the
 * workspace's links lock. It reads the view again after reconciling, and
 * reconciles once more if a write changed it meanwhile.
 */
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
  /** The shared artifact store, whose blob files the links point at. */
  readonly artifacts: string;
  /**
   * The artifact's files as this workspace should show them, none to
   * unlink it; or how to read them, called again under the links lock
   * right before the links are put in place, so they are what the
   * database says then.
   */
  readonly files:
    | readonly ArtifactFile[]
    | (() => Promise<readonly ArtifactFile[]>);
  readonly ref: ResourceRef;
  /** The workspace's root. */
  readonly root: string;
  /**
   * Gives up waiting for the links lock once it aborts, rejecting with its
   * reason: nothing is changed then, and what was made ahead is removed.
   * Work already holding the lock runs to its end.
   */
  readonly signal?: AbortSignal;
  /** The workspace's id. */
  readonly workspace: string;
}

/**
 * Make one artifact's links in the workspace at `root` match its files.
 * For a workspace whose `.marbles` is there: one that has none was never
 * linked, and nothing makes it here (undefined).
 */
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

/** A link to make: its path under `.marbles/artifacts`, and what it points at. */
interface WantedLink {
  readonly segments: readonly string[];
  readonly target: string;
}

interface Wanted {
  /** By path under `.marbles/artifacts`, joined with `/`. */
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

/** A name that is one path segment of its own, short enough for the file system. */
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

/** A directory on the way to a link is a link, not a directory, or outside `.marbles`. */
class Refused extends Error {}

/** What a reconcile counts as it goes. */
interface Tally {
  readonly kept: Set<string>;
  linked: number;
  readonly refused: Set<string>;
  unlinkable: number;
}

/** A link made beside where one goes, by its key, and what it points at. */
type Prepared = Map<string, { readonly path: string; readonly target: string }>;

/**
 * The links under one workspace's `.marbles/artifacts`, changed only
 * through directories checked to be real ones inside the real `.marbles`.
 */
class LinkTree {
  readonly #root: string;
  readonly #top: string;
  readonly #dir: string;
  /** Targets of links Marbles made start here. */
  readonly #ours: string;
  /** `.marbles` with every link resolved, once `open` has checked it. */
  #realTop: string | undefined;

  constructor(root: string, artifacts: string) {
    this.#root = resolve(root);
    this.#top = workspaceLinks(this.#root);
    this.#dir = join(this.#top, ARTIFACTS_DIR);
    this.#ours = `${join(resolve(artifacts), "workspaces")}${sep}`;
  }

  /**
   * Check `.marbles` and `.marbles/artifacts` are real directories, making
   * them when `create` (`.marbles` only then; `artifacts` always). Whether
   * the workspace has links at all.
   */
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

  /**
   * Run `work` holding the workspace's links lock, which every process
   * takes. With `signal`, waiting for it stops once that aborts.
   */
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

  /**
   * Make each of `links` beside where it goes, ahead of taking the lock;
   * one that cannot be made now is made under the lock instead.
   */
  async prepare(links: ReadonlyMap<string, WantedLink>): Promise<Prepared> {
    const prepared: Prepared = new Map();
    for (const [key, link] of links) {
      try {
        const path = await this.#temporary(link);
        if (path !== undefined) {
          prepared.set(key, { path, target: link.target });
        }
      } catch {
        // Made under the lock, or refused there.
      }
    }
    return prepared;
  }

  /** Remove what `prepare` made that was not put in place; one renamed into place is gone already. */
  async discard(prepared: Prepared): Promise<void> {
    for (const { path } of prepared.values()) {
      try {
        await this.#checked(dirname(path));
        await removeLink(path);
      } catch {
        // Its directory went away or was refused; nothing of ours is left there.
      }
    }
  }

  /**
   * Make what is under `scope` (segments under `.marbles/artifacts`, none
   * for all of it) match `wanted`, which holds only paths under `scope`,
   * using what `prepared` made where it still points the right way.
   */
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
    // Each prepared link is renamed into place or left for `discard`.
    for (const [key, link] of wanted.links) {
      await this.#link(link, prepared.get(key), report);
    }
    if (wanted.links.size === 0) {
      await this.#removeEmptyScope(scope);
    }
    return reportOf(report);
  }

  /**
   * Remove the directories of `scope` left empty, deepest first, each in
   * its checked parent: an artifact unlinked, and its owner's directory
   * once it holds none.
   */
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

  /**
   * The directory at `segments` under `artifacts`, when every component
   * down to it is a real directory inside `.marbles`; undefined when one is
   * missing, `refused` when one is not.
   */
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

  /**
   * Remove, one entry at a time, the links Marbles made under `dir` that
   * `wanted` does not hold as they are, and the directories that leaves
   * empty. A directory that is no longer a real one inside `.marbles`,
   * `dir` included, is refused, reported, and not entered or changed.
   */
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

  /** Remove the link at `path` in `dir` if Marbles made it and `wanted` does not hold it as it is. */
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

  /** Prune the directory at `path` in `dir`, and remove it if that leaves it empty. */
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

  /** Put `link` in place, from `prepared` when it still points there. */
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
        // A concurrent cleanup removed a directory on the way: again.
        if (!hasErrorCode(error, "ENOENT") || attempt === ATTEMPTS) {
          throw error;
        }
      }
      ready = undefined;
    }
  }

  /** One try at putting `link` in place: done, or to be made again. */
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

  /** Rename `temporary` over `path`, both in the checked `parent`. */
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

  /**
   * With no room for a name beside it, replace the link at `path` in two
   * steps: remove a stale one, then make it; false when another made one
   * between the two.
   */
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

  /** What is at `path` now: the link wanted, something not Marbles' to replace, nothing, or a stale link of ours. */
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

  /** A new link to `link.target` beside where `link` goes, with a name of its own; undefined when none fits. */
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

  /** Make each directory of `segments` under `artifacts`, one level at a time; the last one's path. */
  async #directories(segments: readonly string[]): Promise<string> {
    let path = this.#dir;
    await this.#checked(path);
    for (const segment of segments) {
      path = join(path, segment);
      await this.#directory(path);
    }
    return path;
  }

  /** Make the directory `path` if missing, in its checked parent, and check it. */
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

  /**
   * After making `path` in `parent`: if `parent` has left `.marbles`
   * meanwhile, remove what was made and refuse it.
   */
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

  /** Refuse `dir` unless it is a directory, not a link, and inside the real `.marbles`. */
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

/** The report in an order no machine's directory listing decides. */
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

/** Wait `ms`, or less once `signal` aborts. */
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

/** Make `path` alone, not its parents; whether this call made it. */
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

/** Keep the links out of the workspace's repository: `.marbles/.gitignore` ignores everything. */
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

/** The entries of `dir` by name, so every machine works through them alike. */
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

/** Remove the directory `dir` if nothing is in it; another process may fill or remove it meanwhile. */
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
