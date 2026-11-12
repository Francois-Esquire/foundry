import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { StorageNode, StorageTree } from "@foundry/core/storage";
import { validateStorageTree } from "@foundry/core/storage";
import { readJsonFile, writeFileAtomic } from "@foundry/lib/atomic-file";
import { sha256Hex } from "@foundry/lib/digest";
import type { ContentTree } from "../blob";
import type { ArtifactId } from "../ref";
import type { ArtifactOperations, ArtifactResolved } from "../substrate";
import { artifactIdFromDirectory, directoryName } from "./directory-name";
import { lstatOrNull } from "./fs";
import { diffDirectory } from "./scan";

const TIMESTAMP_SEPARATORS = /[:.]/g;
/** Random hex characters that keep two same-millisecond stamps apart. */
const STAMP_SUFFIX_LENGTH = 8;
const NOTE_SUFFIX = ".json";

/** Where disk edits that lost to committed records are kept, under the root. */
export const ARTIFACT_CONFLICTS_DIRECTORY = ".conflicts";

/**
 * Where each directory's last applied tree is noted, under the root, so a
 * later process can tell what it last wrote from what a person edited.
 */
const APPLIED_DIRECTORY = ".applied";

/** Disk edits that conflicted with committed records, kept before replacing them. */
export interface ArtifactDiskConflict {
  readonly artifactId: ArtifactId;
  /** The directory holding the kept files, at their tree paths. */
  readonly directory: string;
  readonly paths: readonly string[];
}

/** An Artifact's directory, as the filesystem last applied it. */
export interface AppliedDirectory {
  /** The tree this process last applied there; unset when it applied none. */
  readonly applied: StorageTree | undefined;
  readonly id: ArtifactId;
  readonly root: string;
}

export interface ConflictKeeperOptions {
  /** Told when conflicting disk edits were kept aside. */
  readonly conflicted?: ((conflict: ArtifactDiskConflict) => void) | undefined;
  /** How many kept conflict sets each Artifact retains; at least one. */
  readonly keptConflicts: number;
  /** The filesystem's canonical root. */
  readonly root: () => Promise<string>;
}

/**
 * Keeps disk edits a commit is about to replace, under
 * `<root>/.conflicts/<artifact>/<stamp>/`, and notes each applied tree under
 * `<root>/.applied/`, so edits are never silently discarded and bytes an
 * earlier process applied are never mistaken for edits.
 */
export interface ConflictKeeper {
  /** Note the tree just written to `id`'s directory; it outlives the process. */
  applied(id: ArtifactId, tree: StorageTree): Promise<void>;
  /**
   * Keep what disk holds beyond the tree last applied, in this process or
   * (noted on disk) an earlier one, before `artifact` is materialized over
   * it. With no tree on record, disk is compared with the tree about to be
   * applied and every version committed before it.
   */
  preserve(
    directory: AppliedDirectory,
    artifact: ArtifactResolved,
    transaction: ArtifactOperations
  ): Promise<void>;
  /** `id`'s directory is gone with its Artifact: forget what was applied there. */
  removed(id: ArtifactId): Promise<void>;
  /** Forget the notes of Artifacts `exists` no longer knows, such as ones deleted while closed. */
  sweep(exists: (id: ArtifactId) => Promise<boolean>): Promise<void>;
}

