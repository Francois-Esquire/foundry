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
 * `blobFiles` also stages bytes, so a change takes them in before it enters
 * the store's exclusion. Another `BlobFiles` has nowhere to stage: its bytes
 * are published inside the change, chunk by chunk as a source yields them.
 */
export interface BlobFiles {
  list(): AsyncIterable<string>;
  publish(bytes: Uint8Array): Promise<string>;
  read(
    path: string,
    range: { readonly start: number; readonly end: number }
  ): AsyncIterable<Uint8Array>;
  remove(path: string): Promise<void>;
}

/**
 * @internal The staging area `blobFiles` carries under this key. The package
 * entry does not export it, so staging is not part of the `BlobFiles` a host
 * implements.
 */
export const blobStaging: unique symbol = Symbol("BlobFiles.staging");

/**
 * Where bytes wait before a change publishes them: never listed, read or
 * removed as published files, and owned by the staging instance that wrote
 * them.
 */
export interface BlobStagingArea {
  /** Removes staging left by owners that are gone (a crashed process). */
  abandon(): Promise<void>;
  discard(staged: string): Promise<void>;
  /**
   * Moves a staged file to a fresh published path, durably, and returns
   * that path. The staged name is spent.
   */
  promote(staged: string): Promise<string>;
  /** Writes `bytes` durably to a new staged file and returns its name. */
  stage(bytes: Uint8Array): Promise<string>;
}

/** The staging area of `files`, when it offers one. */
export function stagingOf(
  files: BlobFiles | undefined
): BlobStagingArea | undefined {
  return (files as { readonly [blobStaging]?: BlobStagingArea } | undefined)?.[
    blobStaging
  ];
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
