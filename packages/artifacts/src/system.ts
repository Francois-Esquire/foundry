import type { Page } from "@foundry/core/pagination";
import type { StorageNode, StorageTree } from "@foundry/core/storage";

import { isStoragePath, withParentDirectories } from "@foundry/core/storage";
import { canonicalizeJson } from "@foundry/lib/json";

import type { BlobFiles, ContentTree, StoredFile } from "./blob";
import { BlobRepository } from "./blobs";
import { MAX_FILE_BYTES, MAX_TREE_BYTES } from "./constants";
import {
  ArtifactApplicationError,
  ArtifactExistsError,
  ArtifactNotFoundError,
  ContentInUseError,
  ContentNotFoundError,
  ContentStateError,
  DuplicateTagError,
  FilePointerError,
  FileTooLargeError,
  InvalidArtifactInputError,
  StaleContentError,
} from "./errors";
import type { ArtifactCursor } from "./pagination";
import type { ArtifactId, BlobId, ContentId } from "./ref";
import { artifactIdSchema, contentIdSchema } from "./ref";
import type { ArtifactStore } from "./store";
import type {
  Artifact,
  ArtifactResolved,
  Artifacts,
  Content,
  ContentResolved,
  ContentSummary,
  CreateArtifactInput,
  FileRangeResolved,
  FileResolved,
  FreezeOption,
  ListArtifactsInput,
  ListContentsInput,
  ReviseInput,
  TreeChanges,
  WriteFence,
  WriteInput,
} from "./substrate";
import type { ContentMetadata } from "./tree";
import { digestTree, isGoodContent, rootPath } from "./tree";

export interface ArtifactSystemOptions {
  readonly files?: BlobFiles;
  readonly maxFileBytes?: number;
  readonly maxTreeBytes?: number;
  readonly onMutation?: (id: ArtifactId) => void;
  readonly store: ArtifactStore;
}

interface Operation {
  active: boolean;
  readonly changed: Set<ArtifactId>;
  committed: boolean;
  readonly published: Set<string>;
  readonly retired: Set<string>;
}

export class ArtifactSystem implements Artifacts {
  readonly #options: ArtifactSystemOptions;
  readonly #store: ArtifactStore;
  // biome-ignore lint/style/useReadonlyClassProperties: Transaction setup assigns this field on a scoped instance.
  #operation: Operation | undefined;
  // biome-ignore lint/style/useReadonlyClassProperties: Transaction setup assigns this field on a scoped instance.
  #root: ArtifactSystem;
  readonly #bindings = new Set<(id: ArtifactId) => Promise<void>>();
  readonly #observers = new Set<(id: ArtifactId) => void>();

  constructor(options: ArtifactSystemOptions) {
    this.#options = options;
    this.#store = options.store;
    this.#root = this;
  }

  bind(apply: (id: ArtifactId) => Promise<void>): () => void {
    this.#root.#bindings.add(apply);
    return () => {
      this.#root.#bindings.delete(apply);
    };
  }

  observe(changed: (id: ArtifactId) => void): () => void {
    this.#root.#observers.add(changed);
    return () => {
      this.#root.#observers.delete(changed);
    };
  }

  async transaction<T>(
    operation: (artifacts: ArtifactSystem) => Promise<T>
  ): Promise<T> {
    if (this.#operation) {
      this.#assertActive();
      return operation(this);
    }
    const context: Operation = {
      active: true,
      changed: new Set(),
      committed: false,
      published: new Set(),
      retired: new Set(),
    };
    try {
      return await this.#store.transaction(async (store) => {
        const scoped = new ArtifactSystem({ ...this.#options, store });
        scoped.#root = this.#root;
        scoped.#operation = context;
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep commit notification and cleanup ordering together.
        store.afterCommit(async () => {
          context.committed = true;
          context.active = false;
          try {
            for (const id of context.changed) {
              for (const apply of this.#root.#bindings) {
                await apply(id);
              }
            }
          } catch (cause) {
            throw new ArtifactApplicationError([...context.changed], { cause });
          }
          for (const id of context.changed) {
            for (const changed of this.#root.#observers) {
              this.#report(changed, id);
            }
            if (this.#options.onMutation) {
              this.#report(this.#options.onMutation, id);
            }
          }
          await this.#removeFiles(context.retired);
        });
        return operation(scoped);
      });
    } catch (error) {
      if (!context.committed) {
        await this.#removeFiles(context.published);
      }
      throw error;
    } finally {
      context.active = false;
    }
  }

