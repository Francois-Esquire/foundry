const BLOB_DIGEST = /^[a-f0-9]{64}$/;

import type { FileNode, StorageNode } from "@foundry/core/storage";

import type { BlobId } from "./ref";

export type BlobSource =
  | {
      readonly bytes: Uint8Array;
      readonly path?: never;
      readonly chunks?: never;
    }
  | { readonly path: string; readonly bytes?: never; readonly chunks?: never }
  | {
      readonly chunks: readonly BlobId[];
      readonly bytes?: never;
      readonly path?: never;
    };

/**
 * A stored object. File entries reference it by `id`; `digest` and
 * `byteLength` describe the bytes it holds now. An object referenced by one
 * file entry alone is rewritten in place when that entry's bytes change, so
 * its id stays stable. A shared object is never rewritten: the editing entry
 * gets a new object, which keeps frozen Content immutable.
 *
 * Large objects hold `chunks`: immutable leaf blobs of `CHUNK_BYTES` each.
 */
export type Blob = BlobSource & {
  readonly id: BlobId;
  readonly digest: string;
  readonly byteLength: number;
  readonly createdAt: Date;
};

export interface StoredFile extends FileNode {
  readonly blobId: BlobId;
}

export type ContentTree = Readonly<
  Record<string, StoredFile | Exclude<StorageNode, FileNode>>
>;

/** Paths are store-owned, immutable backing files, never editable working files. */
export interface BlobFiles {
  list(): AsyncIterable<string>;
  publish(bytes: Uint8Array): Promise<string>;
  read(
    path: string,
    range: { readonly start: number; readonly end: number }
  ): AsyncIterable<Uint8Array>;
  remove(path: string): Promise<void>;
}

export function validateBlob(blob: Blob): void {
  const sources = [blob.bytes, blob.path, blob.chunks].filter(
    (value) => value !== undefined
  );
  if (
    !blob.id ||
    sources.length !== 1 ||
    !BLOB_DIGEST.test(blob.digest) ||
    !Number.isSafeInteger(blob.byteLength) ||
    blob.byteLength < 0
  ) {
    throw new Error(`Invalid blob: ${blob.id}`);
  }
  if (blob.bytes !== undefined && blob.bytes.byteLength !== blob.byteLength) {
    throw new Error(`Blob size mismatch: ${blob.id}`);
  }
  if (blob.path !== undefined && (!blob.path || blob.path.includes("\0"))) {
    throw new Error(`Invalid blob path: ${blob.id}`);
  }
  if (
    blob.chunks !== undefined &&
    (blob.chunks.length === 0 || blob.chunks.includes(blob.id))
  ) {
    throw new Error(`Invalid blob chunks: ${blob.id}`);
  }
}
