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
import type { ResourceView } from "~/database/resources";
import { artifactBlobs } from "~/database/stores";
import { resourceLinks, workspaceLinks } from "~/layout";

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
  /** Files with no one blob file to link to. */
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
  const top = workspaceLinks(root);
  const dir = resourceLinks(root, "artifact");
  await realDirectory(top);
  await realDirectory(dir);
  const kept: string[] = [];
  await unlinkUnder(dir, root, kept);
  await ignoredByGit(top);
  let linked = 0;
  let unlinkable = 0;
  for (const { ref } of await view.artifacts()) {
    const blobs = artifactBlobs(artifacts, ref.owner);
    const base = join(dir, encodeURIComponent(ref.id));
    for (const file of await view.artifactFiles(ref)) {
      if (file.blob === null) {
        unlinkable += 1;
        continue;
      }
      const link = resolve(base, file.path);
      if (!link.startsWith(`${base}${sep}`)) {
        unlinkable += 1;
        continue;
      }
      await mkdir(dirname(link), { recursive: true });
      try {
        await symlink(join(blobs, file.blob), link);
        linked += 1;
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) {
          throw error;
        }
        kept.push(relative(root, link));
      }
    }
  }
  return { kept, linked, unlinkable };
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
