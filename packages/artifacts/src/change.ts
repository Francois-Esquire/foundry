import type { Page } from "@foundry/core/pagination";
import { pageFromRows, pageLimit } from "@foundry/lib/pagination";

import type { Blob } from "./blob";
import { validateBlob } from "./blob";
import type { ArtifactCursor, ArtifactFilter } from "./listing";
import {
  artifactCursor,
  compareCreated,
  isAfterCursor,
  matchesArtifactFilter,
  normalizeArtifactQuery,
} from "./listing";
import type { ArtifactId, BlobId, ContentId } from "./ref";
import type { ArtifactEvent } from "./schema";
import type { ArtifactStore, ArtifactStoreWrite, BlobListing } from "./store";
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
  readonly artifacts: Pending<ArtifactId, Artifact>;
  readonly blobs: Pending<BlobId, Blob>;
  readonly contents: Pending<ContentId, Content>;
  readonly events: ArtifactEvent[];
  failure: { readonly error: unknown } | undefined;
  readonly readOnly: boolean;
  readonly store: ArtifactStore;
}

const SCOPED = Symbol("ArtifactChange.scoped");

interface ScopedInit {
  readonly parent: ArtifactChange;
  readonly state: ChangeState;
  readonly [SCOPED]: true;
}

function isScopedInit(value: unknown): value is ScopedInit {
  return typeof value === "object" && value !== null && SCOPED in value;
}

export class ArtifactChange {
  readonly readOnly: boolean;
  readonly #state: ChangeState;
  readonly #parent: ArtifactChange | undefined;
  #writes = 0;

  constructor(
    store: ArtifactStore,
    options: { readonly readOnly?: boolean } = {}
  ) {
    if (isScopedInit(store)) {
      this.#state = store.state;
      this.#parent = store.parent;
    } else {
      this.#state = {
        active: true,
        artifacts: new Map(),
        blobs: new Map(),
        contents: new Map(),
        events: [],
        failure: undefined,
        readOnly: options.readOnly ?? false,
        store,
      };
      this.#parent = undefined;
    }
    this.readOnly = this.#state.readOnly;
  }

  #scoped(): ArtifactChange {
    const init: ScopedInit = {
      [SCOPED]: true,
      parent: this,
      state: this.#state,
    };
    return new ArtifactChange(init as unknown as ArtifactStore);
  }

  async operation<T>(work: (change: ArtifactChange) => Promise<T>): Promise<T> {
    const scoped = this.#scoped();
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

  write(): ArtifactStoreWrite | undefined {
    if (
      this.#state.artifacts.size === 0 &&
      this.#state.blobs.size === 0 &&
      this.#state.contents.size === 0 &&
      this.#state.events.length === 0
    ) {
      return;
    }
    return {
      deleteArtifacts: deleted(this.#state.artifacts),
      deleteBlobs: deleted(this.#state.blobs),
      deleteContents: deleted(this.#state.contents),
      ...(this.#state.events.length === 0
        ? {}
        : { events: [...this.#state.events] }),
      putArtifacts: kept(this.#state.artifacts),
      putBlobs: kept(this.#state.blobs),
      putContents: kept(this.#state.contents),
    };
  }

  record(event: EventInput): void {
    this.assertWritable();
    this.#state.events.push({
      ...event,
      at: new Date().toISOString(),
      id: crypto.randomUUID(),
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
    let total = stored.total + pending.length;
    for (const id of touched) {
      const before = await this.#state.store.getArtifact(id);
      if (before && matchesArtifactFilter(before, filter)) {
        total -= 1;
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
      await this.#state.store.listContents(artifactId),
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

  async listBlobs(): Promise<readonly BlobListing[]> {
    this.#assertActive();
    const listed: BlobListing[] = (await this.#state.store.listBlobs()).filter(
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
    if (
      blob.path !== undefined &&
      (await this.listBlobs()).some(
        (other) => other.id !== blob.id && other.path === blob.path
      )
    ) {
      throw new Error("Blob backing path already belongs to another blob");
    }
    this.#state.blobs.set(blob.id, structuredClone(blob));
    this.#wrote();
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

function namesBlob(content: Content, id: BlobId, skip?: string): boolean {
  return Object.entries(content.tree).some(
    ([path, node]) =>
      node.type === "file" && node.blobId === id && path !== skip
  );
}
