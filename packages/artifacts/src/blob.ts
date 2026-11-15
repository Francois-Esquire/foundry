import type { z } from "zod";

import { blobIdSchema } from "./ref";
import type { Blob } from "./schema";
import {
  blobChunksSchema,
  blobPathSchema,
  byteCountSchema,
  sha256DigestSchema,
} from "./schema";

export type { Blob, BlobSource, ContentTree, StoredFile } from "./schema";

/**
 * Paths are store-owned, immutable backing files, never editable working files.
 *
 * `staging` is optional. With it, `create`, `write` and `revise` take their
 * bytes in before the change enters the store's exclusion, and the change
 * only promotes them; `blobFiles` offers it. Without it, the change
 * publishes the bytes itself, inside that exclusion, chunk by chunk as a
 * source yields them.
 */
export interface BlobFiles {
  list(): AsyncIterable<string>;
  publish(bytes: Uint8Array): Promise<string>;
  read(
    path: string,
    range: { readonly start: number; readonly end: number }
  ): AsyncIterable<Uint8Array>;
  remove(path: string): Promise<void>;
  readonly staging?: BlobStagingArea;
}

/**
 * Where bytes wait before a change publishes them: never listed, read or
 * removed as published files. Each staged name belongs to the area that
 * wrote it.
 */
export interface BlobStagingArea {
  /** Removes staging its owners abandoned (a crashed process's). */
  abandon(): Promise<void>;
  /** Removes a staged file; one already gone is no error. */
  discard(staged: string): Promise<void>;
  /**
   * Moves a staged file to a fresh published path, durably, and returns
   * that path; the staged name is spent. A failure leaves neither the
   * published file nor, once discarded, the staged one.
   */
  promote(staged: string): Promise<string>;
  /**
   * Writes `bytes` durably to a new staged file and returns its name. A
   * failure leaves no file behind.
   */
  stage(bytes: Uint8Array): Promise<string>;
}

/**
 * Throws unless the blob's fields satisfy the blob schema's components and
 * the checks that span fields: one source, inline bytes matching
 * `byteLength`, and no chunk naming the blob itself.
 */
export function validateBlob(blob: Blob): void {
  const sources = [blob.bytes, blob.path, blob.chunks].filter(
    (value) => value !== undefined
  );
  if (
    !matches(blobIdSchema, blob.id) ||
    sources.length !== 1 ||
    !matches(sha256DigestSchema, blob.digest) ||
    !matches(byteCountSchema, blob.byteLength)
  ) {
    throw new Error(`Invalid blob: ${blob.id}`);
  }
  if (blob.bytes !== undefined && blob.bytes.byteLength !== blob.byteLength) {
    throw new Error(`Blob size mismatch: ${blob.id}`);
  }
  if (blob.path !== undefined && !matches(blobPathSchema, blob.path)) {
    throw new Error(`Invalid blob path: ${blob.id}`);
  }
  if (
    blob.chunks !== undefined &&
    (!matches(blobChunksSchema, blob.chunks) || blob.chunks.includes(blob.id))
  ) {
    throw new Error(`Invalid blob chunks: ${blob.id}`);
  }
}

function matches(schema: z.ZodType, value: unknown): boolean {
  return schema.safeParse(value).success;
}