  async create(input: CreateArtifactInput): Promise<ArtifactResolved> {
    nonEmpty("name", input.name);
    nonEmpty("type", input.type);
    return this.transaction(async (system) => {
      const id = input.id ?? artifactIdSchema.parse(crypto.randomUUID());
      if (await system.#store.getArtifact(id)) {
        throw new ArtifactExistsError(id);
      }
      const now = new Date();
      await system.#store.putArtifact({
        archivedAt: null,
        contentId: null,
        createdAt: now,
        id,
        metadata: {},
        name: input.name,
        publishedAt: null,
        status: "draft",
        type: input.type,
        updatedAt: now,
      });
      if (input.entries !== undefined) {
        const content = await system.#insert(
          id,
          await system.#apply({}, { put: input.entries }),
          merge({}, input.metadata)
        );
        await system.#point(id, content.id);
        if (input.freeze) {
          await system.freeze(content.id, input.freeze);
        }
      }
      system.#changed(id);
      await system.#blobs().reclaim();
      return system.#requireArtifact(id);
    });
  }

  async get(id: ArtifactId): Promise<ArtifactResolved | null> {
    if (!this.#operation) {
      return this.#read((system) => system.get(id));
    }
    this.#assertActive();
    const artifact = await this.#store.getArtifact(id);
    if (!artifact) {
      return null;
    }
    return {
      ...artifact,
      content:
        artifact.contentId === null
          ? null
          : await this.#requireContent(artifact.contentId),
    };
  }

  async list(
    input: ListArtifactsInput = {}
  ): Promise<Page<ArtifactResolved, ArtifactCursor>> {
    if (!this.#operation) {
      return this.#read((system) => system.list(input));
    }
    this.#assertActive();
    const page = await this.#store.listArtifacts(input);
    const items = await Promise.all(
      page.items.map(async (row) => ({
        ...row,
        content:
          row.contentId === null
            ? null
            : await this.#requireContent(row.contentId),
      }))
    );
    return { ...page, items };
  }

  async rename(id: ArtifactId, name: string): Promise<Artifact> {
    nonEmpty("name", name);
    return this.#updateArtifact(id, () => ({ name }));
  }

  patchArtifactMetadata(
    id: ArtifactId,
    patch: Readonly<Record<string, unknown>>
  ): Promise<Artifact> {
    return this.#updateArtifact(id, (row) => ({
      metadata: merge(row.metadata, patch),
    }));
  }

  archive(id: ArtifactId): Promise<Artifact> {
    return this.#updateArtifact(id, (row) => ({
      archivedAt: row.archivedAt ?? new Date(),
      status: "archived",
    }));
  }

  unarchive(id: ArtifactId): Promise<Artifact> {
    return this.#updateArtifact(id, (row) => ({
      archivedAt: null,
      status: row.publishedAt ? "published" : "draft",
    }));
  }

  clearFailedContent(input: {
    readonly artifactId: ArtifactId;
    readonly expectedContentId: ContentId;
  }): Promise<ArtifactResolved> {
    return this.transaction(async (system) => {
      const artifact = await system.#requireArtifact(input.artifactId);
      system.#fence(artifact, input);
      const content = await system.#requireContent(input.expectedContentId);
      if (content.state !== "failed") {
        throw new ContentStateError(content.id, content.state, "clear");
      }
      await system.#point(artifact.id, null);
      return system.#requireArtifact(artifact.id);
    });
  }

  delete(id: ArtifactId): Promise<boolean> {
    return this.transaction(async (system) => {
      if (!(await system.#store.getArtifact(id))) {
        return false;
      }
      await system.#point(id, null);
      await system.#store.deleteArtifact(id);
      await system.#blobs().reclaim();
      system.#changed(id);
      return true;
    });
  }

  write(input: WriteInput): Promise<ContentResolved> {
    return this.transaction(async (system) => {
      const artifact = await system.#requireArtifact(input.artifactId);
      system.#fence(artifact, input);
      const active = artifact.content;
      if (active && active.state !== "ready") {
        throw new ContentStateError(active.id, active.state, "write");
      }
      const tree = await system.#apply(
        active?.tree ?? {},
        input.changes,
        active?.id
      );
      const metadata = merge(active?.metadata ?? {}, input.metadata);
      validatePointers(metadata, tree);
      let content: Content;
      if (active) {
        content = {
          ...active,
          digest: await digestTree(tree),
          metadata,
          tree,
          updatedAt: nextTime(active),
        };
        await system.#store.putContent(content);
      } else {
        content = await system.#insert(artifact.id, tree, metadata);
      }
      await system.#point(artifact.id, content.id);
      if (input.freeze) {
        await system.freeze(content.id, input.freeze);
      }
      await system.#blobs().reclaim();
      return system.#resolvedContent(content.id);
    });
  }

  revise(input: ReviseInput): Promise<ContentResolved> {
    return this.transaction(async (system) => {
      const artifact = await system.#requireArtifact(input.artifactId);
      const source = await system.#requireContent(input.contentId);
      if (source.artifactId !== artifact.id) {
        throw new InvalidArtifactInputError(
          "contentId",
          "Content belongs to another Artifact"
        );
      }
      system.#fence(artifact, {
        expectedContentId: input.contentId,
        expectedUpdatedAt: input.expectedUpdatedAt,
      });
      if (!isGoodContent(source)) {
        throw new ContentStateError(source.id, source.state, "revise");
      }
      if (source.state === "ready") {
        const now = nextTime(source);
        await system.#store.putContent({
          ...source,
          frozenAt: now,
          state: "frozen",
          updatedAt: now,
        });
      }
      const content = await system.#insert(
        artifact.id,
        await system.#apply(source.tree, input.changes ?? {}),
        merge(copiedMetadata(source), input.metadata)
      );
      await system.#point(artifact.id, content.id);
      await system.#blobs().reclaim();
      return system.#resolvedContent(content.id);
    });
  }

  freeze(
    id: ContentId,
    option: FreezeOption & { readonly expectedUpdatedAt?: Date } = {}
  ): Promise<Content> {
    return this.transaction(async (system) => {
      const row = await system.#requireContent(id);
      if (
        option.expectedUpdatedAt !== undefined &&
        option.expectedUpdatedAt.getTime() !== row.updatedAt.getTime()
      ) {
        throw new StaleContentError(row.artifactId, {
          contentId: id,
          updatedAt: row.updatedAt,
        });
      }
      if (!isGoodContent(row)) {
        throw new ContentStateError(id, row.state, "freeze");
      }
      if (row.state === "frozen") {
        if (option.tag !== undefined) {
          await system.tag(id, option.tag);
        }
        if (option.metadata !== undefined) {
          await system.setMetadata(id, option.metadata);
        }
        return system.#requireContent(id);
      }
      if (option.tag !== undefined) {
        await system.#tagFree(row, option.tag);
      }
      const metadata = merge(row.metadata, option.metadata);
      validatePointers(metadata, row.tree);
      const now = nextTime(row);
      const content: Content = {
        ...row,
        frozenAt: now,
        metadata,
        state: "frozen",
        tag: option.tag ?? row.tag,
        updatedAt: now,
      };
      await system.#store.putContent(content);
      await system.#updateArtifact(row.artifactId, (artifact) => ({
        publishedAt: artifact.publishedAt ?? now,
        status: artifact.status === "draft" ? "published" : artifact.status,
      }));
      return content;
    });
  }

  select(input: {
    readonly artifactId: ArtifactId;
    readonly contentId: ContentId;
    readonly expectedContentId?: ContentId | null;
  }): Promise<ArtifactResolved> {
    return this.transaction(async (system) => {
      const artifact = await system.#requireArtifact(input.artifactId);
      system.#fence(artifact, input);
      const target = await system.#requireContent(input.contentId);
      if (target.artifactId !== artifact.id) {
        throw new InvalidArtifactInputError(
          "contentId",
          "Content belongs to another Artifact"
        );
      }
      if (!isGoodContent(target) && isGoodContent(artifact.content)) {
        throw new ContentStateError(target.id, target.state, "select");
      }
      if (artifact.contentId !== target.id) {
        await system.#point(artifact.id, target.id);
      }
      return system.#requireArtifact(artifact.id);
    });
  }

  fork(input: {
    readonly id?: ArtifactId;
    readonly contentId: ContentId;
    readonly name?: string;
  }): Promise<ArtifactResolved> {
    return this.transaction(async (system) => {
      let source = await system.#requireContent(input.contentId);
      if (!isGoodContent(source)) {
        throw new ContentStateError(source.id, source.state, "fork");
      }
      if (source.state === "ready") {
        source = await system.freeze(source.id);
      }
      const original = await system.#requireArtifact(source.artifactId);
      const artifact = await system.create({
        id: input.id,
        name: input.name ?? original.name,
        type: original.type,
      });
      const content = await system.#insert(
        artifact.id,
        source.tree,
        copiedMetadata(source)
      );
      await system.#point(artifact.id, content.id);
      return system.#requireArtifact(artifact.id);
    });
  }

  tag(id: ContentId, tag: string | null): Promise<Content> {
    return this.transaction(async (system) => {
      const row = await system.#requireContent(id);
      if (tag !== null) {
        await system.#tagFree(row, tag);
      }
      const content = { ...row, tag };
      await system.#store.putContent(content);
      system.#changed(row.artifactId);
      return content;
    });
  }

  setMetadata(
    id: ContentId,
    patch: Readonly<Record<string, unknown>>
  ): Promise<Content> {
    return this.transaction(async (system) => {
      const row = await system.#requireContent(id);
      const metadata = merge(row.metadata, patch);
      if (
        row.state === "frozen" &&
        canonicalizeJson(semanticMetadata(metadata)) !==
          canonicalizeJson(semanticMetadata(row.metadata))
      ) {
        throw new ContentStateError(id, row.state, "setMetadata");
      }
      validatePointers(metadata, row.tree);
      const content = { ...row, metadata, updatedAt: nextTime(row) };
      await system.#store.putContent(content);
      system.#changed(row.artifactId);
      return content;
    });
  }

  async getContent(id: ContentId): Promise<ContentResolved | null> {
    if (!this.#operation) {
      return this.#read((system) => system.getContent(id));
    }
    this.#assertActive();
    const content = await this.#store.getContent(id);
    if (!content) {
      return null;
    }
    const artifact = await this.#store.getArtifact(content.artifactId);
    if (!artifact) {
      throw new ArtifactNotFoundError(content.artifactId);
    }
    return { ...content, artifact };
  }

  async listContents(
    id: ArtifactId,
    input: ListContentsInput = {}
  ): Promise<readonly ContentSummary[]> {
    if (!this.#operation) {
      return this.#read((system) => system.listContents(id, input));
    }
    this.#assertActive();
    return (await this.#store.listContents(id, input)).map(
      ({ tree: _tree, ...content }) => content
    );
  }

  async findContent(
    id: ArtifactId,
    by: { readonly sessionId: string; readonly messageId: string }
  ): Promise<Content | null> {
    if (!this.#operation) {
      return this.#read((system) => system.findContent(id, by));
    }
    this.#assertActive();
    return (
      [...(await this.#store.listContents(id))]
        .reverse()
        .find(
          (row) =>
            row.metadata.sessionId === by.sessionId &&
            row.metadata.messageId === by.messageId
        ) ?? null
    );
  }

  deleteContent(input: {
    readonly contentId: ContentId;
    readonly replacementContentId?: ContentId;
  }): Promise<void> {
    return this.transaction(async (system) => {
      const row = await system.#requireContent(input.contentId);
      const artifact = await system.#requireArtifact(row.artifactId);
      if (artifact.contentId === row.id) {
        if (
          input.replacementContentId === undefined ||
          input.replacementContentId === row.id
        ) {
          throw new InvalidArtifactInputError(
            "replacementContentId",
            "Active Content needs another Content as replacement"
          );
        }
        const replacement = await system.#requireContent(
          input.replacementContentId
        );
        if (!isGoodContent(replacement)) {
          throw new ContentStateError(
            replacement.id,
            replacement.state,
            "replace deleted Content"
          );
        }
        await system.select({
          artifactId: artifact.id,
          contentId: replacement.id,
        });
      }
      await system.#store.deleteContent(row.id);
      await system.#blobs().reclaim();
      system.#changed(row.artifactId);
    });
  }

  async readFile(id: ContentId, path: string): Promise<FileResolved | null> {
    return this.#read(async (system) => {
      const content = await system.#requireContent(id);
      const entry = content.tree[path];
      if (!Object.hasOwn(content.tree, path) || entry?.type !== "file") {
        return null;
      }
      const repository = system.#blobs();
      const blob = await repository.require(entry.blobId);
      if (blob.digest !== entry.digest || blob.byteLength !== entry.bytes) {
        throw new Error(`Blob descriptor mismatch: ${path}`);
      }
      const bytes = new Uint8Array(entry.bytes);
      let offset = 0;
      for await (const part of repository.read(blob, 0, entry.bytes)) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      if (offset !== entry.bytes) {
        throw new Error(`Truncated file: ${path}`);
      }
      const { blobId: _blobId, ...file } = entry;
      return { ...file, blob: bytes, path };
    });
  }

  async readFileRange(
    id: ContentId,
    path: string,
    range: { readonly start: number; readonly end?: number }
  ): Promise<FileRangeResolved | null> {
    const content = await this.#requireContent(id);
    const entry = content.tree[path];
    if (!Object.hasOwn(content.tree, path) || entry?.type !== "file") {
      return null;
    }
    const end = Math.min(range.end ?? entry.bytes, entry.bytes);
    const start = Math.max(0, Math.min(range.start, end));
    const repository = this.#blobs();
    const blob = await repository.require(entry.blobId);
    if (blob.digest !== entry.digest || blob.byteLength !== entry.bytes) {
      throw new Error(`Blob descriptor mismatch: ${path}`);
    }
    const { blobId: _blobId, ...file } = entry;
    return {
      ...file,
      body: repository.read(blob, start, end),
      path,
      range: { end, start },
    };
  }

  async readRoot(id: ContentId): Promise<FileResolved | null> {
    const path = rootPath(await this.#requireContent(id));
    return path === null ? null : this.readFile(id, path);
  }

  async readNamedRoot(
    id: ContentId,
    name: string
  ): Promise<FileResolved | null> {
    const path = (await this.#requireContent(id)).metadata.entries?.[name];
    return path === undefined ? null : this.readFile(id, path);
  }

  async readThumbnail(id: ContentId): Promise<FileResolved | null> {
    const path = (await this.#requireContent(id)).metadata.thumbnail;
    return path === undefined ? null : this.readFile(id, path);
  }

  sweep(input: {
    readonly olderThan: Date;
  }): Promise<{ readonly contents: number; readonly blobs: number }> {
    return this.transaction(async (system) => {
      let count = 0;
      for (const content of await system.#store.listContents()) {
        if (
          (content.state !== "ready" && content.state !== "failed") ||
          content.updatedAt >= input.olderThan
        ) {
          continue;
        }
        const artifact = await system.#store.getArtifact(content.artifactId);
        if (artifact?.contentId === content.id) {
          continue;
        }
        try {
          await system.#store.deleteContent(content.id);
        } catch (error) {
          if (error instanceof ContentInUseError) {
            continue;
          }
          throw error;
        }
        count += 1;
        system.#changed(content.artifactId);
      }
      return { blobs: await system.#blobs().reclaim(), contents: count };
    });
  }

  async recover(): Promise<void> {
    if (this.#operation) {
      throw new Error("Recover outside an Artifact transaction");
    }
    await this.#store.transaction(async (store) => {
      if (this.#options.files) {
        const retained = new Set(
          (await store.listBlobs()).flatMap((blob) =>
            blob.path ? [blob.path] : []
          )
        );
        for await (const path of this.#options.files.list()) {
          if (!retained.has(path)) {
            await this.#options.files.remove(path);
          }
        }
      }
    });
    let cursor: ListArtifactsInput["cursor"];
    do {
      const page = await this.list({ cursor, includeArchived: true });
      for (const artifact of page.items) {
        for (const apply of this.#root.#bindings) {
          await apply(artifact.id);
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
  }

  async #read<T>(
    operation: (system: ArtifactSystem) => Promise<T>
  ): Promise<T> {
    if (this.#operation) {
      this.#assertActive();
      return operation(this);
    }
    return this.#store.transaction(
      async (store) => {
        const scoped = new ArtifactSystem({ ...this.#options, store });
        scoped.#root = this.#root;
        const context: Operation = {
          active: true,
          changed: new Set(),
          committed: false,
          published: new Set(),
          retired: new Set(),
        };
        scoped.#operation = context;
        try {
          return await operation(scoped);
        } finally {
          context.active = false;
        }
      },
      { readOnly: true }
    );
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep write-fence validation and blob reuse checks together.
  async #apply(
    base: ContentTree,
    changes: TreeChanges,
    contentId?: ContentId
  ): Promise<ContentTree> {
    for (const path of [
      ...(changes.remove ?? []),
      ...Object.keys(changes.put ?? {}),
    ]) {
      if (!isStoragePath(path)) {
        throw new InvalidArtifactInputError(
          "path",
          `Invalid storage path: ${path}`
        );
      }
    }
    const tree = Object.assign(
      Object.create(null) as Record<
        string,
        StoredFile | Exclude<StorageNode, { type: "file" }>
      >,
      Object.fromEntries(
        changes.replace
          ? []
          : Object.entries(base).filter(
              ([path]) =>
                !(changes.remove ?? []).some(
                  (removed) =>
                    path === removed || path.startsWith(`${removed}/`)
                )
            )
      )
    );
    const repository = this.#blobs();
    for (const [path, entry] of Object.entries(changes.put ?? {})) {
      if (entry.type !== undefined && entry.type !== "file") {
        tree[path] =
          entry.type === "symlink"
            ? { target: entry.target, type: "symlink" }
            : { type: entry.type };
        continue;
      }
      const previous = base[path];
      let reuse: BlobId | undefined;
      if (
        contentId &&
        previous?.type === "file" &&
        !Object.entries(changes.put ?? {}).some(
          ([otherPath, other]) =>
            otherPath !== path &&
            (("blobId" in other && other.blobId === previous.blobId) ||
              ("digest" in other && other.digest === previous.digest))
        ) &&
        !(await this.#store.isBlobReferenced(previous.blobId, {
          contentId,
          path,
        }))
      ) {
        reuse = previous.blobId;
      }
      const blob = await repository.put(path, entry, reuse);
      tree[path] = {
        blobId: blob.id,
        bytes: blob.byteLength,
        digest: blob.digest,
        mime: entry.mime ?? null,
        type: "file",
      };
    }
    const complete = withParentDirectories(tree) as ContentTree;
    const total = Object.values(complete).reduce(
      (sum, node) => sum + (node.type === "file" ? node.bytes : 0),
      0
    );
    const limit = this.#options.maxTreeBytes ?? MAX_TREE_BYTES;
    if (total > limit) {
      throw new FileTooLargeError(null, total, limit);
    }
    return complete;
  }

  async #insert(
    artifactId: ArtifactId,
    tree: ContentTree,
    metadata: ContentMetadata
  ): Promise<Content> {
    validatePointers(metadata, tree);
    const now = new Date();
    const content: Content = {
      artifactId,
      createdAt: now,
      digest: await digestTree(tree),
      frozenAt: null,
      id: contentIdSchema.parse(crypto.randomUUID()),
      metadata,
      state: "ready",
      tag: null,
      tree,
      updatedAt: now,
    };
    await this.#store.putContent(content);
    return content;
  }

  #updateArtifact(
    id: ArtifactId,
    update: (artifact: Artifact) => Partial<Artifact>
  ): Promise<Artifact> {
    return this.transaction(async (system) => {
      const previous = await system.#store.getArtifact(id);
      if (!previous) {
        throw new ArtifactNotFoundError(id);
      }
      const artifact = {
        ...previous,
        ...update(previous),
        updatedAt: new Date(),
      };
      canonicalizeJson(artifact.metadata);
      await system.#store.putArtifact(artifact);
      system.#changed(id);
      return artifact;
    });
  }

  async #point(id: ArtifactId, contentId: ContentId | null): Promise<void> {
    await this.#updateArtifact(id, () => ({ contentId }));
  }

  async #tagFree(row: Content, tag: string): Promise<void> {
    nonEmpty("tag", tag);
    if (
      (await this.#store.listContents(row.artifactId)).some(
        (other) => other.id !== row.id && other.tag === tag
      )
    ) {
      throw new DuplicateTagError(row.artifactId, tag);
    }
  }

  #fence(artifact: ArtifactResolved, fence: WriteFence): void {
    if (
      (fence.expectedContentId !== undefined &&
        fence.expectedContentId !== artifact.contentId) ||
      (fence.expectedUpdatedAt !== undefined &&
        fence.expectedUpdatedAt.getTime() !==
          artifact.content?.updatedAt.getTime())
    ) {
      throw new StaleContentError(artifact.id, {
        contentId: artifact.contentId,
        updatedAt: artifact.content?.updatedAt ?? null,
      });
    }
  }

  async #requireArtifact(id: ArtifactId): Promise<ArtifactResolved> {
    const artifact = await this.get(id);
    if (!artifact) {
      throw new ArtifactNotFoundError(id);
    }
    return artifact;
  }

  async #requireContent(id: ContentId): Promise<Content> {
    this.#assertActive();
    const content = await this.#store.getContent(id);
    if (!content) {
      throw new ContentNotFoundError(id);
    }
    return content;
  }

  async #resolvedContent(id: ContentId): Promise<ContentResolved> {
    const content = await this.getContent(id);
    if (!content) {
      throw new ContentNotFoundError(id);
    }
    return content;
  }

  #blobs(): BlobRepository {
    this.#assertActive();
    return new BlobRepository(
      this.#store,
      this.#options.files,
      this.#operation?.published ?? new Set(),
      this.#operation?.retired ?? new Set(),
      this.#options.maxFileBytes ?? MAX_FILE_BYTES
    );
  }

  #changed(id: ArtifactId): void {
    this.#assertActive();
    if (!this.#operation) {
      throw new Error("Mutation requires an Artifact transaction");
    }
    this.#operation.changed.add(id);
  }

  #assertActive(): void {
    if (this.#operation && !this.#operation.active) {
      throw new Error("Artifact transaction has settled");
    }
  }

  #report(observer: (id: ArtifactId) => void, id: ArtifactId): void {
    try {
      observer(id);
    } catch (error) {
      console.error(`Artifact ${id} observer failed`, error);
    }
  }

  async #removeFiles(paths: ReadonlySet<string>): Promise<void> {
    if (!this.#options.files) {
      return;
    }
    for (const path of paths) {
      try {
        await this.#options.files.remove(path);
      } catch (error) {
        console.error("Artifact file cleanup requires retry", error);
      }
    }
  }
}

