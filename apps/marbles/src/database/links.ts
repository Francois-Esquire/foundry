import type { Stats } from "node:fs";
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
import { join, resolve, sep } from "node:path";
import { hasErrorCode } from "@foundry/lib/atomic-file";
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
 * is left out; no file is made for it.
 *
 * Nothing reads the links back. Rebuilding a workspace and updating one
 * artifact both reconcile what is on disk with what the database says
 * should be there (`reconcile`): a link Marbles made (one pointing into
 * the artifact store's `workspaces/` directory) that should not be there,
 * or points elsewhere, is removed; one that should be there is made.
 * Anything else, a file or another link, is left as it is and reported.
 *
 * Nothing is followed. From `.marbles` down, every directory on the way to
 * a link, existing or made here, is checked with `lstat` to be a real
 * directory, and made one level at a time; a component that is a link or
 * not a directory refuses that link, or the whole update when it is
 * `.marbles` or `.marbles/artifacts`, and nothing is made or removed
 * beneath it. Every step tolerates another process doing the same at once
 * (a link already made, a directory already removed), so concurrent
 * updates converge.
 */

export interface LinksReport {
  /** What was in the way and left as it was: not a link Marbles made. */
  readonly kept: readonly string[];
  /** Links in place, made now or already right. */
  readonly linked: number;
  /** Paths refused because a directory on the way is a link or not a directory. */
  readonly refused: readonly string[];
  /** Files left unlinked: no one blob file holds their bytes, or their path cannot be a link name. */
  readonly unlinkable: number;
}

/** `.marbles` or `.marbles/artifacts` is not a real directory; nothing was touched. */
export class LinksPlacementError extends Error {
  override readonly name = "LinksPlacementError";
}

const ARTIFACTS_DIR = "artifacts";
const SHARED_PREFIX = "@";
/** How many times a link is tried again when a concurrent cleanup removed its directory. */
const ATTEMPTS = 3;

/**
 * `name` as one path segment that no other name shares, on a
 * case-sensitive or case-insensitive file system: percent-encoded, every
 * uppercase letter as well, and `.` or `..` escaped. It never starts with
 * `@`, which marks another workspace's artifacts.
 */
export function linkName(name: string): string {
  const encoded = encodeURIComponent(name).replace(
    /[A-Z]/g,
    (letter) => `%${letter.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return encoded === "." || encoded === ".."
    ? encoded.replaceAll(".", "%2E")
    : encoded;
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
 * Make the workspace's links match what its view shows. It reads the view
 * again after reconciling, and reconciles once more if a write changed it
 * meanwhile, so a rebuild never leaves a link a commit made during it
 * undone.
 */
export async function rebuildLinks(
  options: RebuildLinksOptions
): Promise<LinksReport> {
  const { artifacts, root, view, workspace } = options;
  const tree = new LinkTree(root, artifacts);
  await tree.open(true);
  let wanted = await wantedLinks(view, workspace, artifacts);
  let report = emptyReport();
  for (let round = 0; round < REBUILD_ROUNDS; round += 1) {
    report = await tree.reconcile([], wanted.links, wanted.unlinkable);
    const again = await wantedLinks(view, workspace, artifacts);
    if (sameLinks(again.links, wanted.links)) {
      break;
    }
    wanted = again;
  }
  return report;
}

export interface RelinkArtifactOptions {
  /** The shared artifact store, whose blob files the links point at. */
  readonly artifacts: string;
  /** The artifact's files as this workspace should show them; none to unlink it. */
  readonly files: readonly ArtifactFile[];
  readonly ref: ResourceRef;
  /** The workspace's root. */
  readonly root: string;
  /** The workspace's id. */
  readonly workspace: string;
}

/**
 * Make one artifact's links in the workspace at `root` match `files`. For
 * a workspace whose `.marbles` is there: one that has none was never
 * linked, and nothing makes it here (undefined).
 */
export async function relinkArtifact(
  options: RelinkArtifactOptions
): Promise<LinksReport | undefined> {
  const { artifacts, files, ref, root, workspace } = options;
  const tree = new LinkTree(root, artifacts);
  if (!(await tree.open(false))) {
    return;
  }
  const place = artifactPlace(ref, workspace);
  const wanted = linksOf(place, artifacts, ref, files);
  return tree.reconcile(place, wanted.links, wanted.unlinkable);
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
    if (file.blob === null || !isSegment(file.blob) || !path.every(isSegment)) {
      unlinkable += 1;
      continue;
    }
    const segments = [...place, ...path];
    links.set(segments.join("/"), {
      segments,
      target: join(blobs, file.blob),
    });
  }
  return { links, unlinkable };
}

/** A name that is one path segment of its own. */
function isSegment(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0")
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

/** A component on the way to a link that is a link, or not a directory. */
class Refused extends Error {}

/** What a reconcile counts as it goes. */
interface Tally {
  kept: string[];
  linked: number;
  refused: string[];
  unlinkable: number;
}

/**
 * The links under one workspace's `.marbles/artifacts`, walked and changed
 * without following anything.
 */
class LinkTree {
  readonly #root: string;
  readonly #top: string;
  readonly #dir: string;
  /** Targets of links Marbles made start here. */
  readonly #ours: string;

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
      await realDirectory(this.#top);
      await realDirectory(this.#dir);
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
   * Make what is under `scope` (segments under `.marbles/artifacts`, none
   * for all of it) match `wanted`, which holds only paths under `scope`.
   */
  async reconcile(
    scope: readonly string[],
    wanted: ReadonlyMap<string, WantedLink>,
    unlinkable: number
  ): Promise<LinksReport> {
    const report: Tally = { kept: [], linked: 0, refused: [], unlinkable };
    const scoped = await this.#existing(scope);
    if (scoped === "refused") {
      report.refused.push(this.#shown(scope));
      return report;
    }
    if (scoped !== undefined) {
      await this.#prune(scoped, [...scope], wanted, report);
    }
    for (const link of wanted.values()) {
      await this.#link(link, report);
    }
    return report;
  }

  /**
   * The directory at `segments`, when every component down to it is a
   * real directory; undefined when one is missing, `refused` when one is
   * a link or anything else.
   */
  async #existing(
    segments: readonly string[]
  ): Promise<string | "refused" | undefined> {
    let path = this.#dir;
    for (const segment of segments) {
      path = join(path, segment);
      const found = await lstatOrUndefined(path);
      if (found === undefined) {
        return;
      }
      if (!isRealDirectory(found)) {
        return "refused";
      }
    }
    return path;
  }

  /** Remove the links Marbles made under `dir` that `wanted` does not hold as they are. */
  async #prune(
    dir: string,
    segments: string[],
    wanted: ReadonlyMap<string, WantedLink>,
    report: Tally
  ): Promise<void> {
    for (const entry of await entriesOf(dir)) {
      const path = join(dir, entry.name);
      const at = [...segments, entry.name];
      if (entry.isSymbolicLink()) {
        const target = await readlinkOrUndefined(path);
        if (target === undefined) {
          continue;
        }
        if (!target.startsWith(this.#ours)) {
          report.kept.push(this.#shown(at));
        } else if (wanted.get(at.join("/"))?.target !== target) {
          await removeLink(path);
        }
      } else if (entry.isDirectory()) {
        await this.#prune(path, at, wanted, report);
        await removeEmpty(path);
      } else {
        report.kept.push(this.#shown(at));
      }
    }
  }

  async #link(link: WantedLink, report: Tally): Promise<void> {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      const outcome = await this.#attempt(link, report);
      if (outcome === "done") {
        return;
      }
      // A concurrent cleanup removed a directory on the way, or a stale
      // link of ours was replaced: make it again.
      if (outcome === "gone" && attempt === ATTEMPTS) {
        throw new Error(
          `${this.#shown(link.segments)} kept going away while it was linked`
        );
      }
    }
  }

  /** One try at `link`: done (counted in `report`), or to be made again. */
  async #attempt(
    link: WantedLink,
    report: Tally
  ): Promise<"done" | "again" | "gone"> {
    const path = join(this.#dir, ...link.segments);
    try {
      await this.#directories(link.segments.slice(0, -1));
      await symlink(link.target, path);
      report.linked += 1;
      return "done";
    } catch (error) {
      if (error instanceof Refused) {
        report.refused.push(this.#shown(link.segments));
        return "done";
      }
      if (hasErrorCode(error, "ENAMETOOLONG")) {
        report.unlinkable += 1;
        return "done";
      }
      if (hasErrorCode(error, "ENOENT")) {
        return "gone";
      }
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
    }
    const settled = await this.#existingLink(path, link.target);
    if (settled === "ours") {
      report.linked += 1;
      return "done";
    }
    if (settled === "kept") {
      report.kept.push(this.#shown(link.segments));
      return "done";
    }
    return "again";
  }

  /** What is at `path` already: the link wanted, something not Marbles', or a stale link of ours, removed. */
  async #existingLink(
    path: string,
    target: string
  ): Promise<"ours" | "kept" | "replaced"> {
    const found = await lstatOrUndefined(path);
    if (found === undefined) {
      return "replaced";
    }
    if (!found.isSymbolicLink()) {
      return "kept";
    }
    const current = await readlinkOrUndefined(path);
    if (current === target) {
      return "ours";
    }
    if (current === undefined || !current.startsWith(this.#ours)) {
      return current === undefined ? "replaced" : "kept";
    }
    await removeLink(path);
    return "replaced";
  }

  /** Make each directory of `segments` under `artifacts`, one level at a time, refusing any that is not a real one. */
  async #directories(segments: readonly string[]): Promise<void> {
    let path = this.#dir;
    for (const segment of segments) {
      path = join(path, segment);
      await realDirectory(path);
    }
  }

  #shown(segments: readonly string[]): string {
    return join(".marbles", ARTIFACTS_DIR, ...segments);
  }
}

/** Make `path`, its parent already checked, or refuse what is there that is not a real directory. */
async function realDirectory(path: string): Promise<void> {
  let found = await lstatOrUndefined(path);
  if (found === undefined) {
    try {
      await mkdir(path);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
    }
    found = await lstatOrUndefined(path);
  }
  if (found === undefined || !isRealDirectory(found)) {
    throw new Refused(path);
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

async function entriesOf(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
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

/** Remove `dir` if nothing is in it; another process may fill or remove it meanwhile. */
async function removeEmpty(dir: string): Promise<void> {
  try {
    await rmdir(dir);
  } catch (error) {
    if (
      !(
        hasErrorCode(error, "ENOENT") ||
        hasErrorCode(error, "ENOTEMPTY") ||
        hasErrorCode(error, "EEXIST")
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
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
}
