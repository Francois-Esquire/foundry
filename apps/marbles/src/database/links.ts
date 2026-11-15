import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { hasErrorCode } from "@foundry/lib/atomic-file";
import type { ArtifactFile, ResourceView } from "~/database/resources";
import { artifactBlobs } from "~/database/stores";
import { resourceLinks, workspaceLinks } from "~/layout";
import type { ResourceRef } from "~/lib/resources";

/**
 * A workspace's links to the resources it shows, made from the Marbles
 * database alone. Only resources that are files are linked, and only
 * artifacts so far: each file of an artifact's active Content whose bytes
 * one blob file holds becomes a symbolic link to that file at
 * `<root>/.marbles/artifacts/<artifact id>/<path>`. A file whose bytes the
 * database holds inline, or several chunks do, has no file to point at and
 * is left out; no file is made for it.
 *
 * Nothing reads the links back: rebuilding removes every link under the
 * artifacts directory and makes them again, so a link left by an artifact
 * since removed or unshared, or by a file since rewritten (a rewrite puts
 * the bytes in a new blob file), goes. Anything there that is not a link is
 * left as it is and reported. Removing a link never touches what it points
 * at.
 */

export interface LinksReport {
  /** What was in the way and left as it was: not a link, so not Marbles'. */
  readonly kept: readonly string[];
  /** Links made. */
  readonly linked: number;
  /** Files left unlinked: no one blob file holds their bytes, or their path would leave the links directory. */
  readonly unlinkable: number;
}

/** A links directory, or a directory on the way to it, that is not a real directory. */
export class LinksPlacementError extends Error {
  override readonly name = "LinksPlacementError";
}

export interface RebuildLinksOptions {
  /** The shared artifact store, whose blob files the links point at. */
  readonly artifacts: string;
  /** The workspace's root. */
  readonly root: string;
  /** The workspace's own view of its resources. */
  readonly view: ResourceView;
}

/** Make the workspace's links again from what its view shows. */
export async function rebuildLinks(
  options: RebuildLinksOptions
): Promise<LinksReport> {
  const { artifacts, root, view } = options;
  const dir = await linksDirectory(root);
  const kept: string[] = [];
  await unlinkUnder(dir, root, kept);
  const made = { kept, linked: 0, unlinkable: 0 };
  for (const { ref } of await view.artifacts()) {
    await linkArtifact(
      dir,
      root,
      artifactBlobs(artifacts, ref.owner),
      ref.id,
      await view.artifactFiles(ref),
      made
    );
  }
  return made;
}

export interface RelinkArtifactOptions {
  /** The shared artifact store, whose blob files the links point at. */
  readonly artifacts: string;
  /** The artifact's files, as the database holds them now; none to only unlink it. */
  readonly files: readonly ArtifactFile[];
  readonly ref: ResourceRef;
  /** The workspace's root. */
  readonly root: string;
}

/**
 * Make the links of one artifact in the workspace at `root` again: remove
 * those it has, and link `files`. For a workspace whose links directory is
 * there: one that has none was never linked, and nothing makes it here.
 * Whether the workspace was linked.
 */
export async function relinkArtifact(
  options: RelinkArtifactOptions
): Promise<boolean> {
  const { artifacts, files, ref, root } = options;
  if ((await lstatOrUndefined(workspaceLinks(root))) === undefined) {
    return false;
  }
  const dir = await linksDirectory(root);
  const base = join(dir, encodeURIComponent(ref.id));
  const kept: string[] = [];
  if (dirname(base) === dir && (await lstatOrUndefined(base))?.isDirectory()) {
    await unlinkUnder(base, root, kept);
    if ((await readdir(base)).length === 0) {
      await rmdir(base);
    }
  }
  await linkArtifact(
    dir,
    root,
    artifactBlobs(artifacts, ref.owner),
    ref.id,
    files,
    { kept, linked: 0, unlinkable: 0 }
  );
  return true;
}

/** `<root>/.marbles/artifacts`, made if missing, refused if it or `.marbles` is not a real directory. */
async function linksDirectory(root: string): Promise<string> {
  const top = workspaceLinks(root);
  const dir = resourceLinks(root, "artifact");
  await realDirectory(top);
  await realDirectory(dir);
  await ignoredByGit(top);
  return dir;
}

/** Link each of an artifact's files held by one blob file, counting into `made`. */
async function linkArtifact(
  dir: string,
  root: string,
  blobs: string,
  id: string,
  files: readonly ArtifactFile[],
  made: { kept: string[]; linked: number; unlinkable: number }
): Promise<void> {
  const base = join(dir, encodeURIComponent(id));
  // An id of `.` or `..` would name no directory of its own.
  if (dirname(base) !== dir) {
    made.unlinkable += files.length;
    return;
  }
  for (const file of files) {
    const link = resolve(base, file.path);
    if (file.blob === null || !link.startsWith(`${base}${sep}`)) {
      made.unlinkable += 1;
      continue;
    }
    await mkdir(dirname(link), { recursive: true });
    try {
      await symlink(join(blobs, file.blob), link);
      made.linked += 1;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
      made.kept.push(relative(root, link));
    }
  }
}

/** Make `path` a directory, or refuse one that is anything else. */
async function realDirectory(path: string): Promise<void> {
  const found = await lstatOrUndefined(path);
  if (found === undefined) {
    await mkdir(path, { recursive: true });
    return;
  }
  if (!found.isDirectory()) {
    throw new LinksPlacementError(
      `${path} is not a directory Marbles made${found.isSymbolicLink() ? " (it is a link)" : ""}; move it away to rebuild the workspace's links`
    );
  }
}

/**
 * Remove every link under `dir`, and each directory left empty; keep
 * anything else, named relative to `root` in `kept`.
 */
async function unlinkUnder(
  dir: string,
  root: string,
  kept: string[]
): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      await unlink(path);
    } else if (entry.isDirectory()) {
      await unlinkUnder(path, root, kept);
      if ((await readdir(path)).length === 0) {
        await rmdir(path);
      }
    } else {
      kept.push(relative(root, path));
    }
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
