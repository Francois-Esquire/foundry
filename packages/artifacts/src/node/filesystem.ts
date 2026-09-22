import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import type {
  StorageNode,
  StorageTree,
  StorageWriter,
} from "@foundry/core/storage";
import {
  isStoragePath,
  StorageConflictError,
  validateStorageTree,
} from "@foundry/core/storage";
import { sha256Hex } from "@foundry/lib/digest";
import { isFilesystemPathWithin } from "@foundry/lib/paths";
import type { WorkspaceFileSystem } from "@foundry/workspaces";
import { WorkspaceSourceUnavailableError } from "@foundry/workspaces";
import {
  ArtifactNotFoundError,
  ContentStateError,
  StaleContentError,
} from "../errors";
import type { ArtifactId } from "../ref";
import { artifactIdSchema } from "../ref";
import type { ArtifactResolved, Artifacts, EntryInputs } from "../substrate";
import { isGoodContent } from "../tree";

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
  applied: ArtifactResolved | undefined;
  readonly failures: Set<(error: unknown) => void>;
  readonly id: ArtifactId;
  readonly listeners: Set<() => void>;
  observing?: Promise<void>;
  pending: Promise<void>;
  readonly root: string;
  timer?: ReturnType<typeof setInterval>;
}

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
      root: join(base, encodeURIComponent(id).replace(/\./g, "%2E")),
    };
    directories.set(id, state);
    state.timer = setInterval(() => {
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
    }, 1000);
    state.timer.unref();
    return state;
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
    if (
      !artifact ||
      artifact.status === "archived" ||
      (artifact.content && !isGoodContent(artifact.content))
    ) {
      throw new WorkspaceSourceUnavailableError(
        "Artifact source is unavailable",
        { issue: "unavailable" }
      );
    }
    return artifact;
  }

  async function apply(id: ArtifactId): Promise<void> {
    const state = await directory(id);
    await serialize(state, () =>
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep filesystem confinement and type replacement inside the serialized transaction.
      artifacts.transaction(async (transaction) => {
        const artifact = await transaction.get(id);
        if (artifact) {
          const tree = artifact.content?.tree ?? {};
          validateStorageTree(tree);
          await ensureDirectory(state.root);
          await prune(state.root, "", tree);
          for (const [path, node] of Object.entries(tree).sort(
            ([a], [b]) => a.split("/").length - b.split("/").length
          )) {
            const target = join(state.root, ...path.split("/"));
            await confinedParents(state.root, target);
            if (node.type === "directory") {
              await ensureDirectory(target);
            } else if (node.type === "symlink") {
              const existing = await stat(target);
              if (
                !existing?.isSymbolicLink() ||
                (await readlink(target)) !== node.target
              ) {
                await rm(target, { force: true, recursive: true });
                await symlink(node.target, target);
              }
            } else if (node.type === "file" && artifact.content) {
              const existing = await stat(target);
              if (
                existing?.isFile() &&
                (await sha256Hex(await readFile(target))) === node.digest
              ) {
                continue;
              }
              if (existing && !existing.isFile()) {
                await rm(target, { force: true, recursive: true });
              }
              const file = await transaction.readFileRange(
                artifact.content.id,
                path,
                { start: 0 }
              );
              if (!file) {
                throw new Error(`Missing Artifact file: ${path}`);
              }
              await replace(target, file.body);
            } else {
              const existing = await stat(target);
              if (
                existing &&
                !(
                  (node.type === "socket" && existing.isSocket()) ||
                  (node.type === "pipe" && existing.isFIFO()) ||
                  (node.type === "device" &&
                    (existing.isBlockDevice() || existing.isCharacterDevice()))
                )
              ) {
                await rm(target, { force: true, recursive: true });
              }
            }
          }
          state.applied = artifact;
        } else {
          await rm(state.root, { force: true, recursive: true });
          state.applied = undefined;
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
    entry: EntryInputs[string] | null,
    expectedDigest?: string,
    exclusive = false
  ): Promise<void> {
    const located = await locate(path);
    if (!located.path) {
      if (entry !== null) {
        throw new Error("Cannot replace an Artifact root");
      }
      await artifacts.delete(located.state.id);
      return;
    }
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep optimistic conflict checks and mutation inside one transaction.
    await artifacts.transaction(async (transaction) => {
      const artifact = await transaction.get(located.state.id);
      if (!artifact) {
        throw new ArtifactNotFoundError(located.state.id);
      }
      if (artifact.status === "archived") {
        throw new WorkspaceSourceUnavailableError(
          "Artifact source is unavailable",
          { issue: "unavailable" }
        );
      }
      const currentEntry = artifact.content?.tree[located.path];
      if (exclusive && currentEntry) {
        throw new Error("Artifact entry already exists");
      }
      if (expectedDigest !== undefined && currentEntry?.type !== "file") {
        throw new Error("Cannot replace a non-file entry");
      }
      if (
        expectedDigest !== undefined &&
        currentEntry?.type === "file" &&
        currentEntry.digest !== expectedDigest &&
        artifact.content
      ) {
        const file = await transaction.readFile(
          artifact.content.id,
          located.path
        );
        throw new StorageConflictError(file?.blob ?? new Uint8Array());
      }
      const replacement =
        entry !== null &&
        (entry.type === undefined || entry.type === "file") &&
        entry.mime === undefined &&
        currentEntry?.type === "file"
          ? { ...entry, mime: currentEntry.mime }
          : entry;
      await transaction.write({
        artifactId: artifact.id,
        expectedContentId: artifact.contentId,
        ...(artifact.content
          ? { expectedUpdatedAt: artifact.content.updatedAt }
          : {}),
        changes:
          replacement === null
            ? { remove: [located.path] }
            : { put: { [located.path]: replacement } },
      });
    });
  }

  async function observe(state: DirectoryState): Promise<void> {
    if (!state.applied) {
      return;
    }
    const latest = await artifacts.get(state.id);
    if (
      latest?.contentId !== state.applied.contentId ||
      latest.content?.updatedAt.getTime() !==
        state.applied.content?.updatedAt.getTime()
    ) {
      await apply(state.id);
      return;
    }
    if (!(await stat(state.root))) {
      try {
        await artifacts.delete(state.id);
      } catch (error) {
        await apply(state.id);
        throw error;
      }
      return;
    }
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep disk comparison against one serialized baseline.
    const observed = await serialize(state, async () => {
      const baseline = state.applied;
      if (!baseline) {
        return null;
      }
      const tree = baseline.content?.tree ?? {};
      const disk = await scan(state.root);
      const put = Object.create(null) as Record<string, EntryInputs[string]>;
      const remove: string[] = [];
      for (const [path, node] of Object.entries(disk)) {
        const previous = tree[path];
        if (
          node.type === "file" &&
          previous?.type === "file" &&
          node.digest === previous.digest &&
          node.bytes === previous.bytes
        ) {
          continue;
        }
        if (
          node.type !== "file" &&
          JSON.stringify(node) === JSON.stringify(descriptor(previous))
        ) {
          continue;
        }
        put[path] =
          node.type === "file"
            ? {
                bytes: await readFile(join(state.root, ...path.split("/"))),
                mime: previous?.type === "file" ? previous.mime : null,
              }
            : node;
      }
      for (const [path, node] of Object.entries(tree)) {
        if (
          !(path in disk) &&
          ["file", "directory", "symlink"].includes(node.type)
        ) {
          remove.push(path);
        }
      }
      return Object.keys(put).length || remove.length
        ? { baseline, put, remove }
        : null;
    });
    if (!observed) {
      return;
    }
    try {
      await artifacts.write({
        artifactId: state.id,
        expectedContentId: observed.baseline.contentId,
        ...(observed.baseline.content
          ? { expectedUpdatedAt: observed.baseline.content.updatedAt }
          : {}),
        changes: { put: observed.put, remove: observed.remove },
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
        clearInterval(state.timer);
      }
      await Promise.all(
        [...directories.values()].flatMap((state) =>
          state.observing ? [state.pending, state.observing] : [state.pending]
        )
      );
      directories.clear();
      closed = true;
    },
    createFile: (path, bytes) => mutate(path, { bytes }, undefined, true),
    async lstat(path) {
      const located = await locate(path);
      const artifact = await current(located.state.id);
      if (!located.path) {
        return { type: "directory" };
      }
      const node = artifact.content?.tree[located.path];
      if (!node) {
        throw new Error("Artifact entry does not exist");
      }
      return { type: node.type };
    },
    mkdir: (path) => mutate(path, { type: "directory" }),
    async readDirectory(path) {
      const located = await locate(path);
      const tree = (await current(located.state.id)).content?.tree ?? {};
      if (located.path && tree[located.path]?.type !== "directory") {
        throw new Error("Artifact entry is not a directory");
      }
      const prefix = located.path ? `${located.path}/` : "";
      return Object.entries(tree).flatMap(([entryPath, node]) => {
        const name = entryPath.slice(prefix.length);
        return entryPath.startsWith(prefix) && name && !name.includes("/")
          ? [{ name, type: node.type }]
          : [];
      });
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
      const node = (await current(located.state.id)).content?.tree[
        located.path
      ];
      if (node?.type !== "symlink") {
        throw new Error("Artifact entry is not a symlink");
      }
      return node.target;
    },
    async realpath(path) {
      const located = await locate(path);
      const artifact = await current(located.state.id);
      const node: StorageNode | undefined = located.path
        ? artifact.content?.tree[located.path]
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
        if (entry.name.startsWith(".")) {
          continue;
        }
        let id: ArtifactId;
        try {
          id = artifactIdSchema.parse(decodeURIComponent(entry.name));
        } catch {
          continue;
        }
        if (encodeURIComponent(id).replace(/\./g, "%2E") !== entry.name) {
          continue;
        }
        if (!(await artifacts.get(id))) {
          await apply(id);
        }
      }
    },
    reference: "artifactId",
    remove: (path) => mutate(path, null),
    async replaceFile(path, bytes, expectedDigest) {
      const located = await locate(path);
      const entry = (await current(located.state.id)).content?.tree[
        located.path
      ];
      if (entry?.type !== "file") {
        throw new Error("Cannot replace a non-file entry");
      }
      await mutate(path, { bytes, mime: entry.mime }, expectedDigest);
    },
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

function descriptor(node: StorageNode): StorageNode;
function descriptor(node: StorageNode | undefined): StorageNode | undefined;
function descriptor(node: StorageNode | undefined): StorageNode | undefined {
  if (node?.type !== "file") {
    return node;
  }
  return {
    bytes: node.bytes,
    digest: node.digest,
    mime: node.mime,
    type: "file",
  };
}

async function stat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function ensureDirectory(path: string): Promise<void> {
  const existing = await stat(path);
  if (existing && !existing.isDirectory()) {
    await rm(path, { force: true, recursive: true });
  }
  await mkdir(path, { recursive: true });
}

async function confinedParents(root: string, target: string): Promise<void> {
  let parent = dirname(target);
  while (parent !== root) {
    if (!isFilesystemPathWithin(root, parent, sep)) {
      throw new Error("Path escapes Artifact root");
    }
    const entry = await stat(parent);
    if (!entry?.isDirectory()) {
      throw new Error("Artifact parent is not a directory");
    }
    parent = dirname(parent);
  }
  if (!(await lstat(root)).isDirectory()) {
    throw new Error("Artifact root is not a directory");
  }
}

async function prune(
  root: string,
  prefix: string,
  tree: StorageTree
): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    const node = tree[path];
    const target = join(root, entry.name);
    if (!Object.hasOwn(tree, path)) {
      await rm(target, { force: true, recursive: true });
    } else if (entry.isDirectory() && node?.type === "directory") {
      await prune(target, `${path}/`, tree);
    }
  }
}

async function replace(
  path: string,
  bytes: AsyncIterable<Uint8Array>
): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${crypto.randomUUID()}.tmp`
  );
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      for await (const part of bytes) {
        await file.writeFile(part);
      }
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function scan(root: string): Promise<StorageTree> {
  const tree = Object.create(null) as Record<string, StorageNode>;
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: All storage node types are handled by the same traversal.
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      const target = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        tree[path] = { target: await readlink(target), type: "symlink" };
      } else if (entry.isDirectory()) {
        tree[path] = { type: "directory" };
        await walk(target, `${path}/`);
      } else if (entry.isFile()) {
        const bytes = await readFile(target);
        tree[path] = {
          bytes: bytes.byteLength,
          digest: await sha256Hex(bytes),
          mime: null,
          type: "file",
        };
      } else if (entry.isSocket()) {
        tree[path] = { type: "socket" };
      } else if (entry.isFIFO()) {
        tree[path] = { type: "pipe" };
      } else if (entry.isBlockDevice() || entry.isCharacterDevice()) {
        tree[path] = { type: "device" };
      }
    }
  }
  await walk(root, "");
  return tree;
}