function validatePointers(metadata: ContentMetadata, tree: StorageTree): void {
  canonicalizeJson(metadata);
  for (const [key, path] of Object.entries({
    entry: metadata.entry,
    thumbnail: metadata.thumbnail,
    ...Object.fromEntries(
      Object.entries(metadata.entries ?? {}).map(([name, entryPath]) => [
        `entries.${name}`,
        entryPath,
      ])
    ),
  })) {
    if (
      path !== undefined &&
      (!Object.hasOwn(tree, path) || tree[path]?.type !== "file")
    ) {
      throw new FilePointerError(key, path);
    }
  }
}

function copiedMetadata(source: Content): ContentMetadata {
  const {
    sessionId: _s,
    messageId: _m,
    runId: _r,
    generation: _g,
    failure: _f,
    ...rest
  } = source.metadata;
  return { ...rest, from: source.id };
}

function merge(
  base: ContentMetadata,
  patch?: Readonly<Record<string, unknown>>
): ContentMetadata {
  return Object.fromEntries(
    Object.entries({ ...base, ...patch }).filter(
      ([, value]) => value !== undefined
    )
  );
}

function semanticMetadata(metadata: ContentMetadata): ContentMetadata {
  const { label: _label, pinned: _pinned, ...semantic } = metadata;
  return semantic;
}

function nextTime(row: Content): Date {
  return new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1));
}

function nonEmpty(field: string, value: string): void {
  if (!value.trim()) {
    throw new InvalidArtifactInputError(field, "must not be empty");
  }
}
