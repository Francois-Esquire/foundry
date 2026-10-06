import type { Page } from "@foundry/core/pagination";
import type { StorageNode } from "@foundry/core/storage";

import { isStoragePath, withParentDirectories } from "@foundry/core/storage";

import type { Blob, BlobFiles, ContentTree, StoredFile } from "./blob";
import type { BlobEffects, ByteInput } from "./blob-repository";
import { BlobRepository, isReferenceInput } from "./blob-repository";
import type { ContentMetadata } from "./content";
import {
  assertJsonMetadata,
  digestTree,
  isUsableContent,
  mergeMetadata,
  rootPath,
  semanticMetadataChanged,
  successorMetadata,
  validatePointers,
} from "./content";
import {
  ArtifactExistsError,
  ArtifactNotFoundError,
  ContentInUseError,
  ContentNotFoundError,
  ContentStateError,
  DuplicateTagError,
  FileTooLargeError,
  InvalidArtifactInputError,
  StaleContentError,
} from "./errors";
import type { ArtifactCursor } from "./listing";
import type { ArtifactId, BlobId, ContentId } from "./ref";
import { artifactIdSchema, contentIdSchema } from "./ref";
import type { ArtifactStoreTransaction } from "./store";
import type {
  Artifact,
  ArtifactOperations,
  ArtifactResolved,
  Content,
  ContentResolved,
  ContentSummary,
  CreateArtifactInput,
  EntryInput,
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

/** What one operation changed, settled by the manager after commit or rollback. */
export interface OperationEffects extends BlobEffects {
  readonly changed: Set<ArtifactId>;
  committed: boolean;
}

export function operationEffects(): OperationEffects {
  return {
    changed: new Set(),
    committed: false,
    published: new Set(),
    released: new Set(),
    retired: new Set(),
  };
}

export interface TransactionLimits {
  readonly files?: BlobFiles;
  readonly maxFileBytes: number;
  readonly maxTreeBytes: number;
}

/** A located file entry and the object holding its bytes. */
export interface LocatedFile {
  readonly blob: Blob;
  readonly entry: StoredFile;
  readonly path: string;
}

/** The Artifact operations within one store transaction. */
export class ArtifactTransaction implements ArtifactOperations {
  readonly #store: ArtifactStoreTransaction;
  readonly #effects: OperationEffects;
  readonly #blobs: BlobRepository;
  readonly #maxTreeBytes: number;

  constructor(
    store: ArtifactStoreTransaction,
    effects: OperationEffects,
    limits: TransactionLimits
  ) {
    this.#store = store;
    this.#effects = effects;
    this.#blobs = new BlobRepository(store, effects, limits);
    this.#maxTreeBytes = limits.maxTreeBytes;
  }

  async create(input: CreateArtifactInput): Promise<ArtifactResolved> {
    nonEmpty("name", input.name);
    nonEmpty("type", input.type);
    const id = input.id ?? artifactIdSchema.parse(crypto.randomUUID());
    if (await this.#store.getArtifact(id)) {
      throw new ArtifactExistsError(id);
    }
    const now = new Date();
    await this.#store.putArtifact({
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
    this.#effects.changed.add(id);
    if (input.entries !== undefined) {
      await this.write({
        artifactId: id,
        changes: { put: input.entries },
        ...(input.freeze ? { freeze: input.freeze } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      });
    }
    return this.#requireArtifact(id);
  }

  async get(id: ArtifactId): Promise<ArtifactResolved | null> {
    const artifact = await this.#store.getArtifact(id);
    return artifact && this.#resolveArtifact(artifact);
  }

  async list(
    input: ListArtifactsInput = {}
  ): Promise<Page<ArtifactResolved, ArtifactCursor>> {
    const page = await this.#store.listArtifacts(input);
    return {
      ...page,
      items: await Promise.all(
        page.items.map((row) => this.#resolveArtifact(row))
      ),
    };
  }

  rename(id: ArtifactId, name: string): Promise<Artifact> {
    nonEmpty("name", name);
    return this.#updateArtifact(id, () => ({ name }));
  }

  patchArtifactMetadata(
    id: ArtifactId,
    patch: Readonly<Record<string, unknown>>
  ): Promise<Artifact> {
    return this.#updateArtifact(id, (row) => ({
      metadata: mergeMetadata(row.metadata, patch),
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

  async clearFailedContent(input: {
    readonly artifactId: ArtifactId;
    readonly expectedContentId: ContentId;
  }): Promise<ArtifactResolved> {
    const artifact = await this.#requireArtifact(input.artifactId);
    fence(artifact, input);
    const content = await this.#requireContent(input.expectedContentId);
    if (content.state !== "failed") {
      throw new ContentStateError(content.id, content.state, "clear");
    }
    await this.#point(artifact.id, null);
    return this.#requireArtifact(artifact.id);
  }

  async delete(id: ArtifactId): Promise<boolean> {
    if (!(await this.#store.getArtifact(id))) {
      return false;
    }
    await this.#point(id, null);
    for (const content of await this.#store.listContents(id)) {
      this.#releaseTree(content.tree);
    }
    await this.#store.deleteArtifact(id);
    return true;
  }

  async write(input: WriteInput): Promise<ContentResolved> {
    const artifact = await this.#requireArtifact(input.artifactId);
    fence(artifact, input);
    const active = artifact.content;
    if (active && active.state !== "ready") {
      throw new ContentStateError(active.id, active.state, "write");
    }
    const tree = await this.#applyChanges(
      active?.tree ?? {},
      input.changes,
      active?.id
    );
    const metadata = mergeMetadata(active?.metadata ?? {}, input.metadata);
    let content: Content;
    if (active) {
      validatePointers(metadata, tree);
      content = {
        ...active,
        digest: await digestTree(tree),
        metadata,
        tree,
        updatedAt: nextTime(active),
      };
      await this.#store.putContent(content);
      this.#releaseTree(active.tree);
    } else {
      content = await this.#insert(artifact.id, tree, metadata);
    }
    await this.#point(artifact.id, content.id);
    if (input.freeze) {
      await this.freeze(content.id, input.freeze);
    }
    return this.#resolvedContent(content.id);
  }

  async revise(input: ReviseInput): Promise<ContentResolved> {
    const artifact = await this.#requireArtifact(input.artifactId);
    const source = await this.#requireOwnContent(artifact, input.contentId);
    fence(artifact, {
      expectedContentId: input.contentId,
      expectedUpdatedAt: input.expectedUpdatedAt,
    });
    if (!isUsableContent(source)) {
      throw new ContentStateError(source.id, source.state, "revise");
    }
    if (source.state === "ready") {
      await this.#markFrozen(source);
    }
    const content = await this.#insert(
      artifact.id,
      await this.#applyChanges(source.tree, input.changes ?? {}),
      mergeMetadata(successorMetadata(source), input.metadata)
    );
    await this.#point(artifact.id, content.id);
    return this.#resolvedContent(content.id);
  }

  /** Make Content immutable and publish its draft Artifact. */
  async freeze(
    id: ContentId,
    option: FreezeOption & { readonly expectedUpdatedAt?: Date } = {}
  ): Promise<Content> {
    const row = await this.#requireContent(id);
    if (
      option.expectedUpdatedAt !== undefined &&
      option.expectedUpdatedAt.getTime() !== row.updatedAt.getTime()
    ) {
      throw new StaleContentError(row.artifactId, {
        contentId: id,
        updatedAt: row.updatedAt,
      });
    }
    if (!isUsableContent(row)) {
      throw new ContentStateError(id, row.state, "freeze");
    }
    if (option.tag !== undefined) {
      await this.tag(id, option.tag);
    }
    if (option.metadata !== undefined) {
      await this.setMetadata(id, option.metadata);
    }
    const current = await this.#requireContent(id);
    if (current.state !== "ready") {
      return current;
    }
    const frozen = await this.#markFrozen(current);
    await this.#updateArtifact(row.artifactId, (artifact) => ({
      publishedAt: artifact.publishedAt ?? frozen.updatedAt,
      status: artifact.status === "draft" ? "published" : artifact.status,
    }));
    return frozen;
  }

  async select(input: {
    readonly artifactId: ArtifactId;
    readonly contentId: ContentId;
    readonly expectedContentId?: ContentId | null;
  }): Promise<ArtifactResolved> {
    const artifact = await this.#requireArtifact(input.artifactId);
    fence(artifact, input);
    const target = await this.#requireOwnContent(artifact, input.contentId);
    const displacesUsable =
      !isUsableContent(target) && isUsableContent(artifact.content);
    if (displacesUsable) {
      throw new ContentStateError(target.id, target.state, "select");
    }
    if (artifact.contentId !== target.id) {
      await this.#point(artifact.id, target.id);
    }
    return this.#requireArtifact(artifact.id);
  }

  async fork(input: {
    readonly id?: ArtifactId;
    readonly contentId: ContentId;
    readonly name?: string;
  }): Promise<ArtifactResolved> {
    let source = await this.#requireContent(input.contentId);
    if (!isUsableContent(source)) {
      throw new ContentStateError(source.id, source.state, "fork");
    }
    if (source.state === "ready") {
      source = await this.#markFrozen(source);
    }
    const original = await this.#requireArtifact(source.artifactId);
    const artifact = await this.create({
      id: input.id,
      name: input.name ?? original.name,
      type: original.type,
    });
    const content = await this.#insert(
      artifact.id,
      source.tree,
      successorMetadata(source)
    );
    await this.#point(artifact.id, content.id);
    return this.#requireArtifact(artifact.id);
  }

  async tag(id: ContentId, tag: string | null): Promise<Content> {
    const row = await this.#requireContent(id);
    if (tag !== null) {
      await this.#assertTagFree(row, tag);
    }
    const content = { ...row, tag };
    await this.#store.putContent(content);
    this.#effects.changed.add(row.artifactId);
    return content;
  }

  async setMetadata(
    id: ContentId,
    patch: Readonly<Record<string, unknown>>
  ): Promise<Content> {
    const row = await this.#requireContent(id);
    const metadata = mergeMetadata(row.metadata, patch);
    if (
      row.state === "frozen" &&
      semanticMetadataChanged(row.metadata, metadata)
    ) {
      throw new ContentStateError(id, row.state, "setMetadata");
    }
    validatePointers(metadata, row.tree);
    const content = { ...row, metadata, updatedAt: nextTime(row) };
    await this.#store.putContent(content);
    this.#effects.changed.add(row.artifactId);
    return content;
  }

  async getContent(id: ContentId): Promise<ContentResolved | null> {
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
    return (await this.#store.listContents(id, input)).map(
      ({ tree: _tree, ...content }) => content
    );
  }

  async findContent(
    id: ArtifactId,
    by: { readonly sessionId: string; readonly messageId: string }
  ): Promise<Content | null> {
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

  async deleteContent(input: {
    readonly contentId: ContentId;
    readonly replacementContentId?: ContentId;
  }): Promise<void> {
    const row = await this.#requireContent(input.contentId);
    const artifact = await this.#requireArtifact(row.artifactId);
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
      const replacement = await this.#requireContent(
        input.replacementContentId
      );
      if (!isUsableContent(replacement)) {
        throw new ContentStateError(
          replacement.id,
          replacement.state,
          "replace deleted Content"
        );
      }
      await this.select({ artifactId: artifact.id, contentId: replacement.id });
    }
    await this.#store.deleteContent(row.id);
    this.#releaseTree(row.tree);
    this.#effects.changed.add(row.artifactId);
  }

  async readFile(id: ContentId, path: string): Promise<FileResolved | null> {
    return this.#readFrom(await this.#requireContent(id), path);
  }

  async readFileRange(
    id: ContentId,
    path: string,
    range: { readonly start: number; readonly end?: number }
  ): Promise<FileRangeResolved | null> {
    const located = await this.locateFile(id, path);
    return (
      located &&
      fileRange(located, range, (blob, start, end) =>
        this.#blobs.read(blob, start, end)
      )
    );
  }

  async readRoot(id: ContentId): Promise<FileResolved | null> {
    const content = await this.#requireContent(id);
    return this.#readFrom(content, rootPath(content) ?? undefined);
  }

  async readNamedRoot(
    id: ContentId,
    name: string
  ): Promise<FileResolved | null> {
    const content = await this.#requireContent(id);
    return this.#readFrom(content, content.metadata.entries?.[name]);
  }

  async readThumbnail(id: ContentId): Promise<FileResolved | null> {
    const content = await this.#requireContent(id);
    return this.#readFrom(content, content.metadata.thumbnail);
  }

  async sweep(input: {
    readonly olderThan: Date;
  }): Promise<{ readonly contents: number; readonly blobs: number }> {
    let contents = 0;
    for (const content of await this.#store.listContents()) {
      if (
        (content.state !== "ready" && content.state !== "failed") ||
        content.updatedAt >= input.olderThan
      ) {
        continue;
      }
      const artifact = await this.#store.getArtifact(content.artifactId);
      if (artifact?.contentId === content.id) {
        continue;
      }
      try {
        await this.#store.deleteContent(content.id);
      } catch (error) {
        if (error instanceof ContentInUseError) {
          continue;
        }
        throw error;
      }
      contents += 1;
      this.#effects.changed.add(content.artifactId);
    }
    return { blobs: await this.#blobs.reclaimAll(), contents };
  }

  /** Find a file entry and verify its object still describes the same bytes. */
  async locateFile(id: ContentId, path: string): Promise<LocatedFile | null> {
    return this.#locate(await this.#requireContent(id), path);
  }

  /** Delete the blobs this transaction released, if nothing references them. */
  async reclaim(): Promise<void> {
    await this.#blobs.reclaim();
  }

  async #readFrom(
    content: Content,
    path: string | undefined
  ): Promise<FileResolved | null> {
    const located =
      path === undefined ? null : await this.#locate(content, path);
    if (!located) {
      return null;
    }
    const {
      body,
      range: _range,
      ...file
    } = fileRange(located, { start: 0 }, (blob, start, end) =>
      this.#blobs.read(blob, start, end)
    );
    return {
      ...file,
      blob: await collect(body, located.entry.bytes, file.path),
    };
  }

  async #locate(content: Content, path: string): Promise<LocatedFile | null> {
    const entry = Object.hasOwn(content.tree, path)
      ? content.tree[path]
      : undefined;
    if (entry?.type !== "file") {
      return null;
    }
    const blob = await this.#blobs.require(entry.blobId);
    if (blob.digest !== entry.digest || blob.byteLength !== entry.bytes) {
      throw new Error(`Blob descriptor mismatch: ${path}`);
    }
    return { blob, entry, path };
  }

  /**
   * Apply tree changes to `base`. Within `owner` (Content edited in place), a
   * file whose object no other reference holds is rewritten in place.
   * Reference inputs resolve first, so every object they name counts as shared.
   */
  async #applyChanges(
    base: ContentTree,
    changes: TreeChanges,
    owner?: ContentId
  ): Promise<ContentTree> {
    const removed = changes.remove ?? [];
    const puts = Object.entries(changes.put ?? {});
    for (const path of [...removed, ...Object.keys(changes.put ?? {})]) {
      if (!isStoragePath(path)) {
        throw new InvalidArtifactInputError(
          "path",
          `Invalid storage path: ${path}`
        );
      }
    }
    const tree: Record<string, ContentTree[string]> = Object.create(null);
    if (!changes.replace) {
      for (const [path, node] of Object.entries(base)) {
        if (
          !removed.some((gone) => path === gone || path.startsWith(`${gone}/`))
        ) {
          tree[path] = node;
        }
      }
    }
    const assigned = new Set<BlobId>();
    const bytes: [string, ByteInput][] = [];
    for (const [path, entry] of puts) {
      if (isStructural(entry)) {
        tree[path] = structuralNode(entry);
      } else if (isReferenceInput(entry)) {
        const blob = await this.#blobs.resolve(path, entry);
        assigned.add(blob.id);
        tree[path] = storedFile(blob, entry.mime);
      } else {
        bytes.push([path, entry]);
      }
    }
    for (const [path, entry] of bytes) {
      const owned = await this.#ownedObject(base[path], owner, path, assigned);
      const blob = await this.#blobs.write(path, entry, owned);
      assigned.add(blob.id);
      tree[path] = storedFile(blob, entry.mime);
    }
    const complete = withParentDirectories(tree) as ContentTree;
    const total = Object.values(complete).reduce(
      (sum, node) => sum + (node.type === "file" ? node.bytes : 0),
      0
    );
    if (total > this.#maxTreeBytes) {
      throw new FileTooLargeError(null, total, this.#maxTreeBytes);
    }
    return complete;
  }

  /** The object at `path` when only that entry of `owner` references it. */
  async #ownedObject(
    previous: ContentTree[string] | undefined,
    owner: ContentId | undefined,
    path: string,
    assigned: ReadonlySet<BlobId>
  ): Promise<BlobId | undefined> {
    if (
      owner === undefined ||
      previous?.type !== "file" ||
      assigned.has(previous.blobId)
    ) {
      return;
    }
    const shared = await this.#store.isBlobReferenced(previous.blobId, {
      contentId: owner,
      path,
    });
    return shared ? undefined : previous.blobId;
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

  /** Freeze without publishing; `freeze` adds publication. */
  async #markFrozen(row: Content): Promise<Content> {
    const now = nextTime(row);
    const content: Content = {
      ...row,
      frozenAt: now,
      state: "frozen",
      updatedAt: now,
    };
    await this.#store.putContent(content);
    this.#effects.changed.add(row.artifactId);
    return content;
  }

  async #updateArtifact(
    id: ArtifactId,
    update: (artifact: Artifact) => Partial<Artifact>
  ): Promise<Artifact> {
    const previous = await this.#store.getArtifact(id);
    if (!previous) {
      throw new ArtifactNotFoundError(id);
    }
    const artifact = {
      ...previous,
      ...update(previous),
      updatedAt: new Date(),
    };
    assertJsonMetadata(artifact.metadata);
    await this.#store.putArtifact(artifact);
    this.#effects.changed.add(id);
    return artifact;
  }

  async #point(id: ArtifactId, contentId: ContentId | null): Promise<void> {
    await this.#updateArtifact(id, () => ({ contentId }));
  }

  async #assertTagFree(row: Content, tag: string): Promise<void> {
    nonEmpty("tag", tag);
    if (
      (await this.#store.listContents(row.artifactId)).some(
        (other) => other.id !== row.id && other.tag === tag
      )
    ) {
      throw new DuplicateTagError(row.artifactId, tag);
    }
  }

  #releaseTree(tree: ContentTree): void {
    this.#blobs.release(
      Object.values(tree).flatMap((node) =>
        node.type === "file" ? [node.blobId] : []
      )
    );
  }

  async #resolveArtifact(artifact: Artifact): Promise<ArtifactResolved> {
    return {
      ...artifact,
      content:
        artifact.contentId === null
          ? null
          : await this.#requireContent(artifact.contentId),
    };
  }

  async #requireArtifact(id: ArtifactId): Promise<ArtifactResolved> {
    const artifact = await this.get(id);
    if (!artifact) {
      throw new ArtifactNotFoundError(id);
    }
    return artifact;
  }

  async #requireContent(id: ContentId): Promise<Content> {
    const content = await this.#store.getContent(id);
    if (!content) {
      throw new ContentNotFoundError(id);
    }
    return content;
  }

  async #requireOwnContent(
    artifact: Artifact,
    id: ContentId
  ): Promise<Content> {
    const content = await this.#requireContent(id);
    if (content.artifactId !== artifact.id) {
      throw new InvalidArtifactInputError(
        "contentId",
        "Content belongs to another Artifact"
      );
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
}

/** A ranged read of a located file, clamped to its length. */
export function fileRange(
  located: LocatedFile,
  range: { readonly start: number; readonly end?: number },
  read: (blob: Blob, start: number, end: number) => AsyncIterable<Uint8Array>
): FileRangeResolved {
  const { blobId: _blobId, ...file } = located.entry;
  const end = Math.min(range.end ?? file.bytes, file.bytes);
  const start = Math.max(0, Math.min(range.start, end));
  return {
    ...file,
    body: read(located.blob, start, end),
    path: located.path,
    range: { end, start },
  };
}

async function collect(
  body: AsyncIterable<Uint8Array>,
  length: number,
  path: string
): Promise<Uint8Array> {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for await (const part of body) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  if (offset !== length) {
    throw new Error(`Truncated file: ${path}`);
  }
  return bytes;
}

function fence(artifact: ArtifactResolved, expected: WriteFence): void {
  if (
    (expected.expectedContentId !== undefined &&
      expected.expectedContentId !== artifact.contentId) ||
    (expected.expectedUpdatedAt !== undefined &&
      expected.expectedUpdatedAt.getTime() !==
        artifact.content?.updatedAt.getTime())
  ) {
    throw new StaleContentError(artifact.id, {
      contentId: artifact.contentId,
      updatedAt: artifact.content?.updatedAt ?? null,
    });
  }
}

type StructuralInput = Exclude<EntryInput, { readonly type?: "file" }>;

function isStructural(entry: EntryInput): entry is StructuralInput {
  return entry.type !== undefined && entry.type !== "file";
}

function structuralNode(
  entry: StructuralInput
): Exclude<StorageNode, { readonly type: "file" }> {
  return entry.type === "symlink"
    ? { target: entry.target, type: "symlink" }
    : { type: entry.type };
}

function storedFile(blob: Blob, mime: string | null | undefined): StoredFile {
  return {
    blobId: blob.id,
    bytes: blob.byteLength,
    digest: blob.digest,
    mime: mime ?? null,
    type: "file",
  };
}

function nextTime(row: Content): Date {
  return new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1));
}

function nonEmpty(field: string, value: string): void {
  if (!value.trim()) {
    throw new InvalidArtifactInputError(field, "must not be empty");
  }
}
