import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import type {
  StorageNode,
  StorageTree,
  StorageWriter,
} from "@foundry/core/storage";
import { isStoragePath, StorageConflictError } from "@foundry/core/storage";
import { isFilesystemPathWithin } from "@foundry/lib/paths";
import type { WorkspaceFileSystem } from "@foundry/workspaces";
import { WorkspaceSourceUnavailableError } from "@foundry/workspaces";
import { isUsableContent } from "../content";
import {
  ArtifactNotFoundError,
  ContentStateError,
  StaleContentError,
} from "../errors";
import type { ArtifactId } from "../ref";
import { artifactIdSchema } from "../ref";
import type {
  ArtifactOperations,
  ArtifactResolved,
  Artifacts,
  EntryInput,
  WriteFence,
} from "../substrate";
import { lstatOrNull } from "./fs";
import { materialize } from "./materialize";
import { descriptor, diffDirectory } from "./scan";

const POLL_INTERVAL_MS = 1000;
const DOTS = /\./g;

export interface ArtifactFileSystem
  extends WorkspaceFileSystem<ArtifactRef>,
    StorageWriter {
  close(): Promise<void>;
  mkdir(path: string): Promise<void>;
  recover(): Promise<void>;
  remove(path: string): Promise<void>;
  resolve(ref: ArtifactRef): Promise<{
    readonly path: string;
    readonly name: string;
    readonly sourceId: ArtifactId;
  }>;
  symlink(path: string, target: string): Promise<void>;
  tree(root: string): Promise<StorageTree>;
}

export interface ArtifactRef {
  readonly artifactId: string;
}

interface DirectoryState {
  /** The Artifact last written to disk; polled while set. */
  applied: ArtifactResolved | undefined;
  readonly failures: Set<(error: unknown) => void>;
  readonly id: ArtifactId;
  readonly listeners: Set<() => void>;
  observing?: Promise<void>;
  pending: Promise<void>;
  readonly root: string;
  timer?: ReturnType<typeof setInterval>;
}

interface MutateOptions {
  /** Refuse a path that already has an entry. */
  readonly exclusive?: boolean;
  /** Replace only a file whose digest still matches. */
  readonly expectedDigest?: string;
}

/**
 * One directory per Artifact, mirroring its active Content. Artifact commits
 * apply to disk before returning; disk edits are polled and written back
 * through Artifact operations, fenced against the Content last applied.
 */
