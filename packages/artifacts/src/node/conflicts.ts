import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { StorageNode, StorageTree } from "@foundry/core/storage";
import { validateStorageTree } from "@foundry/core/storage";
import { sha256Hex } from "@foundry/lib/digest";
import { readJsonFile, writeFileAtomic } from "@foundry/lib/node/atomic-file";
import type { ContentTree } from "../blob";
import type { ArtifactId } from "../ref";
import type { ArtifactOperations, ArtifactResolved } from "../substrate";
import { artifactIdFromDirectory, directoryName } from "./directory-name";
import { lstatOrNull } from "./fs";
import { diffDirectory } from "./scan";

const TIMESTAMP_SEPARATORS = /[:.]/g;
const STAMP_SUFFIX_LENGTH = 8;
const NOTE_SUFFIX = ".json";

export const ARTIFACT_CONFLICTS_DIRECTORY = ".conflicts";

const APPLIED_DIRECTORY = ".applied";

export interface ArtifactDiskConflict {
  readonly artifactId: ArtifactId;
  readonly directory: string;
  readonly paths: readonly string[];
}

export interface AppliedDirectory {
  readonly applied: StorageTree | undefined;
  readonly id: ArtifactId;
  readonly root: string;
}

export interface ConflictKeeperOptions {
  readonly conflicted?: ((conflict: ArtifactDiskConflict) => void) | undefined;
  readonly keptConflicts: number;
  readonly root: () => Promise<string>;
}

export interface ConflictKeeper {
  applied(id: ArtifactId, tree: StorageTree): Promise<void>;
  preserve(
    directory: AppliedDirectory,
    artifact: ArtifactResolved,
    transaction: ArtifactOperations
  ): Promise<void>;
  removed(id: ArtifactId): Promise<void>;
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
