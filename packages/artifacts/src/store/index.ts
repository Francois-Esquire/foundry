import type { ArtifactId, BlobId, ContentId } from "../ids";
import type { ArtifactCursor, ArtifactFilter } from "../listing";
import type { Artifact, ArtifactEvent, Blob, Content } from "../schema";

export type { ArtifactCursor, ArtifactFilter } from "../listing";

export type BlobListing = Pick<Blob, "id" | "path">;

export interface BlobReferences {
  readonly blobIds: readonly BlobId[];
  readonly contentIds: readonly ContentId[];
}

export interface ArtifactListQuery extends ArtifactFilter {
  readonly after?: ArtifactCursor;
  readonly limit: number;
}

export interface ArtifactListing {
  readonly artifacts: readonly Artifact[];
  readonly total?: number;
}

export type ArtifactStoreDurability = "commit" | "host";

export type TransactionalArtifactStore = ArtifactStore &
  Required<Pick<ArtifactStore, "transaction">>;

export interface ArtifactStoreWrite {
  readonly deleteArtifacts?: readonly ArtifactId[];
  readonly deleteBlobs?: readonly BlobId[];
  readonly deleteContents?: readonly ContentId[];
  readonly events?: readonly ArtifactEvent[];
  readonly putArtifacts?: readonly Artifact[];
  readonly putBlobs?: readonly Blob[];
  readonly putContents?: readonly Content[];
}

export interface ArtifactStore {
  commit(write: ArtifactStoreWrite): Promise<void>;
  readonly durability?: ArtifactStoreDurability;
  findBlobByPath?(path: string): Promise<Blob | null>;
  findBlobs(digest: string): Promise<readonly Blob[]>;
  findReferences(id: BlobId): Promise<BlobReferences>;
  getArtifact(id: ArtifactId): Promise<Artifact | null>;
  getBlob(id: BlobId): Promise<Blob | null>;
  getContent(id: ContentId): Promise<Content | null>;
  listArtifacts(query: ArtifactListQuery): Promise<ArtifactListing>;
  listBlobs(): Promise<readonly BlobListing[]>;
  listContents(artifactId?: ArtifactId): Promise<readonly Content[]>;
  transaction?<T>(work: (view: ArtifactStore) => Promise<T>): Promise<T>;
}