export function artifactFileSystem(options: {
  readonly artifacts: Artifacts;
  readonly root: string;
}): ArtifactFileSystem {
  const { artifacts } = options;
  const directories = new Map<ArtifactId, DirectoryState>();
  const root = resolve(options.root);
  let canonical: Promise<string> | undefined;
  let closed = false;

  function ready(): Promise<string> {
    if (closed) {
      throw new Error("Artifact filesystem is closed");
    }
    canonical ??= mkdir(root, { recursive: true }).then(() => realpath(root));
    return canonical;
  }

  async function directory(id: ArtifactId): Promise<DirectoryState> {
    const known = directories.get(id);
    if (known) {
      return known;
    }
    const base = await ready();
    const concurrent = directories.get(id);
    if (concurrent) {
      return concurrent;
    }
    const state: DirectoryState = {
      applied: undefined,
      failures: new Set(),
      id,
      listeners: new Set(),
      pending: Promise.resolve(),
      root: join(base, directoryName(id)),
    };
    directories.set(id, state);
    return state;
  }

  function startPolling(state: DirectoryState): void {
    state.timer ??= setInterval(() => {
      state.observing ??= observe(state)
        .catch((error: unknown) => {
          if (!state.failures.size) {
            console.error("Artifact directory observation failed", error);
          }
          for (const failed of state.failures) {
            failed(error);
          }
        })
        .finally(() => {
          state.observing = undefined;
        });
    }, POLL_INTERVAL_MS);
    state.timer.unref();
  }

  function stopPolling(state: DirectoryState): void {
    clearInterval(state.timer);
    state.timer = undefined;
  }

  async function locate(
    path: string
  ): Promise<{ state: DirectoryState; path: string }> {
    const base = await ready();
    const absolute = resolve(path);
    if (!isFilesystemPathWithin(base, absolute, sep) || absolute === base) {
      throw new Error("Path outside Artifact filesystem");
    }
    const parts = relative(base, absolute).split(sep);
    const id = artifactIdSchema.parse(decodeURIComponent(parts.shift() ?? ""));
    const state = await directory(id);
    if (!isFilesystemPathWithin(state.root, absolute, sep)) {
      throw new Error("Noncanonical Artifact directory");
    }
    const stored = parts.join("/");
    if (stored && !isStoragePath(stored)) {
      throw new Error("Invalid Artifact storage path");
    }
    return { path: stored, state };
  }

  function serialize<T>(
    state: DirectoryState,
    operation: () => Promise<T>
  ): Promise<T> {
    const pending = state.pending.then(operation, operation);
    state.pending = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  }

  async function current(id: ArtifactId): Promise<ArtifactResolved> {
    const artifact = await artifacts.get(id);
    if (!artifact || unavailable(artifact)) {
      throw sourceUnavailable();
    }
    return artifact;
  }

  async function apply(id: ArtifactId): Promise<void> {
    const state = await directory(id);
    await serialize(state, () =>
      artifacts.transaction(async (transaction) => {
        const artifact = await transaction.get(id);
        if (artifact) {
          const { content } = artifact;
          await materialize(state.root, content?.tree ?? {}, async (path) => {
            const file =
              content &&
              (await transaction.readFileRange(content.id, path, { start: 0 }));
            if (!file) {
              throw new Error(`Missing Artifact file: ${path}`);
            }
            return file.body;
          });
          state.applied = artifact;
          startPolling(state);
        } else {
          await rm(state.root, { force: true, recursive: true });
          state.applied = undefined;
          stopPolling(state);
        }
        for (const changed of state.listeners) {
          changed();
        }
      })
    );
  }

  const unbind = artifacts.bind(apply);

  async function mutate(
    path: string,
    entry: EntryInput | null,
    preconditions: MutateOptions = {}
  ): Promise<void> {
    const located = await locate(path);
    if (!located.path) {
      if (entry !== null) {
        throw new Error("Cannot replace an Artifact root");
      }
      await artifacts.delete(located.state.id);
      return;
    }
    await artifacts.transaction(async (transaction) => {
      const artifact = await transaction.get(located.state.id);
      if (!artifact) {
        throw new ArtifactNotFoundError(located.state.id);
      }
      const existing = await checkMutation(
        transaction,
        artifact,
        located.path,
        preconditions
      );
      await transaction.write({
        artifactId: artifact.id,
        ...fenceOf(artifact),
        changes:
          entry === null
            ? { remove: [located.path] }
            : { put: { [located.path]: inheritMime(entry, existing) } },
      });
    });
  }

  async function observe(state: DirectoryState): Promise<void> {
    if (!state.applied) {
      return;
    }
    const latest = await artifacts.get(state.id);
    const changedElsewhere =
      latest?.contentId !== state.applied.contentId ||
      latest.content?.updatedAt.getTime() !==
        state.applied.content?.updatedAt.getTime();
    // Records are authoritative: a removed directory is restored, never a deletion.
    if (changedElsewhere || !(await lstatOrNull(state.root))) {
      await apply(state.id);
      return;
    }
    const observed = await serialize(state, async () => {
      const baseline = state.applied;
      if (!baseline) {
        return null;
      }
      const changes = await diffDirectory(
        state.root,
        baseline.content?.tree ?? {}
      );
      return changes && { baseline, changes };
    });
    if (!observed) {
      return;
    }
    try {
      await artifacts.write({
        artifactId: state.id,
        ...fenceOf(observed.baseline),
        changes: observed.changes,
      });
    } catch (error) {
      if (
        error instanceof StaleContentError ||
        error instanceof ContentStateError
      ) {
        await apply(state.id);
        return;
      }
      throw error;
    }
  }

  return {
    async close() {
      if (closed) {
        return;
      }
      unbind();
      for (const state of directories.values()) {
        stopPolling(state);
      }
      await Promise.all(
        [...directories.values()].flatMap((state) =>
          state.observing ? [state.pending, state.observing] : [state.pending]
        )
      );
      directories.clear();
      closed = true;
    },
    createFile: (path, bytes) => mutate(path, { bytes }, { exclusive: true }),
    async lstat(path) {
      const located = await locate(path);
      const artifact = await current(located.state.id);
      if (!located.path) {
        return { type: "directory" };
      }
      const node = entryAt(artifact, located.path);
      if (!node) {
        throw new Error("Artifact entry does not exist");
      }
      return { type: node.type };
    },
    mkdir: (path) => mutate(path, { type: "directory" }),
    async readDirectory(path) {
      const located = await locate(path);
      const artifact = await current(located.state.id);
      if (
        located.path &&
        entryAt(artifact, located.path)?.type !== "directory"
      ) {
        throw new Error("Artifact entry is not a directory");
      }
      const prefix = located.path ? `${located.path}/` : "";
      return Object.entries(artifact.content?.tree ?? {}).flatMap(
        ([entryPath, node]) => {
          const name = entryPath.slice(prefix.length);
          return entryPath.startsWith(prefix) && name && !name.includes("/")
            ? [{ name, type: node.type }]
            : [];
        }
      );
    },
    async readFile(path) {
      const located = await locate(path);
      const artifact = await current(located.state.id);
      const file =
        artifact.content &&
        (await artifacts.readFile(artifact.content.id, located.path));
      if (!file) {
        throw new Error(`Artifact file does not exist: ${located.path}`);
      }
      return file.blob;
    },
    async readLink(path) {
      const located = await locate(path);
      const node = entryAt(await current(located.state.id), located.path);
      if (node?.type !== "symlink") {
        throw new Error("Artifact entry is not a symlink");
      }
      return node.target;
    },
    async realpath(path) {
      const located = await locate(path);
      const artifact = await current(located.state.id);
      const node: StorageNode | undefined = located.path
        ? entryAt(artifact, located.path)
        : { type: "directory" };
      if (!node) {
        throw new Error("Artifact entry does not exist");
      }
      if (node.type === "symlink") {
        const actual = await realpath(path);
        if (!isFilesystemPathWithin(located.state.root, actual, sep)) {
          throw new Error("Link escapes Artifact root");
        }
        return actual;
      }
      return resolve(path);
    },
    async recover() {
      await artifacts.recover();
      for (const entry of await readdir(await ready(), {
        withFileTypes: true,
      })) {
        const id = artifactIdFromDirectory(entry.name);
        if (id !== null && !(await artifacts.get(id))) {
          await apply(id);
        }
      }
    },
    reference: "artifactId",
    remove: (path) => mutate(path, null),
    replaceFile: (path, bytes, expectedDigest) =>
      mutate(path, { bytes }, { expectedDigest }),
    async resolve({ artifactId }) {
      const id = artifactIdSchema.parse(artifactId);
      const artifact = await artifacts.get(id);
      if (!artifact) {
        throw new ArtifactNotFoundError(id);
      }
      const state = await directory(id);
      await apply(id);
      return { name: artifact.name, path: state.root, sourceId: id };
    },
    separator: sep,
    symlink: (path, target) => mutate(path, { target, type: "symlink" }),
    async tree(requestedRoot) {
      const { state, path } = await locate(requestedRoot);
      if (path) {
        throw new Error("Inventory requires an Artifact root");
      }
      const artifact = await current(state.id);
      return Object.fromEntries(
        Object.entries(artifact.content?.tree ?? {}).map(
          ([entryPath, node]) => [entryPath, descriptor(node)]
        )
      );
    },
    async watch(requestedRoot, changed, failed) {
      const { state } = await locate(requestedRoot);
      state.listeners.add(changed);
      state.failures.add(failed);
      return {
        close() {
          state.listeners.delete(changed);
          state.failures.delete(failed);
          return Promise.resolve();
        },
      };
    },
    writeFile: (path, bytes) => mutate(path, { bytes }),
  };
}

