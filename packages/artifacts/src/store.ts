import type { Page } from "@foundry/core/pagination";

import type { Blob } from "./blob";
import type { ArtifactCursor } from "./listing";
import type { ArtifactId, BlobId, ContentId } from "./ref";
import type {
  Artifact,
  Content,
  ListArtifactsInput,
  ListContentsInput,
} from "./substrate";

/**
 * Persistence for the Artifact manager. Every record access happens inside a
 * transaction; the store serializes write transactions and commits each one
 * atomically or not at all.
 */
export interface ArtifactStore {
  transaction<T>(
    operation: (store: ArtifactStoreTransaction) => Promise<T>,
    options?: { readonly readOnly?: boolean }
  ): Promise<T>;
}

/**
 * One transaction's view of the records. The handle expires when the
 * transaction settles; later calls reject. A read-only transaction rejects
 * writes and `afterCommit`.
 *
 * Implementations must enforce these invariants:
 * - `putArtifact` rejects a `contentId` that names another Artifact's Content.
 * - `putContent` rejects Content whose Artifact does not exist.
 * - `deleteArtifact` deletes the Artifact's Contents with it.
 * - `deleteContent` rejects the Artifact's active Content.
 * - `putBlob` rejects an invalid blob (see `validateBlob`) and a backing
 *   `path` already owned by another blob.
 *
 * A host may pin frozen Content. Deleting pinned Content throws
 * `ContentInUseError`; deleting an Artifact holding it throws
 * `ArtifactInUseError`.
 */
export interface ArtifactStoreTransaction {
  /** Await after the commit; discard on rollback. */
  afterCommit(operation: () => Promise<void>): void;
  deleteArtifact(id: ArtifactId): Promise<void>;
  deleteBlob(id: BlobId): Promise<void>;
  deleteContent(id: ContentId): Promise<void>;
  /** Any blob currently holding bytes with this digest. */
  findBlob(digest: string): Promise<Blob | null>;
  getArtifact(id: ArtifactId): Promise<Artifact | null>;
  getBlob(id: BlobId): Promise<Blob | null>;
  getContent(id: ContentId): Promise<Content | null>;
  /**
   * Whether a Content tree or a chunked blob references the blob. `except`
   * skips one file entry, to ask whether that entry owns the blob alone.
   */
  isBlobReferenced(
    id: BlobId,
    except?: { readonly contentId: ContentId; readonly path: string }
  ): Promise<boolean>;
  listArtifacts(
    input: ListArtifactsInput
  ): Promise<Page<Artifact, ArtifactCursor>>;
  listBlobs(): Promise<readonly Pick<Blob, "id" | "path">[]>;
  listContents(
    artifactId?: ArtifactId,
    input?: ListContentsInput
  ): Promise<readonly Content[]>;
  putArtifact(artifact: Artifact): Promise<void>;
  putBlob(blob: Blob): Promise<void>;
  putContent(content: Content): Promise<void>;
}
