import type { Page } from "@foundry/core/pagination";
import { pageFromRows } from "@foundry/lib/pagination";
import { Turns } from "@foundry/lib/turns";
import { StaleContentError } from "../errors";
import type { ArtifactId, BlobId, ContentId } from "../ids";
import type {
  NormalizedBlobPageQuery,
  NormalizedContentPageQuery,
} from "../listing";
import {
  byCodePoint,
  compareCreated,
  isAfterCursor,
  matchesArtifactFilter,
  ownedBlobPageQuery,
  ownedContentPageQuery,
  ownedListQuery,
} from "../listing";
import type { Artifact, ArtifactRecords, Blob, Content } from "../schema";
import type {
  ArtifactListing,
  ArtifactListQuery,
  ArtifactStore,
  ArtifactStoreWrite,
  BlobListing,
  BlobPageQuery,
  BlobReferences,
  ContentLookup,
  ContentPageQuery,
} from "./index";
import { ownedRecords, ownedWrite } from "./owned";

export interface MemoryArtifactStoreOptions {
  readonly records?: ArtifactRecords;
}

const REENTRY =
  "MemoryArtifactStore was called from inside its own transaction; use the view passed to the transaction's work instead";

export class MemoryArtifactStore implements ArtifactStore {
  #records: Records;
  readonly #turns = new Turns(REENTRY);

