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

export interface BlobStagingArea {
  abandon(): Promise<void>;
  discard(staged: string): Promise<void>;
  promote(staged: string): Promise<string>;
  stage(bytes: Uint8Array): Promise<string>;
}

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
