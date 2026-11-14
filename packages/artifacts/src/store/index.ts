import type { ArtifactCursor, ArtifactFilter } from "../listing";
import type { ArtifactId, BlobId, ContentId } from "../ref";
import type { Artifact, Blob, Content } from "../schema";

export type { ArtifactCursor, ArtifactFilter } from "../listing";

/** A blob as a listing names it: its id and backing file, never its bytes. */
export type BlobListing = Pick<Blob, "id" | "path">;

/** The records that name a blob: Contents whose tree holds it, blobs whose chunks do. */
export interface BlobReferences {
  readonly blobIds: readonly BlobId[];
  readonly contentIds: readonly ContentId[];
}

/** A page of Artifacts in creation order, and how many match in all. */
export interface ArtifactListQuery extends ArtifactFilter {
  /** Only Artifacts after this one in creation order. */
  readonly after?: ArtifactCursor;
  /** At most this many, a positive integer. */
  readonly limit: number;
}

export interface ArtifactListing {
  /** The first `limit` matches after `after`, oldest first, then by id. */
  readonly artifacts: readonly Artifact[];
  /** Every match of the filter, `after` and `limit` aside. */
  readonly total: number;
}

/** A store that offers `transaction`, as every Artifact store does. */
export type TransactionalArtifactStore = ArtifactStore &
  Required<Pick<ArtifactStore, "transaction">>;

/**
 * One atomic write. Deletes apply before puts. The package never lists one
 * id in both, and deletes no record a put still needs.
 */
export interface ArtifactStoreWrite {
  readonly deleteArtifacts?: readonly ArtifactId[];
  readonly deleteBlobs?: readonly BlobId[];
  readonly deleteContents?: readonly ContentId[];
  readonly putArtifacts?: readonly Artifact[];
  readonly putBlobs?: readonly Blob[];
  readonly putContents?: readonly Content[];
}

/**
 * The persistence seam. A store keeps Artifacts, Contents and blobs and
 * applies one write atomically. It enforces nothing: pointers naming an
 * Artifact's own Content, Contents needing their Artifact, cascades, blob
 * validity and backing-file ownership are the package's rules, checked
 * before a write reaches the store. Values crossing this seam are detached.
 *
 * Blob bytes cross the seam as records: inline bytes inside the blob, or the
 * name of an immutable backing file the package published before the write.
 */
export interface ArtifactStore {
  commit(write: ArtifactStoreWrite): Promise<void>;
  /** The blobs holding bytes with this digest, in no particular order. */
  findBlobs(digest: string): Promise<readonly Blob[]>;
  /** The records naming the blob, in no particular order. */
  findReferences(id: BlobId): Promise<BlobReferences>;
  getArtifact(id: ArtifactId): Promise<Artifact | null>;
  getBlob(id: BlobId): Promise<Blob | null>;
  getContent(id: ContentId): Promise<Content | null>;
  /**
   * The Artifacts matching the filter in creation order: oldest `createdAt`
   * first, then by id in code-unit order.
   */
  listArtifacts(query: ArtifactListQuery): Promise<ArtifactListing>;
  /** Every blob, in no particular order. */
  listBlobs(): Promise<readonly BlobListing[]>;
  /** The Artifact's Contents, or every Content, in no particular order. */
  listContents(artifactId?: ArtifactId): Promise<readonly Content[]>;
  /**
   * Runs one read-modify-write, or one read of several steps, so that no
   * other write lands between its reads and its commit, from any
   * `ArtifactManager` over the store: a plain `commit` waits until `work`
   * settles. `work` reads and commits through `view` only, and its reads see
   * its own commits: a `commit` or `transaction` on the store itself from
   * inside `work` rejects at once with an error saying to use the view. If
   * `work` throws, none of its commits stay. Without it, changes are
   * serialized per `ArtifactManager` and no further.
   *
   * A `commit` (or a transaction) rejects when its write did not land. One
   * that rejects after the write landed (a durability failure reported once
   * the records were replaced) leaves the write readable; the package reads
   * back to tell the two apart.
   */
  transaction?<T>(work: (view: ArtifactStore) => Promise<T>): Promise<T>;
}
