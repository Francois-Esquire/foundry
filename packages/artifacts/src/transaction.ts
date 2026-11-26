import type { Page } from "@foundry/core/pagination";
import type { StorageNode } from "@foundry/core/storage";

import { isStoragePath, withParentDirectories } from "@foundry/core/storage";
import { canonicalizeJson } from "@foundry/lib/json";
import type { BlobEffects } from "./blob-repository";
import { BlobRepository } from "./blob-repository";
import type { BlobFiles, ByteInput, Ownership } from "./blob-staging";
import { BlobStaging, isReferenceInput } from "./blob-staging";
import type { ArtifactChange, EventInput } from "./change";
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
  ContentNotFoundError,
  ContentStateError,
  DuplicateTagError,
  FileTooLargeError,
  InvalidArtifactInputError,
  StaleContentError,
} from "./errors";
import type { ArtifactId, BlobId, ContentId } from "./ids";
import { artifactIdSchema, contentIdSchema } from "./ids";
import type { ArtifactCursor } from "./listing";
import type { Blob, ContentMetadata, ContentTree, StoredFile } from "./schema";
import type {
  Artifact,
  ArtifactOperations,
  ArtifactResolved,
  Content,
  ContentResolved,
  ContentSummary,
  CreateArtifactInput,
  EntryInput,
  EntryInputs,
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

export interface OperationEffects extends BlobEffects {
  readonly changed: Set<ArtifactId>;
}

export function operationEffects(): OperationEffects {
  return {
    changed: new Set(),
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

export interface LocatedFile {
  readonly blob: Blob;
  readonly entry: StoredFile;
  readonly path: string;
}

const WRITING_OPERATIONS = [
  "archive",
  "clearFailedContent",
  "create",
  "delete",
  "deleteContent",
  "fork",
  "freeze",
  "patchArtifactMetadata",
  "rename",
  "revise",
  "select",
  "setMetadata",
  "sweep",
  "tag",
  "unarchive",
  "write",
] as const satisfies readonly (keyof ArtifactOperations)[];

export class ArtifactTransaction implements ArtifactOperations {
  static {
    for (const name of WRITING_OPERATIONS) {
      const operation: unknown = Reflect.get(
        ArtifactTransaction.prototype,
        name
      );
      if (typeof operation !== "function") {
        throw new Error(`ArtifactTransaction has no operation ${name}`);
      }
      Object.defineProperty(ArtifactTransaction.prototype, name, {
        configurable: true,
        value(this: ArtifactTransaction, ...args: unknown[]) {
          return this.#change.operation((scoped) =>
            Reflect.apply(operation, this.#fork(scoped), args)
          );
        },
        writable: true,
      });
    }
  }

  readonly #change: ArtifactChange;
  readonly #effects: OperationEffects;
  readonly #blobs: BlobRepository;
  readonly #limits: TransactionLimits;
  readonly #maxTreeBytes: number;
  readonly #staging: BlobStaging;

  constructor(
    change: ArtifactChange,
    effects: OperationEffects,
    limits: TransactionLimits,
    staging: BlobStaging = new BlobStaging(limits)
  ) {
    this.#change = change;
    this.#effects = effects;
    this.#blobs = new BlobRepository(change, effects, { ...limits, staging });
    this.#limits = limits;
    this.#maxTreeBytes = limits.maxTreeBytes;
    this.#staging = staging;
  }

  #fork(change: ArtifactChange): ArtifactTransaction {
    return new ArtifactTransaction(
      change,
      this.#effects,
      this.#limits,
      this.#staging
    );
  }

  async checkCreate(input: CreateArtifactInput): Promise<void> {
    nonEmpty("name", input.name);
    nonEmpty("type", input.type);
    if (input.id !== undefined && (await this.#change.getArtifact(input.id))) {
      throw new ArtifactExistsError(input.id);
    }
    assertStoragePaths({ put: input.entries ?? {} });
    await this.#checkReferences(input.entries);
  }

  async checkWrite(input: WriteInput): Promise<ArtifactResolved> {
    const artifact = await this.#requireArtifact(input.artifactId);
    fence(artifact, input);
    const active = artifact.content;
    if (active && active.state !== "ready") {
      throw new ContentStateError(active.id, active.state, "write");
    }
    assertStoragePaths(input.changes);
    await this.#checkReferences(input.changes.put);
    await this.#checkOwnership(artifact, input.changes.put);
    return artifact;
  }

  async checkRevise(input: ReviseInput): Promise<{
    readonly artifact: ArtifactResolved;
    readonly source: Content;
  }> {
    const artifact = await this.#requireArtifact(input.artifactId);
    const source = await this.#requireOwnContent(artifact, input.contentId);
    fence(artifact, {
      expectedContentId: input.contentId,
      expectedUpdatedAt: input.expectedUpdatedAt,
    });
    if (!isUsableContent(source)) {
      throw new ContentStateError(source.id, source.state, "revise");
    }
    assertStoragePaths(input.changes ?? {});
    await this.#checkReferences(input.changes?.put);
    return { artifact, source };
  }

  async #checkOwnership(
    artifact: ArtifactResolved,
    entries: EntryInputs | undefined
  ): Promise<void> {
    const active = artifact.content;
    for (const [path, entry] of Object.entries(entries ?? {})) {
      if (isStructural(entry) || isReferenceInput(entry)) {
        continue;
      }
      const previous =
        active && Object.hasOwn(active.tree, path)
          ? active.tree[path]
          : undefined;
      const now: Ownership | null =
        active && previous?.type === "file"
          ? {
              blobId: previous.blobId,
              exclusive: !(await this.#change.isBlobReferenced(
                previous.blobId,
                { contentId: active.id, path }
              )),
            }
          : null;
      const key = `${artifact.id}\u0000${path}`;
      if (this.#change.readOnly) {
        this.#staging.recordOwnership(key, now);
      } else if (!this.#staging.confirmOwnership(key, now)) {
        throw new StaleContentError(artifact.id, {
          contentId: artifact.contentId,
          updatedAt: active?.updatedAt ?? null,
        });
      }
    }
  }

  async #checkReferences(entries: EntryInputs | undefined): Promise<void> {
    for (const [path, entry] of Object.entries(entries ?? {})) {
      if (!isStructural(entry) && isReferenceInput(entry)) {
        await this.#blobs.resolve(path, entry);
      }
    }
  }

  async create(input: CreateArtifactInput): Promise<ArtifactResolved> {
    const id = await this.#file(input);
    this.#change.record({ artifactId: id, type: "artifact.created" });
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
    const artifact = await this.#change.getArtifact(id);
    return artifact && this.#resolveArtifact(artifact);
  }

  async list(
    input: ListArtifactsInput = {}
  ): Promise<Page<ArtifactResolved, ArtifactCursor>> {
    const page = await this.#change.listArtifacts(input);
    return {
      ...page,
      items: await Promise.all(
        page.items.map((row) => this.#resolveArtifact(row))
      ),
    };
  }

  rename(id: ArtifactId, name: string): Promise<Artifact> {
    nonEmpty("name", name);
    return this.#updateArtifact(
      id,
      () => ({ name }),
      () => ({ artifactId: id, name, type: "artifact.renamed" })
    );
  }

  patchArtifactMetadata(
    id: ArtifactId,
    patch: Readonly<Record<string, unknown>>
  ): Promise<Artifact> {
    return this.#updateArtifact(
      id,
      (row) => ({ metadata: mergeMetadata(row.metadata, patch) }),
      () => ({ artifactId: id, contentId: null, type: "artifact.updated" })
    );
  }

  archive(id: ArtifactId): Promise<Artifact> {
    return this.#updateArtifact(
      id,
      (row) => ({
        archivedAt: row.archivedAt ?? new Date(),
        status: "archived",
      }),
      () => ({ artifactId: id, type: "artifact.archived" })
    );
  }

  unarchive(id: ArtifactId): Promise<Artifact> {
    return this.#updateArtifact(
      id,
      (row) => ({
        archivedAt: null,
        status: row.publishedAt ? "published" : "draft",
      }),
      () => ({ artifactId: id, type: "artifact.unarchived" })
    );
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
    this.#change.record({
      artifactId: artifact.id,
      contentId: content.id,
      type: "artifact.cleared",
    });
    return this.#requireArtifact(artifact.id);
  }

  async delete(id: ArtifactId): Promise<boolean> {
    const artifact = await this.#change.getArtifact(id);
    if (!artifact) {
      return false;
    }
    await this.#point(id, null);
    for (const content of await this.#change.listContents(id)) {
      this.#releaseTree(content.tree);
    }
    await this.#change.deleteArtifact(id);
    this.#change.record({
      artifactId: id,
      artifactType: artifact.type,
      name: artifact.name,
      type: "artifact.removed",
    });
    return true;
  }

  async write(input: WriteInput): Promise<ContentResolved> {
    const artifact = await this.checkWrite(input);
    const active = artifact.content;
    const writes = this.#change.operationWrites();
    const tree = await this.#applyChanges(
      active?.tree ?? {},
      input.changes,
      active?.id
    );
    const metadata = mergeMetadata(active?.metadata ?? {}, input.metadata);
    if (
      active &&
      this.#change.operationWrites() === writes &&
      sameJson(active.tree, tree) &&
      sameJson(active.metadata, metadata)
    ) {
      if (input.freeze) {
        await this.freeze(active.id, input.freeze);
      }
      return this.#resolvedContent(active.id);
    }
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
      await this.#change.putContent(content);
      this.#releaseTree(active.tree);
    } else {
      content = await this.#insert(artifact.id, tree, metadata);
    }
    await this.#point(artifact.id, content.id);
    this.#change.record({
      artifactId: artifact.id,
      contentId: content.id,
      type: "artifact.written",
    });
    if (input.freeze) {
      await this.freeze(content.id, input.freeze);
    }
    return this.#resolvedContent(content.id);
  }

  async revise(input: ReviseInput): Promise<ContentResolved> {
    const { artifact, source } = await this.checkRevise(input);
    if (source.state === "ready") {
      await this.#markFrozen(source);
    }
    const content = await this.#insert(
      artifact.id,
      await this.#applyChanges(source.tree, input.changes ?? {}),
      mergeMetadata(successorMetadata(source), input.metadata)
    );
    await this.#point(artifact.id, content.id);
    this.#change.record({
      artifactId: artifact.id,
      contentId: content.id,
      sourceContentId: source.id,
      type: "artifact.revised",
    });
    return this.#resolvedContent(content.id);
  }

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
    await this.#updateArtifact(
      row.artifactId,
      (artifact) => ({
        publishedAt: artifact.publishedAt ?? frozen.updatedAt,
        status: artifact.status === "draft" ? "published" : artifact.status,
      }),
      () => ({
        artifactId: row.artifactId,
        contentId: id,
        type: "artifact.published",
      })
    );
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
      this.#change.record({
        artifactId: artifact.id,
        contentId: target.id,
        type: "artifact.selected",
      });
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
    const id = await this.#file({
      id: input.id,
      name: input.name ?? original.name,
      type: original.type,
    });
    const content = await this.#insert(
      id,
      source.tree,
      successorMetadata(source)
    );
    await this.#point(id, content.id);
    this.#change.record({
      artifactId: id,
      contentId: content.id,
      sourceArtifactId: original.id,
      sourceContentId: source.id,
      type: "artifact.forked",
    });
    return this.#requireArtifact(id);
  }

  async tag(id: ContentId, tag: string | null): Promise<Content> {
    const row = await this.#requireContent(id);
    if (tag !== null) {
      await this.#assertTagFree(row, tag);
    }
    if (row.tag === tag) {
      return row;
    }
    const content = { ...row, tag };
    await this.#change.putContent(content);
    this.#effects.changed.add(row.artifactId);
    this.#change.record({
      artifactId: row.artifactId,
      contentId: id,
      tag,
      type: "artifact.tagged",
    });
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
    if (sameJson(row.metadata, metadata)) {
      return row;
    }
    const content = { ...row, metadata, updatedAt: nextTime(row) };
    await this.#change.putContent(content);
    this.#effects.changed.add(row.artifactId);
    this.#change.record({
      artifactId: row.artifactId,
      contentId: id,
      type: "artifact.updated",
    });
    return content;
  }

  async getContent(id: ContentId): Promise<ContentResolved | null> {
    const content = await this.#change.getContent(id);
    if (!content) {
      return null;
    }
    const artifact = await this.#change.getArtifact(content.artifactId);
    if (!artifact) {
      throw new ArtifactNotFoundError(content.artifactId);
    }
    return { ...content, artifact };
  }

  async listContents(
    id: ArtifactId,
    input: ListContentsInput = {}
  ): Promise<readonly ContentSummary[]> {
    return (await this.#change.listContents(id, input)).map(
      ({ tree: _tree, ...content }) => content
    );
  }

  async findContent(
    id: ArtifactId,
    by: { readonly sessionId: string; readonly messageId: string }
  ): Promise<Content | null> {
    return (
      [...(await this.#change.listContents(id))]
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
    await this.#change.deleteContent(row.id);
    this.#releaseTree(row.tree);
    this.#effects.changed.add(row.artifactId);
    this.#change.record({
      artifactId: row.artifactId,
      contentId: row.id,
      type: "artifact.discarded",
    });
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
    for (const content of await this.#change.listContents()) {
      if (
        (content.state !== "ready" && content.state !== "failed") ||
        content.updatedAt >= input.olderThan
      ) {
        continue;
      }
      const artifact = await this.#change.getArtifact(content.artifactId);
      if (artifact?.contentId === content.id) {
        continue;
      }
      await this.#change.deleteContent(content.id);
      contents += 1;
      this.#effects.changed.add(content.artifactId);
      this.#change.record({
        artifactId: content.artifactId,
        contentId: content.id,
        type: "artifact.discarded",
      });
    }
    return { blobs: await this.#blobs.reclaimAll(), contents };
  }

  async locateFile(id: ContentId, path: string): Promise<LocatedFile | null> {
    return this.#locate(await this.#requireContent(id), path);
  }

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

  async #applyChanges(
    base: ContentTree,
    changes: TreeChanges,
    owner?: ContentId
  ): Promise<ContentTree> {
    assertStoragePaths(changes);
    const removed = changes.remove ?? [];
    const puts = Object.entries(changes.put ?? {});
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
    const shared = await this.#change.isBlobReferenced(previous.blobId, {
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
    await this.#change.putContent(content);
    return content;
  }

  async #markFrozen(row: Content): Promise<Content> {
    const now = nextTime(row);
    const content: Content = {
      ...row,
      frozenAt: now,
      state: "frozen",
      updatedAt: now,
    };
    await this.#change.putContent(content);
    this.#effects.changed.add(row.artifactId);
    this.#change.record({
      artifactId: row.artifactId,
      contentId: row.id,
      type: "artifact.frozen",
    });
    return content;
  }

  async #file(input: CreateArtifactInput): Promise<ArtifactId> {
    await this.checkCreate(input);
    const id = input.id ?? artifactIdSchema.parse(crypto.randomUUID());
    const now = new Date();
    await this.#change.putArtifact({
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
    return id;
  }

  async #updateArtifact(
    id: ArtifactId,
    update: (artifact: Artifact) => Partial<Artifact>,
    event: () => EventInput | undefined = () => undefined,
    touches = false
  ): Promise<Artifact> {
    const previous = await this.#change.getArtifact(id);
    if (!previous) {
      throw new ArtifactNotFoundError(id);
    }
    const updated = { ...previous, ...update(previous) };
    assertJsonMetadata(updated.metadata);
    if (!touches && sameArtifact(previous, updated)) {
      return previous;
    }
    const artifact = { ...updated, updatedAt: new Date() };
    await this.#change.putArtifact(artifact);
    this.#effects.changed.add(id);
    const made = event();
    if (made !== undefined) {
      this.#change.record(made);
    }
    return artifact;
  }

  async #point(id: ArtifactId, contentId: ContentId | null): Promise<void> {
    await this.#updateArtifact(id, () => ({ contentId }), undefined, true);
  }

  async #assertTagFree(row: Content, tag: string): Promise<void> {
    nonEmpty("tag", tag);
    if (
      (await this.#change.listContents(row.artifactId)).some(
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
    const content = await this.#change.getContent(id);
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

function assertStoragePaths(changes: TreeChanges): void {
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

function sameArtifact(left: Artifact, right: Artifact): boolean {
  return (
    left.name === right.name &&
    left.type === right.type &&
    left.status === right.status &&
    left.contentId === right.contentId &&
    left.createdAt.getTime() === right.createdAt.getTime() &&
    left.archivedAt?.getTime() === right.archivedAt?.getTime() &&
    left.publishedAt?.getTime() === right.publishedAt?.getTime() &&
    sameJson(left.metadata, right.metadata)
  );
}

function sameJson(left: Readonly<object>, right: Readonly<object>): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function nextTime(row: Content): Date {
  return new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1));
}

function nonEmpty(field: string, value: string): void {
  if (!value.trim()) {
    throw new InvalidArtifactInputError(field, "must not be empty");
  }
}
