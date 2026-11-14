const BLOB_DIGEST = /^[a-f0-9]{64}$/;

import type { Blob } from "./schema";

export type { Blob, BlobSource, ContentTree, StoredFile } from "./schema";

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
