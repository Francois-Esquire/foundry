import type { Page } from "@foundry/core/pagination";

import type { Blob } from "./blob";
import type { ArtifactCursor } from "./pagination";
import type { ArtifactId, BlobId, ContentId } from "./ref";
import type {
  Artifact,
  Content,
  ListArtifactsInput,
  ListContentsInput,
} from "./substrate";

export interface ArtifactStore {
  /** Await after the outer commit; discard on rollback. */
  afterCommit(operation: () => Promise<void>): void;
  deleteArtifact(id: ArtifactId): Promise<void>;
  deleteBlob(id: BlobId): Promise<void>;
  deleteContent(id: ContentId): Promise<void>;
  findBlob(digest: string): Promise<Blob | null>;
  getArtifact(id: ArtifactId): Promise<Artifact | null>;
  getBlob(id: BlobId): Promise<Blob | null>;
  getContent(id: ContentId): Promise<Content | null>;
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
  /** The scoped store expires on settlement. Nested transactions join its owner. */
  transaction<T>(
    operation: (store: ArtifactStore) => Promise<T>,
    options?: { readonly readOnly?: boolean }
  ): Promise<T>;
}
