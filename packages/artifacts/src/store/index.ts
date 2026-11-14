import type { ArtifactId, BlobId, ContentId } from "../ref";
import type { Artifact, Blob, Content } from "../schema";

/** A blob as a listing names it: its id and backing file, never its bytes. */
export type BlobListing = Pick<Blob, "id" | "path">;

/** The records that name a blob: Contents whose tree holds it, blobs whose chunks do. */
export interface BlobReferences {
  readonly blobIds: readonly BlobId[];
  readonly contentIds: readonly ContentId[];
}

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
  /** Every Artifact, in no particular order. */
  listArtifacts(): Promise<readonly Artifact[]>;
  /** Every blob, in no particular order. */
  listBlobs(): Promise<readonly BlobListing[]>;
  /** The Artifact's Contents, or every Content, in no particular order. */
  listContents(artifactId?: ArtifactId): Promise<readonly Content[]>;
  /**
   * Runs one read-modify-write so that no other transaction on the store
   * lands between its reads and its commit, from any `ArtifactManager` over
   * the store. `work` reads and commits through `view` only. Without it,
   * changes are serialized per `ArtifactManager` and no further.
   */
  transaction?<T>(work: (view: ArtifactStore) => Promise<T>): Promise<T>;
}