export function conflictKeeper(options: ConflictKeeperOptions): ConflictKeeper {
  const keptConflicts = Math.max(1, options.keptConflicts);

  async function notes(): Promise<string> {
    return join(await options.root(), APPLIED_DIRECTORY);
  }

  async function noteOf(id: ArtifactId): Promise<string> {
    return join(await notes(), `${directoryName(id)}${NOTE_SUFFIX}`);
  }

  /**
   * The tree last applied to the directory: by this process, or as an
   * earlier one noted it. Null when neither is on record.
   */
  async function lastApplied(
    directory: AppliedDirectory
  ): Promise<StorageTree | null> {
    if (directory.applied) {
      return directory.applied;
    }
    const noted = await readJsonFile(await noteOf(directory.id)).catch(
      () => null
    );
    if (typeof noted !== "object" || noted === null) {
      return null;
    }
    try {
      validateStorageTree(noted as StorageTree);
      return noted as StorageTree;
    } catch {
      return null;
    }
  }

  /**
   * Write one conflict set to a new stamp directory, then prune the
   * Artifact's oldest sets beyond `keptConflicts`. Stamps sort by time.
   */
  async function keep(
    id: ArtifactId,
    files: readonly (readonly [string, Uint8Array])[]
  ): Promise<string> {
    const parent = join(
      await options.root(),
      ARTIFACT_CONFLICTS_DIRECTORY,
      directoryName(id)
    );
    const time = new Date().toISOString().replace(TIMESTAMP_SEPARATORS, "-");
    const stamp = `${time}-${randomUUID().slice(0, STAMP_SUFFIX_LENGTH)}`;
    const keptRoot = join(parent, stamp);
    for (const [path, bytes] of files) {
      const destination = join(keptRoot, ...path.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    const older = (await readdir(parent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== stamp)
      .map((entry) => entry.name)
      .sort();
    for (const name of older.slice(0, older.length - (keptConflicts - 1))) {
      await rm(join(parent, name), { force: true, recursive: true });
    }
    return keptRoot;
  }

  return {
    async applied(id, tree) {
      await writeFileAtomic(await noteOf(id), JSON.stringify(tree), {
        createDirectory: true,
      });
    },
    async preserve(directory, artifact, transaction) {
      if (!(await lstatOrNull(directory.root))) {
        return;
      }
      const applied = await lastApplied(directory);
      const baseline = applied ?? artifact.content?.tree ?? {};
      const changes = await diffDirectory(directory.root, baseline);
      const target = artifact.content?.tree ?? {};
      const changed: [string, Uint8Array][] = [];
      for (const [path, entry] of Object.entries(changes?.put ?? {})) {
        const bytes = "bytes" in entry ? entry.bytes : undefined;
        if (
          bytes instanceof Uint8Array &&
          !(await holds(target[path], bytes))
        ) {
          changed.push([path, bytes]);
        }
      }
      // Without an applied tree, disk may still hold a version committed
      // while nothing applied it (a crash, or a closed filesystem): stale,
      // not edited.
      const kept = applied
        ? changed
        : await uncommitted(transaction, artifact, changed);
      if (kept.length === 0) {
        return;
      }
      const keptRoot = await keep(directory.id, kept);
      options.conflicted?.({
        artifactId: directory.id,
        directory: keptRoot,
        paths: kept.map(([path]) => path),
      });
    },
    async removed(id) {
      await rm(await noteOf(id), { force: true });
    },
    async sweep(exists) {
      const directory = await notes();
      const names = await readdir(directory).catch(() => []);
      for (const name of names) {
        const id = name.endsWith(NOTE_SUFFIX)
          ? artifactIdFromDirectory(name.slice(0, -NOTE_SUFFIX.length))
          : null;
        if (id === null || !(await exists(id))) {
          await rm(join(directory, name), { force: true });
        }
      }
    },
  };
}

/**
 * The files whose bytes no other committed version of the Artifact holds at
 * the same path; the target version was already compared.
 */
async function uncommitted(
  transaction: ArtifactOperations,
  artifact: ArtifactResolved,
  files: readonly [string, Uint8Array][]
): Promise<[string, Uint8Array][]> {
  if (files.length === 0) {
    return [];
  }
  const trees: ContentTree[] = [];
  for (const summary of await transaction.listContents(artifact.id)) {
    if (summary.id === artifact.contentId) {
      continue;
    }
    const content = await transaction.getContent(summary.id);
    if (content) {
      trees.push(content.tree);
    }
  }
  const kept: [string, Uint8Array][] = [];
  for (const [path, bytes] of files) {
    const digest = await sha256Hex(bytes);
    const recorded = trees.some((tree) => {
      const node = Object.hasOwn(tree, path) ? tree[path] : undefined;
      return (
        node?.type === "file" &&
        node.bytes === bytes.byteLength &&
        node.digest === digest
      );
    });
    if (!recorded) {
      kept.push([path, bytes]);
    }
  }
  return kept;
}

/** Whether a tree entry already holds exactly these bytes. */
async function holds(
  node: StorageNode | undefined,
  bytes: Uint8Array
): Promise<boolean> {
  return (
    node?.type === "file" &&
    node.bytes === bytes.byteLength &&
    node.digest === (await sha256Hex(bytes))
  );
}
