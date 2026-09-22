import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { Blob, BlobFiles } from "./blob";
import { CHUNK_BYTES } from "./constants";
import { FileTooLargeError, InvalidArtifactInputError } from "./errors";
import type { BlobId } from "./ref";
import { blobIdSchema } from "./ref";
import type { ArtifactStore } from "./store";
import type { FileInput } from "./substrate";

export class BlobRepository {
  private readonly store: ArtifactStore;
  private readonly files: BlobFiles | undefined;
  private readonly published: Set<string>;
  private readonly retired: Set<string>;
  private readonly maxFileBytes: number;
  constructor(
    store: ArtifactStore,
    files: BlobFiles | undefined,
    published: Set<string>,
    retired: Set<string>,
    maxFileBytes: number
  ) {
    this.store = store;
    this.files = files;
    this.published = published;
    this.retired = retired;
    this.maxFileBytes = maxFileBytes;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep streamed validation, deduplication, and blob publication in their existing order.
  async put(path: string, input: FileInput, reuse?: BlobId): Promise<Blob> {
    if ("blobId" in input) {
      const blob = await this.require(input.blobId);
      this.checkSize(path, blob.byteLength);
      return blob;
    }
    if ("digest" in input) {
      const blob = await this.store.findBlob(input.digest);
      if (blob?.byteLength !== input.bytes) {
        throw new InvalidArtifactInputError(
          "digest",
          "Missing blob or mismatched byte length"
        );
      }
      this.checkSize(path, blob.byteLength);
      return blob;
    }
    if (!("source" in input)) {
      const bytes =
        typeof input.bytes === "string"
          ? new TextEncoder().encode(input.bytes)
          : input.bytes;
      this.checkSize(path, bytes.byteLength);
      return this.leaf(bytes, reuse);
    }
    if (input.bytes !== undefined) {
      this.checkSize(path, input.bytes);
    }
    const hash = sha256.create();
    const chunks: BlobId[] = [];
    let total = 0;
    let pending: Uint8Array | undefined;
    for await (const bytes of split(
      this.checkedSource(path, input.source),
      CHUNK_BYTES
    )) {
      total += bytes.byteLength;
      this.checkSize(path, total);
      hash.update(bytes);
      if (pending) {
        chunks.push((await this.leaf(pending)).id);
      }
      pending = bytes;
    }
    if (input.bytes !== undefined && input.bytes !== total) {
      throw new InvalidArtifactInputError(
        "bytes",
        "Stream length differs from declared length"
      );
    }
    if (chunks.length === 0) {
      return this.leaf(pending ?? new Uint8Array(), reuse);
    }
    if (!pending) {
      throw new Error("Stream manifest requires a final chunk");
    }
    chunks.push((await this.leaf(pending)).id);
    const reusable = reuse && chunks.includes(reuse) ? undefined : reuse;
    const digest = bytesToHex(hash.digest());
    const existing = await this.store.findBlob(digest);
    if (existing) {
      return existing;
    }
    const previous = reusable ? await this.require(reusable) : null;
    const blob: Blob = {
      byteLength: total,
      chunks,
      createdAt: previous?.createdAt ?? new Date(),
      digest,
      id: reusable ?? blobIdSchema.parse(crypto.randomUUID()),
    };
    await this.store.putBlob(blob);
    if (previous?.path) {
      this.retired.add(previous.path);
    }
    return blob;
  }

  async require(id: BlobId): Promise<Blob> {
    const blob = await this.store.getBlob(id);
    if (!blob) {
      throw new InvalidArtifactInputError("blobId", `Missing blob "${id}"`);
    }
    return blob;
  }

  async *read(
    blob: Blob,
    start: number,
    end: number
  ): AsyncIterable<Uint8Array> {
    if (blob.bytes !== undefined) {
      if (start < end) {
        yield blob.bytes.slice(start, end);
      }
      return;
    }
    if (blob.path !== undefined) {
      if (!this.files) {
        throw new Error("Filesystem blob requires BlobFiles");
      }
      let length = 0;
      for await (const bytes of this.files.read(blob.path, { end, start })) {
        length += bytes.byteLength;
        yield bytes;
      }
      if (length !== end - start) {
        throw new Error(`Truncated blob: ${blob.id}`);
      }
      return;
    }
    if (blob.chunks.length !== Math.ceil(blob.byteLength / CHUNK_BYTES)) {
      throw new Error(`Invalid manifest size: ${blob.id}`);
    }
    if (start >= end) {
      return;
    }
    for (
      let index = Math.floor(start / CHUNK_BYTES);
      index <= Math.floor((end - 1) / CHUNK_BYTES);
      index += 1
    ) {
      const id = blob.chunks[index];
      if (id === undefined) {
        throw new Error(`Missing manifest chunk: ${blob.id}`);
      }
      const chunk = await this.require(id);
      if (chunk.chunks !== undefined) {
        throw new Error("Nested blob manifests are invalid");
      }
      const offset = index * CHUNK_BYTES;
      if (
        chunk.byteLength !== Math.min(CHUNK_BYTES, blob.byteLength - offset)
      ) {
        throw new Error(`Invalid manifest chunk size: ${id}`);
      }
      yield* this.read(
        chunk,
        Math.max(0, start - offset),
        Math.min(chunk.byteLength, end - offset)
      );
    }
  }

  async reclaim(): Promise<number> {
    let count = 0;
    let removed: boolean;
    do {
      removed = false;
      for (const blob of await this.store.listBlobs()) {
        if (await this.store.isBlobReferenced(blob.id)) {
          continue;
        }
        await this.store.deleteBlob(blob.id);
        if (blob.path) {
          this.retired.add(blob.path);
        }
        count += 1;
        removed = true;
      }
    } while (removed);
    return count;
  }

  private async leaf(bytes: Uint8Array, reuse?: BlobId): Promise<Blob> {
    const digest = bytesToHex(sha256(bytes));
    const existing = await this.store.findBlob(digest);
    if (existing) {
      return existing;
    }
    const previous = reuse ? await this.require(reuse) : null;
    let source: { readonly path: string } | { readonly bytes: Uint8Array };
    if (this.files) {
      const path = await this.files.publish(bytes);
      this.published.add(path);
      source = { path };
    } else {
      source = { bytes: bytes.slice() };
    }
    const blob: Blob = {
      byteLength: bytes.byteLength,
      createdAt: previous?.createdAt ?? new Date(),
      digest,
      id: reuse ?? blobIdSchema.parse(crypto.randomUUID()),
      ...source,
    };
    await this.store.putBlob(blob);
    if (previous?.path) {
      this.retired.add(previous.path);
    }
    return blob;
  }

  private checkSize(path: string, size: number): void {
    if (size > this.maxFileBytes) {
      throw new FileTooLargeError(path, size, this.maxFileBytes);
    }
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new InvalidArtifactInputError("bytes", "Invalid byte length");
    }
  }

  private async *checkedSource(
    path: string,
    source: AsyncIterable<Uint8Array>
  ): AsyncIterable<Uint8Array> {
    let size = 0;
    for await (const bytes of source) {
      size += bytes.byteLength;
      this.checkSize(path, size);
      yield bytes;
    }
  }
}

async function* split(
  source: AsyncIterable<Uint8Array>,
  size: number
): AsyncIterable<Uint8Array> {
  let buffer = new Uint8Array(size);
  let filled = 0;
  for await (const bytes of source) {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const take = Math.min(size - filled, bytes.byteLength - offset);
      buffer.set(bytes.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === size) {
        yield buffer;
        buffer = new Uint8Array(size);
        filled = 0;
      }
    }
  }
  if (filled > 0) {
    yield buffer.slice(0, filled);
  }
}