/** Dots are encoded so no directory is named `.` or `..`. */
function directoryName(id: ArtifactId): string {
  return encodeURIComponent(id).replace(DOTS, "%2E");
}

/** The Artifact a directory names, or null for anything else in the root. */
function artifactIdFromDirectory(name: string): ArtifactId | null {
  if (name.startsWith(".")) {
    return null;
  }
  const parsed = artifactIdSchema.safeParse(safeDecode(name));
  return parsed.success && directoryName(parsed.data) === name
    ? parsed.data
    : null;
}

function safeDecode(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return "";
  }
}

/** Archived Artifacts and unusable Content cannot back a directory. */
function unavailable(artifact: ArtifactResolved): boolean {
  return (
    artifact.status === "archived" ||
    (artifact.content !== null && !isUsableContent(artifact.content))
  );
}

function sourceUnavailable(): WorkspaceSourceUnavailableError {
  return new WorkspaceSourceUnavailableError("Artifact source is unavailable", {
    issue: "unavailable",
  });
}

function entryAt(
  artifact: ArtifactResolved,
  path: string
): StorageNode | undefined {
  const tree = artifact.content?.tree;
  return tree && Object.hasOwn(tree, path) ? tree[path] : undefined;
}

/** The entry at `path` once the mutation's preconditions hold. */
async function checkMutation(
  transaction: ArtifactOperations,
  artifact: ArtifactResolved,
  path: string,
  { expectedDigest, exclusive = false }: MutateOptions
): Promise<StorageNode | undefined> {
  if (unavailable(artifact)) {
    throw sourceUnavailable();
  }
  const existing = entryAt(artifact, path);
  if (exclusive && existing) {
    throw new Error("Artifact entry already exists");
  }
  if (expectedDigest === undefined) {
    return existing;
  }
  if (existing?.type !== "file") {
    throw new Error("Cannot replace a non-file entry");
  }
  if (existing.digest !== expectedDigest && artifact.content) {
    const file = await transaction.readFile(artifact.content.id, path);
    throw new StorageConflictError(file?.blob ?? new Uint8Array());
  }
  return existing;
}

/** Fence a write against the Content that `artifact` last showed. */
function fenceOf(artifact: ArtifactResolved): WriteFence {
  return {
    expectedContentId: artifact.contentId,
    ...(artifact.content
      ? { expectedUpdatedAt: artifact.content.updatedAt }
      : {}),
  };
}

/** A replacement file keeps the MIME type of the file it replaces. */
function inheritMime(
  entry: EntryInput,
  existing: StorageNode | undefined
): EntryInput {
  return (entry.type === undefined || entry.type === "file") &&
    entry.mime === undefined &&
    existing?.type === "file"
    ? { ...entry, mime: existing.mime }
    : entry;
}
