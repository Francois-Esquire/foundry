import { Turns } from "@foundry/lib/turns";

import {
  compareCreated,
  isAfterCursor,
  matchesArtifactFilter,
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

export interface InMemoryArtifactStoreOptions {
  /** Starting records; cloned, so the caller keeps ownership. */
  readonly records?: ArtifactRecords;
}

/** Why a call from inside the store's own transaction is refused. */
const REENTRY =
  "InMemoryArtifactStore was called from inside its own transaction; use the view passed to the transaction's work instead";

/**
 * The default store: plain maps in this process. Commits and transactions
 * take turns, so a commit never lands inside a running transaction, and a
 * commit or transaction made from inside a transaction's work is refused.
 * A transaction commits to a staged copy, swapped in only when its work
 * succeeds.
 */
export class InMemoryArtifactStore implements ArtifactStore {
  #records: Records;
  readonly #turns = new Turns(REENTRY);

  constructor(options: InMemoryArtifactStoreOptions = {}) {
    this.#records = Records.from(
      structuredClone(
        options.records ?? { artifacts: [], blobs: [], contents: [] }
      )
    );
  }

  commit(write: ArtifactStoreWrite): Promise<void> {
    return this.#turns.run(() => this.#records.apply(write));
  }

  transaction<T>(work: (view: ArtifactStore) => Promise<T>): Promise<T> {
    return this.#turns.run(async () => {
      let staged: Records | undefined;
      let open = true;
      /** The records the view reads, rejecting once the transaction settled. */
      const read = <R>(take: (records: Records) => Promise<R>): Promise<R> =>
        open
          ? take(staged ?? this.#records)
          : Promise.reject(new Error("Artifact store transaction has settled"));
      const view: ArtifactStore = {
        commit: (write) =>
          read(() => {
            staged ??= this.#records.copy();
            return staged.apply(write);
          }),
        findBlobs: (digest) => read((records) => records.findBlobs(digest)),
        findReferences: (id) => read((records) => records.findReferences(id)),
        getArtifact: (id) => read((records) => records.getArtifact(id)),
        getBlob: (id) => read((records) => records.getBlob(id)),
        getContent: (id) => read((records) => records.getContent(id)),
        listArtifacts: (query) =>
          read((records) => records.listArtifacts(query)),
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
    return this.#records.listArtifacts(query);
  }

  listBlobs(): Promise<readonly BlobListing[]> {
    return this.#records.listBlobs();
  }

  listContents(artifactId?: ArtifactId): Promise<readonly Content[]> {
    return this.#records.listContents(artifactId);
  }

  /** A clone of every record. */
  records(): Promise<ArtifactRecords> {
    return this.#records.all();
  }
}

/**
 * One set of maps. Records are never changed in place, only replaced, so a
 * copy shares them and costs one entry per record.
 */
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

  /** Takes ownership of `records`. */
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
    // Clone first so a value that cannot be cloned refuses the whole write.
    let puts: Required<
      Pick<ArtifactStoreWrite, "putArtifacts" | "putBlobs" | "putContents">
    >;
    try {
      puts = structuredClone({
        putArtifacts: write.putArtifacts ?? [],
        putBlobs: write.putBlobs ?? [],
        putContents: write.putContents ?? [],
      });
    } catch (error) {
      return Promise.reject(error);
    }
    for (const id of write.deleteArtifacts ?? []) {
      this.#artifacts.delete(id);
    }
    for (const id of write.deleteContents ?? []) {
      this.#contents.delete(id);
    }
    for (const id of write.deleteBlobs ?? []) {
      this.#blobs.delete(id);
    }
    for (const artifact of puts.putArtifacts) {
      this.#artifacts.set(artifact.id, artifact);
    }
    for (const content of puts.putContents) {
      this.#contents.set(content.id, content);
    }
    for (const blob of puts.putBlobs) {
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

function detached<T>(value: T): Promise<T> {
  return Promise.resolve(structuredClone(value));
}
