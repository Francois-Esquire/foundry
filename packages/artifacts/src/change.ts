import type { Page } from "@foundry/core/pagination";
import { collectPages, pageFromRows, pageLimit } from "@foundry/lib/pagination";
import type { ArtifactId, BlobId, ContentId } from "./ids";
import type { ArtifactCursor, ArtifactFilter } from "./listing";
import {
  artifactCursor,
  compareCreated,
  isAfterCursor,
  matchesArtifactFilter,
  normalizeArtifactQuery,
} from "./listing";
import type { ArtifactEvent, Blob } from "./schema";
import { validateBlob } from "./schema";
import type {
  ArtifactStore,
  ArtifactStoreWrite,
  BlobListing,
  ContentLookup,
  ContentPageQuery,
} from "./store";
import type {
  Artifact,
  Content,
  ListArtifactsInput,
  ListContentsInput,
} from "./substrate";

export type EventInput = ArtifactEvent extends infer Event
  ? Event extends ArtifactEvent
    ? Omit<Event, "at" | "id">
    : never
  : never;

type Pending<Id, Row> = Map<Id, Row | null>;

interface ChangeState {
  active: boolean;
  readonly artifactContentPreconditions: Map<ArtifactId, ContentId | null>;
  readonly artifacts: Pending<ArtifactId, Artifact>;
  readonly blobs: Pending<BlobId, Blob>;
  readonly clock: () => Date;
  readonly contents: Pending<ContentId, Content>;
  readonly contentUpdatedAtPreconditions: Map<ContentId, Date>;
  readonly events: ArtifactEvent[];
  failure: { readonly error: unknown } | undefined;
  readonly id: () => string;
  readonly readOnly: boolean;
  readonly store: ArtifactStore;
}

export interface ArtifactChangeOptions {
  readonly clock?: () => Date;
  readonly id?: () => string;
  readonly readOnly?: boolean;
}

export class ArtifactChange {
  readonly readOnly: boolean;
  readonly #state: ChangeState;
  readonly #parent: ArtifactChange | undefined;
  #writes = 0;

  private constructor(state: ChangeState, parent?: ArtifactChange) {
    this.#state = state;
    this.#parent = parent;
    this.readOnly = state.readOnly;
  }

  static begin(
    store: ArtifactStore,
    options: ArtifactChangeOptions = {}
  ): ArtifactChange {
    return new ArtifactChange({
      active: true,
      artifactContentPreconditions: new Map(),
      artifacts: new Map(),
      blobs: new Map(),
      clock: options.clock ?? (() => new Date()),
      contents: new Map(),
      contentUpdatedAtPreconditions: new Map(),
      events: [],
      failure: undefined,
      id: options.id ?? (() => crypto.randomUUID()),
      readOnly: options.readOnly ?? false,
      store,
    });
  }

  async operation<T>(work: (change: ArtifactChange) => Promise<T>): Promise<T> {
    const scoped = new ArtifactChange(this.#state, this);
    try {
      return await work(scoped);
    } catch (error) {
      if (scoped.#writes > 0) {
        this.fail(error);
      }
      throw error;
    }
  }

  operationWrites(): number {
    return this.#writes;
  }

  get failure(): { readonly error: unknown } | undefined {
    return this.#state.failure;
  }

  fail(error: unknown): void {
    this.#state.failure ??= { error };
  }

  #wrote(): void {
    this.#writes += 1;
    if (this.#parent !== undefined) {
      this.#parent.#wrote();
    }
  }

  settle(): void {
    this.#state.active = false;
  }

  assertWritable(): void {
    this.#assertActive();
    if (this.readOnly) {
      throw new Error("Artifact transaction is read-only");
    }
  }

  expectArtifactContent(
    artifactId: ArtifactId,
    contentId: ContentId | null
  ): void {
    if (
      !(
        this.#state.artifacts.has(artifactId) ||
        this.#state.artifactContentPreconditions.has(artifactId)
      )
    ) {
      this.#state.artifactContentPreconditions.set(artifactId, contentId);
    }
  }

