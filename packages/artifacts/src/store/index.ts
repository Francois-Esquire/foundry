import type { Page, PageInput } from "@foundry/core/pagination";
import type { ArtifactId, BlobId, ContentId } from "../ids";
import type { ArtifactCursor, ArtifactFilter } from "../listing";
import type {
  Artifact,
  ArtifactEvent,
  Blob,
  Content,
  ContentState,
} from "../schema";

export type { ArtifactCursor, ArtifactFilter } from "../listing";

export type BlobListing = Pick<Blob, "id" | "path">;

export type BlobPageQuery = PageInput<BlobId>;

export interface ContentLookup {
  readonly messageId: string;
  readonly sessionId: string;
}

export interface ContentPageQuery extends PageInput<ContentId> {
  readonly artifactId?: ArtifactId;
  readonly state?: ContentState | readonly ContentState[];
  readonly tagged?: boolean;
}

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
  findContent?(
    artifactId: ArtifactId,
    by: ContentLookup
  ): Promise<Content | null>;
  findContentByTag?(
    artifactId: ArtifactId,
    tag: string
  ): Promise<Content | null>;
  findReferences(id: BlobId): Promise<BlobReferences>;
  getArtifact(id: ArtifactId): Promise<Artifact | null>;
  getBlob(id: BlobId): Promise<Blob | null>;
  getContent(id: ContentId): Promise<Content | null>;
  listArtifacts(query: ArtifactListQuery): Promise<ArtifactListing>;
  listBlobs(): Promise<readonly BlobListing[]>;
  listBlobsPage?(query?: BlobPageQuery): Promise<Page<BlobListing, BlobId>>;
  listContents(artifactId?: ArtifactId): Promise<readonly Content[]>;
  listContentsPage?(
    query?: ContentPageQuery
  ): Promise<Page<Content, ContentId>>;
  transaction?<T>(work: (view: ArtifactStore) => Promise<T>): Promise<T>;
}
