import { Turns } from "@foundry/lib/turns";

import {
  compareCreated,
  isAfterCursor,
  matchesArtifactFilter,
  ownedListQuery,
} from "../listing";
import type { ArtifactId, BlobId, ContentId } from "../ref";
import type { Artifact, ArtifactRecords, Blob, Content } from "../schema";
import type {
  ArtifactListing,
  ArtifactListQuery,
  ArtifactStore,
  ArtifactStoreWrite,
  BlobListing,
  BlobReferences,
} from "./index";
import { ownedRecords, ownedWrite } from "./owned";

export interface InMemoryArtifactStoreOptions {
  readonly records?: ArtifactRecords;
}

const REENTRY =
  "InMemoryArtifactStore was called from inside its own transaction; use the view passed to the transaction's work instead";

export class InMemoryArtifactStore implements ArtifactStore {
  #records: Records;
  readonly #turns = new Turns(REENTRY);

  constructor(options: InMemoryArtifactStoreOptions = {}) {
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
        findBlobs: (digest) => read((records) => records.findBlobs(digest)),
        findReferences: (id) => read((records) => records.findReferences(id)),
        getArtifact: (id) => read((records) => records.getArtifact(id)),
        getBlob: (id) => read((records) => records.getBlob(id)),
        getContent: (id) => read((records) => records.getContent(id)),
        listArtifacts: (query) =>
          listed(query, (copy) =>
            read((records) => records.listArtifacts(copy))
          ),
        listBlobs: () => read((records) => records.listBlobs()),
        listContents: (artifactId) =>
          read((records) => records.listContents(artifactId)),
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

  findBlobs(digest: string): Promise<readonly Blob[]> {
    return this.#records.findBlobs(digest);
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

  listContents(artifactId?: ArtifactId): Promise<readonly Content[]> {
    return this.#records.listContents(artifactId);
  }

  records(): Promise<ArtifactRecords> {
    return this.#records.all();
  }
}

class Records {
  readonly #artifacts: Map<ArtifactId, Artifact>;
  readonly #blobs: Map<BlobId, Blob>;
  readonly #contents: Map<ContentId, Content>;

  private constructor(
    artifacts: Map<ArtifactId, Artifact>,
    blobs: Map<BlobId, Blob>,
    contents: Map<ContentId, Content>
  ) {
    this.#artifacts = artifacts;
    this.#blobs = blobs;
    this.#contents = contents;
  }

  static from(records: ArtifactRecords): Records {
    return new Records(
      new Map(records.artifacts.map((row) => [row.id, row])),
      new Map(records.blobs.map((row) => [row.id, row])),
      new Map(records.contents.map((row) => [row.id, row]))
    );
  }

  copy(): Records {
    return new Records(
      new Map(this.#artifacts),
      new Map(this.#blobs),
      new Map(this.#contents)
    );
  }

  apply(write: ArtifactStoreWrite): Promise<void> {
    for (const id of write.deleteArtifacts ?? []) {
      this.#artifacts.delete(id);
    }
    for (const id of write.deleteContents ?? []) {
      this.#contents.delete(id);
    }
    for (const id of write.deleteBlobs ?? []) {
      this.#blobs.delete(id);
    }
    for (const artifact of write.putArtifacts ?? []) {
      this.#artifacts.set(artifact.id, artifact);
    }
    for (const content of write.putContents ?? []) {
      this.#contents.set(content.id, content);
    }
    for (const blob of write.putBlobs ?? []) {
      this.#blobs.set(blob.id, blob);
    }
    return Promise.resolve();
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

  findBlobs(digest: string): Promise<readonly Blob[]> {
    return detached(
      [...this.#blobs.values()].filter((blob) => blob.digest === digest)
    );
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

  listContents(artifactId?: ArtifactId): Promise<readonly Content[]> {
    return detached(
      [...this.#contents.values()].filter(
        (content) =>
          artifactId === undefined || content.artifactId === artifactId
      )
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