  expectContentUpdatedAt(contentId: ContentId, updatedAt: Date): void {
    if (
      !(
        this.#state.contents.has(contentId) ||
        this.#state.contentUpdatedAtPreconditions.has(contentId)
      )
    ) {
      this.#state.contentUpdatedAtPreconditions.set(
        contentId,
        new Date(updatedAt.getTime())
      );
    }
  }

  write(): ArtifactStoreWrite | undefined {
    if (
      this.#state.artifacts.size === 0 &&
      this.#state.blobs.size === 0 &&
      this.#state.contents.size === 0 &&
      this.#state.events.length === 0
    ) {
      return;
    }
    const hasArtifactPre = this.#state.artifactContentPreconditions.size > 0;
    const hasContentPre = this.#state.contentUpdatedAtPreconditions.size > 0;
    const preconditions =
      hasArtifactPre || hasContentPre
        ? {
            ...(hasArtifactPre
              ? {
                  artifactContentIds: Object.fromEntries(
                    this.#state.artifactContentPreconditions
                  ) as Readonly<Record<ArtifactId, ContentId | null>>,
                }
              : {}),
            ...(hasContentPre
              ? {
                  contentUpdatedAt: Object.fromEntries(
                    this.#state.contentUpdatedAtPreconditions
                  ) as Readonly<Record<ContentId, Date>>,
                }
              : {}),
          }
        : undefined;
    return {
      deleteArtifacts: deleted(this.#state.artifacts),
      deleteBlobs: deleted(this.#state.blobs),
      deleteContents: deleted(this.#state.contents),
      ...(this.#state.events.length === 0
        ? {}
        : { events: [...this.#state.events] }),
      ...(preconditions === undefined ? {} : { preconditions }),
      putArtifacts: kept(this.#state.artifacts),
      putBlobs: kept(this.#state.blobs),
      putContents: kept(this.#state.contents),
    };
  }

  record(event: EventInput): void {
    this.assertWritable();
    this.#state.events.push({
      ...event,
      at: this.#state.clock().toISOString(),
      id: this.#state.id(),
    } as ArtifactEvent);
    this.#wrote();
  }

  getArtifact(id: ArtifactId): Promise<Artifact | null> {
    return this.#get(this.#state.artifacts, id, () =>
      this.#state.store.getArtifact(id)
    );
  }

  async listArtifacts(
    input: ListArtifactsInput
  ): Promise<Page<Artifact, ArtifactCursor>> {
    this.#assertActive();
    const limit = pageLimit(input.limit);
    const text = normalizeArtifactQuery(input.query);
    const filter: ArtifactFilter = {
      ...(input.includeArchived === undefined
        ? {}
        : { includeArchived: input.includeArchived }),
      ...(text === undefined ? {} : { text }),
      ...(input.type === undefined ? {} : { type: input.type }),
    };
    const touched = [...this.#state.artifacts.keys()];
    const stored = await this.#state.store.listArtifacts({
      ...filter,
      ...(input.cursor === undefined ? {} : { after: input.cursor }),
      limit: limit + 1 + touched.length,
    });
    if (touched.length === 0) {
      return pageFromRows(
        stored.artifacts,
        limit,
        stored.total,
        artifactCursor
      );
    }
    const pending = kept(this.#state.artifacts).filter((artifact) =>
      matchesArtifactFilter(artifact, filter)
    );
    let total: number | undefined;
    if (stored.total !== undefined) {
      total = stored.total + pending.length;
      for (const id of touched) {
        const before = await this.#state.store.getArtifact(id);
        if (before && matchesArtifactFilter(before, filter)) {
          total -= 1;
        }
      }
    }
    const rows = [
      ...stored.artifacts.filter(
        (artifact) => !this.#state.artifacts.has(artifact.id)
      ),
      ...pending
        .filter((artifact) => isAfterCursor(artifact, input.cursor))
        .map((artifact) => structuredClone(artifact)),
    ]
      .sort(compareCreated)
      .slice(0, limit + 1);
    return pageFromRows(rows, limit, total, artifactCursor);
  }

  async putArtifact(artifact: Artifact): Promise<void> {
    this.assertWritable();
    if (
      artifact.contentId !== null &&
      (await this.getContent(artifact.contentId))?.artifactId !== artifact.id
    ) {
      throw new Error("Artifact pointer must name its own Content");
    }
    this.#state.artifacts.set(artifact.id, structuredClone(artifact));
    this.#wrote();
  }

  async deleteArtifact(id: ArtifactId): Promise<void> {
    this.assertWritable();
    for (const content of await this.listContents(id)) {
      this.#state.contents.set(content.id, null);
    }
    this.#state.artifacts.set(id, null);
    this.#wrote();
  }

  getContent(id: ContentId): Promise<Content | null> {
    return this.#get(this.#state.contents, id, () =>
      this.#state.store.getContent(id)
    );
  }

  async listContents(
    artifactId?: ArtifactId,
    input: ListContentsInput = {}
  ): Promise<readonly Content[]> {
    this.#assertActive();
    const states =
      typeof input.state === "string" ? [input.state] : input.state;
    return merged(
      await this.#storedContents(artifactId, input),
      this.#state.contents
    )
      .filter(
        (row) =>
          (artifactId === undefined || row.artifactId === artifactId) &&
          (states === undefined || states.includes(row.state)) &&
          (input.tagged === undefined || (row.tag !== null) === input.tagged)
      )
      .sort(compareCreated);
  }

  async listContentsPage(
    query: ContentPageQuery = {}
  ): Promise<Page<Content, ContentId>> {
    this.#assertActive();
    const limit = pageLimit(query.limit);
    const paged = this.#state.store.listContentsPage;
    if (paged !== undefined) {
      const baseQuery = buildContentPageQuery(query, limit);
      if (this.#state.contents.size === 0) {
        return paged.call(this.#state.store, baseQuery);
      }
      const stored = await paged.call(this.#state.store, {
        ...baseQuery,
        limit: limit + 1 + this.#state.contents.size,
      });
      const rows = filterContentPageRows(
        merged(stored.items, this.#state.contents),
        query,
        limit
      );
      return pageFromRows(rows, limit, undefined, (content) => content.id);
    }
    const all = await this.listContents(query.artifactId, {
      ...(query.state === undefined ? {} : { state: query.state }),
      ...(query.tagged === undefined ? {} : { tagged: query.tagged }),
    });
    const rows = filterContentPageRows(all, query, limit);
    return pageFromRows(rows, limit, undefined, (content) => content.id);
  }

  async findContent(
    artifactId: ArtifactId,
    by: ContentLookup
  ): Promise<Content | null> {
    this.#assertActive();
    const lookup = this.#state.store.findContent;
    if (lookup === undefined) {
      return (
        [...(await this.listContents(artifactId))]
          .reverse()
          .find(
            (row) =>
              row.metadata.sessionId === by.sessionId &&
              row.metadata.messageId === by.messageId
          ) ?? null
      );
    }
    const stored = await lookup.call(this.#state.store, artifactId, by);
    if (stored !== null && this.#state.contents.has(stored.id)) {
      return (
        [...(await this.listContents(artifactId))]
          .reverse()
          .find(
            (row) =>
              row.metadata.sessionId === by.sessionId &&
              row.metadata.messageId === by.messageId
          ) ?? null
      );
    }
    const candidates: Content[] = stored === null ? [] : [stored];
    for (const pending of this.#state.contents.values()) {
      if (
        pending !== null &&
        pending.artifactId === artifactId &&
        pending.metadata.sessionId === by.sessionId &&
        pending.metadata.messageId === by.messageId
      ) {
        candidates.push(structuredClone(pending));
      }
    }
    return candidates.sort(compareCreated).at(-1) ?? null;
  }

  async findContentByTag(
    artifactId: ArtifactId,
    tag: string,
    excludeId?: ContentId
  ): Promise<Content | null> {
    this.#assertActive();
    for (const pending of this.#state.contents.values()) {
      if (
        pending !== null &&
        pending.artifactId === artifactId &&
        pending.tag === tag &&
        pending.id !== excludeId
      ) {
        return structuredClone(pending);
      }
    }
    const lookup = this.#state.store.findContentByTag;
    if (lookup !== undefined) {
      const stored = await lookup.call(this.#state.store, artifactId, tag);
      if (stored === null) {
        return null;
      }
      if (stored.id !== excludeId && !this.#state.contents.has(stored.id)) {
        return stored;
      }
    }
    return (
      (await this.listContents(artifactId, { tagged: true })).find(
        (other) => other.id !== excludeId && other.tag === tag
      ) ?? null
    );
  }

  async putContent(content: Content): Promise<void> {
    this.assertWritable();
    if (!(await this.getArtifact(content.artifactId))) {
      throw new Error("Content requires an Artifact");
    }
    this.#state.contents.set(content.id, structuredClone(content));
    this.#wrote();
  }

  async deleteContent(id: ContentId): Promise<void> {
    this.assertWritable();
    const content = await this.getContent(id);
    if (
      content &&
      (await this.getArtifact(content.artifactId))?.contentId === id
    ) {
      throw new Error("Cannot delete active Content");
    }
    this.#state.contents.set(id, null);
    this.#wrote();
  }

  getBlob(id: BlobId): Promise<Blob | null> {
    return this.#get(this.#state.blobs, id, () =>
      this.#state.store.getBlob(id)
    );
  }

  async findBlob(digest: string): Promise<Blob | null> {
    this.#assertActive();
    const stored = (await this.#state.store.findBlobs(digest)).find(
      (blob) => !this.#state.blobs.has(blob.id)
    );
    if (stored) {
      return stored;
    }
    const pending = [...this.#state.blobs.values()].find(
      (blob) => blob?.digest === digest
    );
    return pending ? structuredClone(pending) : null;
  }

  async findBlobByPath(path: string): Promise<Blob | null> {
    this.#assertActive();
    const pending = [...this.#state.blobs.values()].find(
      (blob) => blob?.path === path
    );
    if (pending) {
      return structuredClone(pending);
    }
    if (this.#state.store.findBlobByPath !== undefined) {
      const stored = await this.#state.store.findBlobByPath(path);
      return stored && !this.#state.blobs.has(stored.id) ? stored : null;
    }
    const listed = (await this.#storedBlobs()).find(
      (blob) => blob.path === path && !this.#state.blobs.has(blob.id)
    );
    return listed ? this.#state.store.getBlob(listed.id) : null;
  }

  async listBlobs(): Promise<readonly BlobListing[]> {
    this.#assertActive();
    const listed: BlobListing[] = (await this.#storedBlobs()).filter(
      (blob) => !this.#state.blobs.has(blob.id)
    );
    for (const blob of this.#state.blobs.values()) {
      if (blob) {
        listed.push({
          id: blob.id,
          ...(blob.path === undefined ? {} : { path: blob.path }),
        });
      }
    }
    return listed;
  }

  #storedBlobs(): Promise<readonly BlobListing[]> {
    const paged = this.#state.store.listBlobsPage;
    if (paged === undefined) {
      return this.#state.store.listBlobs();
    }
    return collectPages<BlobListing, BlobId>((cursor) =>
      paged.call(this.#state.store, cursor === undefined ? {} : { cursor })
    );
  }

  #storedContents(
    artifactId: ArtifactId | undefined,
    input: ListContentsInput
  ): Promise<readonly Content[]> {
    const paged = this.#state.store.listContentsPage;
    if (paged === undefined) {
      return this.#state.store.listContents(artifactId);
    }
    return collectPages<Content, ContentId>((cursor) =>
      paged.call(this.#state.store, {
        ...(artifactId === undefined ? {} : { artifactId }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(input.tagged === undefined ? {} : { tagged: input.tagged }),
      })
    );
  }

  async isBlobReferenced(
    id: BlobId,
    except?: { readonly contentId: ContentId; readonly path: string }
  ): Promise<boolean> {
    this.#assertActive();
    const skipped = (contentId: ContentId) =>
      except?.contentId === contentId ? except.path : undefined;
    const stored = await this.#state.store.findReferences(id);
    if (stored.blobIds.some((blobId) => !this.#state.blobs.has(blobId))) {
      return true;
    }
    for (const contentId of stored.contentIds) {
      if (this.#state.contents.has(contentId)) {
        continue;
      }
      if (skipped(contentId) === undefined) {
        return true;
      }
      const content = await this.#state.store.getContent(contentId);
      if (content && namesBlob(content, id, skipped(contentId))) {
        return true;
      }
    }
    for (const content of this.#state.contents.values()) {
      if (content && namesBlob(content, id, skipped(content.id))) {
        return true;
      }
    }
    return [...this.#state.blobs.values()].some((blob) =>
      blob?.chunks?.includes(id)
    );
  }

  async putBlob(blob: Blob): Promise<void> {
    this.assertWritable();
    validateBlob(blob);
    if (blob.path !== undefined) {
      const conflict = await this.#pathConflict(blob.id, blob.path);
      if (conflict) {
        throw new Error("Blob backing path already belongs to another blob");
      }
    }
    this.#state.blobs.set(blob.id, structuredClone(blob));
    this.#wrote();
  }

  async #pathConflict(id: BlobId, path: string): Promise<boolean> {
    for (const other of this.#state.blobs.values()) {
      if (other !== null && other.id !== id && other.path === path) {
        return true;
      }
    }
    if (this.#state.store.findBlobByPath !== undefined) {
      const stored = await this.#state.store.findBlobByPath(path);
      return (
        stored !== null && stored.id !== id && !this.#state.blobs.has(stored.id)
      );
    }
    return (await this.listBlobs()).some(
      (other) => other.id !== id && other.path === path
    );
  }

  deleteBlob(id: BlobId): Promise<void> {
    this.assertWritable();
    this.#state.blobs.set(id, null);
    this.#wrote();
    return Promise.resolve();
  }

  async #get<Id, Row>(
    pending: Pending<Id, Row>,
    id: Id,
    stored: () => Promise<Row | null>
  ): Promise<Row | null> {
    this.#assertActive();
    if (!pending.has(id)) {
      return stored();
    }
    return structuredClone(pending.get(id) ?? null);
  }

  #assertActive(): void {
    if (!this.#state.active) {
      throw new Error("Artifact transaction has settled");
    }
  }
}

function merged<Id, Row extends { readonly id: Id }>(
  stored: readonly Row[],
  pending: Pending<Id, Row>
): Row[] {
  return [
    ...stored.filter((row) => !pending.has(row.id)),
    ...kept(pending).map((row) => structuredClone(row)),
  ];
}

function kept<Id, Row>(pending: Pending<Id, Row>): Row[] {
  return [...pending.values()].filter((row) => row !== null);
}

function deleted<Id, Row>(pending: Pending<Id, Row>): Id[] {
  return [...pending].flatMap(([id, row]) => (row === null ? [id] : []));
}

function compareContentId(a: Content, b: Content): number {
  if (a.id < b.id) {
    return -1;
  }
  return a.id > b.id ? 1 : 0;
}

function buildContentPageQuery(
  query: ContentPageQuery,
  limit: number
): ContentPageQuery {
  return {
    ...(query.artifactId === undefined ? {} : { artifactId: query.artifactId }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    limit,
    ...(query.state === undefined ? {} : { state: query.state }),
    ...(query.tagged === undefined ? {} : { tagged: query.tagged }),
  };
}

function filterContentPageRows(
  rows: readonly Content[],
  query: ContentPageQuery,
  limit: number
): Content[] {
  const states = typeof query.state === "string" ? [query.state] : query.state;
  return rows
    .filter(
      (row) =>
        (query.artifactId === undefined ||
          row.artifactId === query.artifactId) &&
        (states === undefined || states.includes(row.state)) &&
        (query.tagged === undefined || (row.tag !== null) === query.tagged) &&
        (query.cursor === undefined || row.id > query.cursor)
    )
    .sort(compareContentId)
    .slice(0, limit + 1);
}

function namesBlob(content: Content, id: BlobId, skip?: string): boolean {
  return Object.entries(content.tree).some(
    ([path, node]) =>
      node.type === "file" && node.blobId === id && path !== skip
  );
}
