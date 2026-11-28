import type { Page, PageInput } from "@foundry/core/pagination";
import type {
  CommitEffects,
  FileNode,
  FileRepresentation,
  StorageNode,
} from "@foundry/core/storage";
import type { ArtifactId, BlobId, ContentId } from "./ids";
import type { ArtifactCursor } from "./listing";
import type {
  Artifact,
  Content,
  ContentMetadata,
  ContentState,
} from "./schema";
import type { ArtifactStoreDurability } from "./store";

export type { Artifact, Content } from "./schema";

export interface ArtifactResolved extends Artifact {
  readonly content: Content | null;
}

export interface ContentResolved extends Content {
  readonly artifact: Artifact;
}

export interface FileResolved extends FileRepresentation {
  readonly blob: Uint8Array;
}

export interface FileRangeResolved extends FileRepresentation {
  readonly body: AsyncIterable<Uint8Array>;
  readonly range: { readonly start: number; readonly end: number };
}

export type FileInput = { readonly type?: "file" } & (
  | { readonly bytes: Uint8Array | string; readonly mime?: string | null }
  | {
      readonly blobId: BlobId;
      readonly mime?: string | null;
    }
  | {
      readonly digest: string;
      readonly bytes: number;
      readonly mime?: string | null;
      readonly path?: undefined;
    }
  | {
      readonly path: string;
      readonly digest: string;
      readonly bytes: number;
      readonly mime?: string | null;
    }
  | {
      readonly source: AsyncIterable<Uint8Array>;
      readonly bytes?: number;
      readonly mime?: string | null;
    }
);

export type EntryInput = FileInput | Exclude<StorageNode, FileNode>;
export type EntryInputs = Readonly<Record<string, EntryInput>>;

export type FileInputs = Readonly<Record<string, FileInput>>;

export interface TreeChanges {
  readonly put?: EntryInputs;
  readonly remove?: readonly string[];
  readonly replace?: boolean;
}

export interface FreezeOption {
  readonly metadata?: ContentMetadata;
  readonly tag?: string;
}

export interface WriteFence {
  readonly expectedContentId?: ContentId | null;
  readonly expectedUpdatedAt?: Date;
}

export interface CreateArtifactInput {
  readonly entries?: EntryInputs;
  readonly freeze?: FreezeOption;
  readonly id?: ArtifactId;
  readonly metadata?: ContentMetadata;
  readonly name: string;
  readonly type: string;
}

export interface WriteInput extends WriteFence {
  readonly artifactId: ArtifactId;
  readonly changes: TreeChanges;
  readonly freeze?: FreezeOption;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ReviseInput {
  readonly artifactId: ArtifactId;
  readonly changes?: TreeChanges;
  readonly contentId: ContentId;
  readonly expectedUpdatedAt: Date;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ListArtifactsInput extends PageInput<ArtifactCursor> {
  readonly includeArchived?: boolean;
  readonly query?: string;
  readonly type?: string;
}

export interface ListContentsInput {
  readonly state?: ContentState | readonly ContentState[];
  readonly tagged?: boolean;
}

export type ContentSummary = Omit<Content, "tree">;

export interface ArtifactOperations {
  archive(artifactId: ArtifactId): Promise<Artifact>;
  clearFailedContent(input: {
    readonly artifactId: ArtifactId;
    readonly expectedContentId: ContentId;
  }): Promise<ArtifactResolved>;
  create(input: CreateArtifactInput): Promise<ArtifactResolved>;
  delete(artifactId: ArtifactId): Promise<boolean>;
  deleteContent(input: {
    readonly contentId: ContentId;
    readonly replacementContentId?: ContentId;
  }): Promise<void>;
  findContent(
    artifactId: ArtifactId,
    by: { readonly sessionId: string; readonly messageId: string }
  ): Promise<Content | null>;
  fork(input: {
    readonly id?: ArtifactId;
    readonly contentId: ContentId;
    readonly name?: string;
  }): Promise<ArtifactResolved>;
  freeze(
    contentId: ContentId,
    option?: FreezeOption & { readonly expectedUpdatedAt?: Date }
  ): Promise<Content>;
  get(artifactId: ArtifactId): Promise<ArtifactResolved | null>;
  getContent(contentId: ContentId): Promise<ContentResolved | null>;
  list(
    input?: ListArtifactsInput
  ): Promise<Page<ArtifactResolved, ArtifactCursor>>;
  listContents(
    artifactId: ArtifactId,
    input?: ListContentsInput
  ): Promise<readonly ContentSummary[]>;
  patchArtifactMetadata(
    artifactId: ArtifactId,
    patch: Readonly<Record<string, unknown>>
  ): Promise<Artifact>;

  readFile(contentId: ContentId, path: string): Promise<FileResolved | null>;
  readFileRange(
    contentId: ContentId,
    path: string,
    range: { readonly start: number; readonly end?: number }
  ): Promise<FileRangeResolved | null>;
  readNamedRoot(
    contentId: ContentId,
    name: string
  ): Promise<FileResolved | null>;
  readRoot(contentId: ContentId): Promise<FileResolved | null>;
  readThumbnail(contentId: ContentId): Promise<FileResolved | null>;
  rename(artifactId: ArtifactId, name: string): Promise<Artifact>;
  revise(input: ReviseInput): Promise<ContentResolved>;
  select(input: {
    readonly artifactId: ArtifactId;
    readonly contentId: ContentId;
    readonly expectedContentId?: ContentId | null;
  }): Promise<ArtifactResolved>;
  setMetadata(
    contentId: ContentId,
    patch: Readonly<Record<string, unknown>>
  ): Promise<Content>;

  sweep(input: { readonly olderThan: Date }): Promise<{
    readonly contents: number;
    readonly blobs: number;
  }>;
  tag(contentId: ContentId, tag: string | null): Promise<Content>;
  unarchive(artifactId: ArtifactId): Promise<Artifact>;

  write(input: WriteInput): Promise<ContentResolved>;
}

export interface RecoverOptions {
  readonly orphanGraceMs?: number;
  readonly signal?: AbortSignal;
}

export type ArtifactChangeCause = "commit" | "recovery";

export type ArtifactObserver = (
  artifactId: ArtifactId,
  cause: ArtifactChangeCause
) => void;

export interface ArtifactSubstrate extends ArtifactOperations {
  bind(apply: (artifactId: ArtifactId) => Promise<void>): () => void;
  readonly durability?: ArtifactStoreDurability;
  observe(changed: ArtifactObserver): () => void;
  recover(options?: RecoverOptions): Promise<void>;
  transaction<T>(
    operation: (
      artifacts: ArtifactOperations,
      effects: CommitEffects
    ) => Promise<T>
  ): Promise<T>;
}
