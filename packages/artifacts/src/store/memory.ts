import type { ArtifactId, BlobId, ContentId } from "../ref";
import type { Artifact, ArtifactRecords, Blob, Content } from "../schema";
import type {
  ArtifactStore,
  ArtifactStoreWrite,
  BlobListing,
  BlobReferences,
} from "./index";

export interface InMemoryArtifactStoreOptions {
  /** Starting records; cloned, so the caller keeps ownership. */
  readonly records?: ArtifactRecords;
}

/**
 * The default store: plain maps in this process. Transactions run one at a
 * time, so several managers over one store never interleave a change.
 */
export class InMemoryArtifactStore implements ArtifactStore {
  readonly #artifacts = new Map<ArtifactId, Artifact>();
  readonly #blobs = new Map<BlobId, Blob>();
  readonly #contents = new Map<ContentId, Content>();
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: InMemoryArtifactStoreOptions = {}) {
    const { artifacts, blobs, contents } = structuredClone(
      options.records ?? { artifacts: [], blobs: [], contents: [] }
    );
    for (const artifact of artifacts) {
      this.#artifacts.set(artifact.id, artifact);
    }
    for (const blob of blobs) {
      this.#blobs.set(blob.id, blob);
    }
    for (const content of contents) {
      this.#contents.set(content.id, content);
    }
  }

  commit(write: ArtifactStoreWrite): Promise<void> {
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
    const { putArtifacts, putBlobs, putContents } = puts;
    for (const id of write.deleteArtifacts ?? []) {
      this.#artifacts.delete(id);
    }
    for (const id of write.deleteContents ?? []) {
      this.#contents.delete(id);
    }
    for (const id of write.deleteBlobs ?? []) {
      this.#blobs.delete(id);
    }
    for (const artifact of putArtifacts) {
      this.#artifacts.set(artifact.id, artifact);
    }
    for (const content of putContents) {
      this.#contents.set(content.id, content);
    }
    for (const blob of putBlobs) {
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

  listArtifacts(): Promise<readonly Artifact[]> {
    return detached([...this.#artifacts.values()]);
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

  /** A clone of every record. */
  records(): Promise<ArtifactRecords> {
    return detached({
      artifacts: [...this.#artifacts.values()],
      blobs: [...this.#blobs.values()],
      contents: [...this.#contents.values()],
    });
  }

  transaction<T>(work: (view: ArtifactStore) => Promise<T>): Promise<T> {
    const run = this.#tail.then(() => work(this));
    this.#tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

function detached<T>(value: T): Promise<T> {
  return Promise.resolve(structuredClone(value));
}
