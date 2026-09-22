import type { Page, PageInput } from "@foundry/core/pagination";
import type {
  FileNode,
  FileRepresentation,
  StorageNode,
} from "@foundry/core/storage";

import type { ContentTree } from "./blob";
import type { ArtifactCursor } from "./pagination";
import type { ArtifactId, BlobId, ContentId } from "./ref";
import type {
  ArtifactLifecycleStatus,
  ArtifactMetadata,
  ContentMetadata,
  ContentState,
} from "./tree";

/**
 * The Artifact substrate: a thing people point at, and the versions of what
 * it holds. Persistence is supplied to the shared Artifact system.
 *
 * Vocabulary: a Content is one version. Its bytes are the tree, the files,
 * the blobs; never "content".
 */

export interface Artifact {
  readonly archivedAt: Date | null;
  readonly contentId: ContentId | null;
  readonly createdAt: Date;
  readonly id: ArtifactId;
  readonly metadata: ArtifactMetadata;
  readonly name: string;
  readonly publishedAt: Date | null;
  readonly status: ArtifactLifecycleStatus;
  readonly type: string;
  readonly updatedAt: Date;
}

export interface Content {
  readonly artifactId: ArtifactId;
  readonly createdAt: Date;
  readonly digest: string;
  readonly frozenAt: Date | null;
  readonly id: ContentId;
  readonly metadata: ContentMetadata;
  readonly state: ContentState;
  readonly tag: string | null;
  readonly tree: ContentTree;
  readonly updatedAt: Date;
}

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
  /** Pull-based; each pull yields at most one chunk's bytes, sliced to the interval. */
  readonly body: AsyncIterable<Uint8Array>;
  /** Interval actually served, [start, end), clamped to [0, byteLength). */
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
    }
  | {
      readonly source: AsyncIterable<Uint8Array>;
      /** Declared byte length (host-path fs.stat); enables early cap refusal. */
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
  /** Absent: the artifact starts empty with a null pointer. */
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
  /** Shallow-merged into the row's metadata; `undefined` values delete keys. */
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

export interface Artifacts {
  archive(artifactId: ArtifactId): Promise<Artifact>;
  /** Required downstream application, awaited after the outer commit. */
  bind(apply: (artifactId: ArtifactId) => Promise<void>): () => void;
  clearFailedContent(input: {
    readonly artifactId: ArtifactId;
    readonly expectedContentId: ContentId;
  }): Promise<ArtifactResolved>;
  create(input: CreateArtifactInput): Promise<ArtifactResolved>;
  /** Cascades to every Content. Throws ArtifactInUseError when a pin holds one. */
  delete(artifactId: ArtifactId): Promise<boolean>;
  /**
   * Remove a Content. The active row needs a replacement named in the same
   * call. Frozen rows held by a pin throw ArtifactInUseError.
   */
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
  /** Flat timeline of one artifact, oldest first. */
  listContents(
    artifactId: ArtifactId,
    input?: ListContentsInput
  ): Promise<readonly ContentSummary[]>;
  observe(changed: (artifactId: ArtifactId) => void): () => void;
  patchArtifactMetadata(
    artifactId: ArtifactId,
    patch: Readonly<Record<string, unknown>>
  ): Promise<Artifact>;

  readFile(contentId: ContentId, path: string): Promise<FileResolved | null>;
  /**
   * Read a byte interval of a stored file, clamped to [0, byteLength); `null`
   * only when the file is absent. An out-of-bounds range clamps, never throws.
   */
  readFileRange(
    contentId: ContentId,
    path: string,
    range: { readonly start: number; readonly end?: number }
  ): Promise<FileRangeResolved | null>;
  readNamedRoot(
    contentId: ContentId,
    name: string
  ): Promise<FileResolved | null>;
  /** `metadata.entry`, else the only file, else `index.html`, else null. */
  readRoot(contentId: ContentId): Promise<FileResolved | null>;
  readThumbnail(contentId: ContentId): Promise<FileResolved | null>;
  recover(): Promise<void>;
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

  /**
   * Reclaim: delete unfrozen, unpointed, unpinned Contents older than
   * `olderThan`, then every blob no tree names. Eager blob reclaim on
   * ready-row overwrite happens inside `write`; this is the backstop.
   */
  sweep(input: { readonly olderThan: Date }): Promise<{
    readonly contents: number;
    readonly blobs: number;
  }>;
  tag(contentId: ContentId, tag: string | null): Promise<Content>;

  /** Use the supplied handle for every operation in the transaction. */
  transaction<T>(operation: (artifacts: Artifacts) => Promise<T>): Promise<T>;
  unarchive(artifactId: ArtifactId): Promise<Artifact>;

  /**
   * Edit ready Content in place or create the first Content. Frozen Content refuses.
   */
  write(input: WriteInput): Promise<ContentResolved>;
}