  constructor(options: MemoryArtifactStoreOptions = {}) {
    this.#records = Records.from(
      ownedRecords(
        options.records ?? { artifacts: [], blobs: [], contents: [] }
      )
    );
  }

  commit(write: ArtifactStoreWrite): Promise<void> {
    return owned(write, (copy) =>
      this.#turns.run(() => this.#records.apply(copy))
    );
  }

  transaction<T>(work: (view: ArtifactStore) => Promise<T>): Promise<T> {
    return this.#turns.run(async () => {
      let staged: Records | undefined;
      let open = true;
      const read = <R>(take: (records: Records) => Promise<R>): Promise<R> =>
        open
          ? take(staged ?? this.#records)
          : Promise.reject(new Error("Artifact store transaction has settled"));
      const view: ArtifactStore = {
        commit: (write) =>
          owned(write, (copy) =>
            read(() => {
              staged ??= this.#records.copy();
              return staged.apply(copy);
            })
          ),
        durability: "host",
        findBlobByPath: (path) =>
          read((records) => records.findBlobByPath(path)),
        findBlobs: (digest) => read((records) => records.findBlobs(digest)),
        findContent: (artifactId, by) =>
          read((records) => records.findContent(artifactId, by)),
        findContentByTag: (artifactId, tag) =>
          read((records) => records.findContentByTag(artifactId, tag)),
        findReferences: (id) => read((records) => records.findReferences(id)),
        getArtifact: (id) => read((records) => records.getArtifact(id)),
        getBlob: (id) => read((records) => records.getBlob(id)),
        getContent: (id) => read((records) => records.getContent(id)),
        listArtifacts: (query) =>
          listed(query, (copy) =>
            read((records) => records.listArtifacts(copy))
          ),
        listBlobs: () => read((records) => records.listBlobs()),
        listBlobsPage: (query) =>
          pagedBlobs(query, (copy) =>
            read((records) => records.listBlobsPage(copy))
          ),
        listContents: (artifactId) =>
          read((records) => records.listContents(artifactId)),
        listContentsPage: (query) =>
          pagedContents(query, (copy) =>
            read((records) => records.listContentsPage(copy))
          ),
      };
      try {
        const result = await work(view);
        if (staged) {
          this.#records = staged;
        }
        return result;
      } finally {
        open = false;
      }
    });
  }

  findBlobByPath(path: string): Promise<Blob | null> {
    return this.#records.findBlobByPath(path);
  }

  findBlobs(digest: string): Promise<readonly Blob[]> {
    return this.#records.findBlobs(digest);
  }

  findContent(
    artifactId: ArtifactId,
    by: ContentLookup
  ): Promise<Content | null> {
    return this.#records.findContent(artifactId, by);
  }

  findContentByTag(
    artifactId: ArtifactId,
    tag: string
  ): Promise<Content | null> {
    return this.#records.findContentByTag(artifactId, tag);
  }

  findReferences(id: BlobId): Promise<BlobReferences> {
    return this.#records.findReferences(id);
  }

  getArtifact(id: ArtifactId): Promise<Artifact | null> {
    return this.#records.getArtifact(id);
  }

  getBlob(id: BlobId): Promise<Blob | null> {
    return this.#records.getBlob(id);
  }

  getContent(id: ContentId): Promise<Content | null> {
    return this.#records.getContent(id);
  }

  listArtifacts(query: ArtifactListQuery): Promise<ArtifactListing> {
    return listed(query, (copy) => this.#records.listArtifacts(copy));
  }

  listBlobs(): Promise<readonly BlobListing[]> {
    return this.#records.listBlobs();
  }

  listBlobsPage(query?: BlobPageQuery): Promise<Page<BlobListing, BlobId>> {
    return pagedBlobs(query, (copy) => this.#records.listBlobsPage(copy));
  }

  listContents(artifactId?: ArtifactId): Promise<readonly Content[]> {
    return this.#records.listContents(artifactId);
  }

  listContentsPage(
    query?: ContentPageQuery
  ): Promise<Page<Content, ContentId>> {
    return pagedContents(query, (copy) => this.#records.listContentsPage(copy));
  }

  records(): Promise<ArtifactRecords> {
    return this.#records.all();
  }
}

class Records {
  readonly #artifacts: Map<ArtifactId, Artifact>;
  readonly #blobs: Map<BlobId, Blob>;
  readonly #blobsByPath: Map<string, BlobId>;
  readonly #contents: Map<ContentId, Content>;

  private constructor(
    artifacts: Map<ArtifactId, Artifact>,
    blobs: Map<BlobId, Blob>,
    blobsByPath: Map<string, BlobId>,
    contents: Map<ContentId, Content>
  ) {
    this.#artifacts = artifacts;
    this.#blobs = blobs;
    this.#blobsByPath = blobsByPath;
    this.#contents = contents;
  }

  static from(records: ArtifactRecords): Records {
    const blobsByPath = new Map<string, BlobId>();
    for (const row of records.blobs) {
      if (row.path !== undefined) {
        blobsByPath.set(row.path, row.id);
      }
    }
    return new Records(
      new Map(records.artifacts.map((row) => [row.id, row])),
      new Map(records.blobs.map((row) => [row.id, row])),
      blobsByPath,
      new Map(records.contents.map((row) => [row.id, row]))
    );
  }

  copy(): Records {
    return new Records(
      new Map(this.#artifacts),
      new Map(this.#blobs),
      new Map(this.#blobsByPath),
      new Map(this.#contents)
    );
  }

  apply(write: ArtifactStoreWrite): Promise<void> {
    const conflict = this.#checkPreconditions(write.preconditions);
    if (conflict !== undefined) {
      return Promise.reject(conflict);
    }
    this.#applyDeletes(write);
    this.#applyPuts(write);
    return Promise.resolve();
  }

  #applyDeletes(write: ArtifactStoreWrite): void {
    for (const id of write.deleteArtifacts ?? []) {
      this.#artifacts.delete(id);
    }
    for (const id of write.deleteContents ?? []) {
      this.#contents.delete(id);
    }
    for (const id of write.deleteBlobs ?? []) {
      const previous = this.#blobs.get(id);
      if (
        previous?.path !== undefined &&
        this.#blobsByPath.get(previous.path) === id
      ) {
        this.#blobsByPath.delete(previous.path);
      }
      this.#blobs.delete(id);
    }
  }

  #applyPuts(write: ArtifactStoreWrite): void {
    for (const artifact of write.putArtifacts ?? []) {
      this.#artifacts.set(artifact.id, artifact);
    }
    for (const content of write.putContents ?? []) {
      this.#contents.set(content.id, content);
    }
    for (const blob of write.putBlobs ?? []) {
      const previous = this.#blobs.get(blob.id);
      if (
        previous?.path !== undefined &&
        this.#blobsByPath.get(previous.path) === blob.id
      ) {
        this.#blobsByPath.delete(previous.path);
      }
      this.#blobs.set(blob.id, blob);
      if (blob.path !== undefined) {
        this.#blobsByPath.set(blob.path, blob.id);
      }
    }
  }

  #checkPreconditions(
    preconditions: ArtifactStoreWrite["preconditions"]
  ): StaleContentError | undefined {
    if (preconditions === undefined) {
      return;
    }
    return (
      this.#checkArtifactContentPreconditions(
        preconditions.artifactContentIds
      ) ??
      this.#checkContentUpdatedAtPreconditions(preconditions.contentUpdatedAt)
    );
  }

  #checkArtifactContentPreconditions(
    expected: Readonly<Record<ArtifactId, ContentId | null>> | undefined
  ): StaleContentError | undefined {
    for (const [id, expectedContentId] of Object.entries(expected ?? {})) {
      const current = this.#artifacts.get(id as ArtifactId);
      if (current === undefined || current.contentId !== expectedContentId) {
        const currentContent =
          current === undefined || current.contentId === null
            ? null
            : (this.#contents.get(current.contentId) ?? null);
        return new StaleContentError(id as ArtifactId, {
          contentId: current?.contentId ?? null,
          updatedAt: currentContent?.updatedAt ?? null,
        });
      }
    }
  }

  #checkContentUpdatedAtPreconditions(
    expected: Readonly<Record<ContentId, Date>> | undefined
  ): StaleContentError | undefined {
    for (const [id, expectedUpdatedAt] of Object.entries(expected ?? {})) {
      const current = this.#contents.get(id as ContentId);
      if (
        current === undefined ||
        current.updatedAt.getTime() !== expectedUpdatedAt.getTime()
      ) {
        return new StaleContentError(
          current?.artifactId ?? null,
          {
            contentId: current?.id ?? null,
            updatedAt: current?.updatedAt ?? null,
          },
          id as ContentId
        );
      }
    }
  }

  getArtifact(id: ArtifactId): Promise<Artifact | null> {
    return detached(this.#artifacts.get(id) ?? null);
  }

  getBlob(id: BlobId): Promise<Blob | null> {
    return detached(this.#blobs.get(id) ?? null);
  }

  getContent(id: ContentId): Promise<Content | null> {
    return detached(this.#contents.get(id) ?? null);
  }

  findBlobByPath(path: string): Promise<Blob | null> {
    const id = this.#blobsByPath.get(path);
    return detached(id === undefined ? null : (this.#blobs.get(id) ?? null));
  }

  findBlobs(digest: string): Promise<readonly Blob[]> {
    return detached(
      [...this.#blobs.values()].filter((blob) => blob.digest === digest)
    );
  }

  findContent(
    artifactId: ArtifactId,
    by: ContentLookup
  ): Promise<Content | null> {
    if (
      typeof artifactId !== "string" ||
      typeof by.sessionId !== "string" ||
      typeof by.messageId !== "string"
    ) {
      return Promise.resolve(null);
    }
    const matches = [...this.#contents.values()]
      .filter(
        (content) =>
          content.artifactId === artifactId &&
          content.metadata.sessionId === by.sessionId &&
          content.metadata.messageId === by.messageId
      )
      .sort(compareCreated);
    return detached(matches.at(-1) ?? null);
  }

  findContentByTag(
    artifactId: ArtifactId,
    tag: string
  ): Promise<Content | null> {
    if (typeof artifactId !== "string" || typeof tag !== "string") {
      return Promise.resolve(null);
    }
    const found = [...this.#contents.values()].find(
      (content) => content.artifactId === artifactId && content.tag === tag
    );
    return detached(found ?? null);
  }

  findReferences(id: BlobId): Promise<BlobReferences> {
    return Promise.resolve({
      blobIds: [...this.#blobs.values()]
        .filter((blob) => blob.chunks?.includes(id))
        .map((blob) => blob.id),
      contentIds: [...this.#contents.values()]
        .filter((content) =>
          Object.values(content.tree).some(
            (node) => node.type === "file" && node.blobId === id
          )
        )
        .map((content) => content.id),
    });
  }

  listArtifacts(query: ArtifactListQuery): Promise<ArtifactListing> {
    const matches = [...this.#artifacts.values()]
      .filter((artifact) => matchesArtifactFilter(artifact, query))
      .sort(compareCreated);
    return detached({
      artifacts: matches
        .filter((artifact) => isAfterCursor(artifact, query.after))
        .slice(0, query.limit),
      total: matches.length,
    });
  }

  listBlobs(): Promise<readonly BlobListing[]> {
    return Promise.resolve(
      [...this.#blobs.values()].map((blob) => ({
        id: blob.id,
        ...(blob.path === undefined ? {} : { path: blob.path }),
      }))
    );
  }

  listBlobsPage(
    query: NormalizedBlobPageQuery
  ): Promise<Page<BlobListing, BlobId>> {
    const rows = [...this.#blobs.values()]
      .filter(
        (blob) =>
          query.cursor === undefined || byCodePoint(blob.id, query.cursor) > 0
      )
      .sort((a, b) => byCodePoint(a.id, b.id))
      .slice(0, query.limit + 1)
      .map((blob) => ({
        id: blob.id,
        ...(blob.path === undefined ? {} : { path: blob.path }),
      }));
    return Promise.resolve(
      pageFromRows(rows, query.limit, undefined, (blob) => blob.id)
    );
  }

  listContents(artifactId?: ArtifactId): Promise<readonly Content[]> {
    return detached(
      [...this.#contents.values()].filter(
        (content) =>
          artifactId === undefined || content.artifactId === artifactId
      )
    );
  }

  listContentsPage(
    query: NormalizedContentPageQuery
  ): Promise<Page<Content, ContentId>> {
    const rows = [...this.#contents.values()]
      .filter(
        (content) =>
          (query.artifactId === undefined ||
            content.artifactId === query.artifactId) &&
          (query.states === undefined ||
            query.states.includes(content.state)) &&
          (query.tagged === undefined ||
            (content.tag !== null) === query.tagged) &&
          (query.cursor === undefined ||
            byCodePoint(content.id, query.cursor) > 0)
      )
      .sort((a, b) => byCodePoint(a.id, b.id))
      .slice(0, query.limit + 1);
    return detached(
      pageFromRows(rows, query.limit, undefined, (content) => content.id)
    );
  }

  all(): Promise<ArtifactRecords> {
    return detached({
      artifacts: [...this.#artifacts.values()],
      blobs: [...this.#blobs.values()],
      contents: [...this.#contents.values()],
    });
  }
}

function pagedBlobs(
  query: BlobPageQuery | undefined,
  take: (copy: NormalizedBlobPageQuery) => Promise<Page<BlobListing, BlobId>>
): Promise<Page<BlobListing, BlobId>> {
  let copy: NormalizedBlobPageQuery;
  try {
    copy = ownedBlobPageQuery(query);
  } catch (error) {
    return Promise.reject(error);
  }
  return take(copy);
}

function pagedContents(
  query: ContentPageQuery | undefined,
  take: (copy: NormalizedContentPageQuery) => Promise<Page<Content, ContentId>>
): Promise<Page<Content, ContentId>> {
  let copy: NormalizedContentPageQuery;
  try {
    copy = ownedContentPageQuery(query);
  } catch (error) {
    return Promise.reject(error);
  }
  return take(copy);
}

function listed(
  query: ArtifactListQuery,
  take: (copy: ArtifactListQuery) => Promise<ArtifactListing>
): Promise<ArtifactListing> {
  let copy: ArtifactListQuery;
  try {
    copy = ownedListQuery(query);
  } catch (error) {
    return Promise.reject(error);
  }
  return take(copy);
}

function owned(
  write: ArtifactStoreWrite,
  take: (copy: ArtifactStoreWrite) => Promise<void>
): Promise<void> {
  let copy: ArtifactStoreWrite;
  try {
    copy = ownedWrite(write);
  } catch (error) {
    return Promise.reject(error);
  }
  return take(copy);
}

function detached<T>(value: T): Promise<T> {
  return Promise.resolve(structuredClone(value));
}
