import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { Blob, BlobFiles, BlobSource } from "./blob";
import { CHUNK_BYTES } from "./constants";
import { FileTooLargeError, InvalidArtifactInputError } from "./errors";
import type { BlobId } from "./ref";
import { blobIdSchema } from "./ref";
import type { ArtifactStoreTransaction } from "./store";
import type { FileInput } from "./substrate";

/** File inputs that name an existing object instead of supplying bytes. */
export type ReferenceInput =
  | Extract<FileInput, { readonly blobId: BlobId }>
  | Extract<FileInput, { readonly digest: string }>;
export type ByteInput = Exclude<FileInput, ReferenceInput>;

export function isReferenceInput(input: FileInput): input is ReferenceInput {
  return "blobId" in input || "digest" in input;
}

/** What one operation did to backing storage, settled by the manager. */
export interface BlobEffects {
  /** Backing files written by the operation; removed on rollback. */
  readonly published: Set<string>;
  /** Blobs that may have lost their last reference; reclaimed before commit. */
  readonly released: Set<BlobId>;
  /** Backing files no committed record names; removed after commit. */
  readonly retired: Set<string>;
}

export interface BlobReader {
  readonly files: BlobFiles | undefined;
  require(id: BlobId): Promise<Blob>;
}

export async function requireBlob(
  store: Pick<ArtifactStoreTransaction, "getBlob">,
  id: BlobId
): Promise<Blob> {
  const blob = await store.getBlob(id);
  if (!blob) {
    throw new InvalidArtifactInputError("blobId", `Missing blob "${id}"`);
  }
  return blob;
}

/** Yield `blob`'s bytes in [start, end). Chunks load only as the consumer pulls. */
export async function* readBlob(
  blob: Blob,
  start: number,
  end: number,
  reader: BlobReader
): AsyncIterable<Uint8Array> {
  if (blob.bytes !== undefined) {
    if (start < end) {
      yield blob.bytes.slice(start, end);
    }
    return;
  }
  if (blob.path !== undefined) {
    if (!reader.files) {
      throw new Error("Filesystem blob requires BlobFiles");
    }
    let length = 0;
    for await (const bytes of reader.files.read(blob.path, { end, start })) {
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
    const chunk = await reader.require(id);
    if (chunk.chunks !== undefined) {
      throw new Error("Nested blob manifests are invalid");
    }
    const offset = index * CHUNK_BYTES;
    if (chunk.byteLength !== Math.min(CHUNK_BYTES, blob.byteLength - offset)) {
      throw new Error(`Invalid manifest chunk size: ${id}`);
    }
    yield* readBlob(
      chunk,
      Math.max(0, start - offset),
      Math.min(chunk.byteLength, end - offset),
      reader
    );
  }
}

/** The objects behind file entries, within one store transaction. */
export class BlobRepository implements BlobReader {
  readonly files: BlobFiles | undefined;
  readonly #store: ArtifactStoreTransaction;
  readonly #effects: BlobEffects;
  readonly #maxFileBytes: number;

  constructor(
    store: ArtifactStoreTransaction,
    effects: BlobEffects,
    options: { readonly files?: BlobFiles; readonly maxFileBytes: number }
  ) {
    this.#store = store;
    this.#effects = effects;
    this.files = options.files;
    this.#maxFileBytes = options.maxFileBytes;
  }

  require(id: BlobId): Promise<Blob> {
    return requireBlob(this.#store, id);
  }

  read(blob: Blob, start: number, end: number): AsyncIterable<Uint8Array> {
    return readBlob(blob, start, end, this);
  }

  /** The existing object a reference input names. */
  async resolve(path: string, input: ReferenceInput): Promise<Blob> {
    if ("blobId" in input) {
      const blob = await this.require(input.blobId);
      this.#checkSize(path, blob.byteLength);
      return blob;
    }
    const blob = await this.#store.findBlob(input.digest);
    if (blob?.byteLength !== input.bytes) {
      throw new InvalidArtifactInputError(
        "digest",
        "Missing blob or mismatched byte length"
      );
    }
    this.#checkSize(path, blob.byteLength);
    return blob;
  }

  /**
   * Store a file entry's bytes. `owned` names the entry's previous object when
   * nothing else references it; the bytes rewrite that object in place.
   * Otherwise they join an object already holding the same bytes, or a new one.
   */
  async write(path: string, input: ByteInput, owned?: BlobId): Promise<Blob> {
    if ("source" in input) {
      if (input.bytes !== undefined) {
        this.#checkSize(path, input.bytes);
      }
      return this.#ingest(
        this.#checked(path, input.source),
        owned,
        input.bytes
      );
    }
    const bytes =
      typeof input.bytes === "string"
        ? new TextEncoder().encode(input.bytes)
        : input.bytes;
    this.#checkSize(path, bytes.byteLength);
    // Known bytes can match an existing object before any chunk is written.
    if (!owned && bytes.byteLength > CHUNK_BYTES) {
      const existing = await this.#store.findBlob(digestOf(bytes));
      if (existing) {
        return existing;
      }
    }
    return this.#ingest([bytes], owned, bytes.byteLength);
  }

  /** Delete released blobs nothing references, then the chunks they held. */
  reclaim(): Promise<number> {
    const released = [...this.#effects.released];
    this.#effects.released.clear();
    return this.#collect(released);
  }

  /** Delete every blob nothing references. */
  async reclaimAll(): Promise<number> {
    this.#effects.released.clear();
    return this.#collect((await this.#store.listBlobs()).map(({ id }) => id));
  }

  release(ids: Iterable<BlobId>): void {
    for (const id of ids) {
      this.#effects.released.add(id);
    }
  }

  async #ingest(
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    owned: BlobId | undefined,
    declaredBytes: number | undefined
  ): Promise<Blob> {
    const hash = sha256.create();
    const chunks: BlobId[] = [];
    let total = 0;
    let pending: Uint8Array | undefined;
    for await (const piece of split(source, CHUNK_BYTES)) {
      if (pending) {
        chunks.push((await this.#leaf(pending, owned)).id);
      }
      total += piece.byteLength;
      hash.update(piece);
      pending = piece;
    }
    const last = pending ?? new Uint8Array();
    if (declaredBytes !== undefined && declaredBytes !== total) {
      throw new InvalidArtifactInputError(
        "bytes",
        "Stream length differs from declared length"
      );
    }
    const digest = bytesToHex(hash.digest());
    const previous = owned
      ? await this.require(owned)
      : await this.#store.findBlob(digest);
    if (previous?.digest === digest) {
      this.release(chunks);
      return previous;
    }
    const stored: BlobSource =
      chunks.length === 0
        ? await this.#publish(last)
        : { chunks: [...chunks, (await this.#leaf(last, owned)).id] };
    const blob: Blob = {
      byteLength: total,
      createdAt: previous?.createdAt ?? new Date(),
      digest,
      id: previous?.id ?? blobIdSchema.parse(crypto.randomUUID()),
      ...stored,
    };
    await this.#store.putBlob(blob);
    if (previous) {
      this.#retire(previous);
    }
    return blob;
  }

  /** An immutable chunk; never the object being rewritten, which would contain itself. */
  async #leaf(bytes: Uint8Array, exclude: BlobId | undefined): Promise<Blob> {
    const digest = digestOf(bytes);
    const existing = await this.#store.findBlob(digest);
    if (existing && existing.id !== exclude) {
      return existing;
    }
    const blob: Blob = {
      byteLength: bytes.byteLength,
      createdAt: new Date(),
      digest,
      id: blobIdSchema.parse(crypto.randomUUID()),
      ...(await this.#publish(bytes)),
    };
    await this.#store.putBlob(blob);
    return blob;
  }

  async #publish(
    bytes: Uint8Array
  ): Promise<{ readonly path: string } | { readonly bytes: Uint8Array }> {
    if (!this.files) {
      return { bytes: bytes.slice() };
    }
    const path = await this.files.publish(bytes);
    this.#effects.published.add(path);
    return { path };
  }

  /** The previous bytes of a rewritten or deleted object are no longer named. */
  #retire(blob: Blob): void {
    if (blob.path) {
      this.#effects.retired.add(blob.path);
    }
    this.release(blob.chunks ?? []);
  }

  async #collect(queue: BlobId[]): Promise<number> {
    let count = 0;
    // A chunk checked before its manifest is re-queued when the manifest goes.
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      const blob = await this.#store.getBlob(id);
      if (!blob || (await this.#store.isBlobReferenced(id))) {
        continue;
      }
      await this.#store.deleteBlob(id);
      if (blob.path) {
        this.#effects.retired.add(blob.path);
      }
      queue.push(...(blob.chunks ?? []));
      count += 1;
    }
    return count;
  }

  #checkSize(path: string, size: number): void {
    if (size > this.#maxFileBytes) {
      throw new FileTooLargeError(path, size, this.#maxFileBytes);
    }
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new InvalidArtifactInputError("bytes", "Invalid byte length");
    }
  }

  async *#checked(
    path: string,
    source: AsyncIterable<Uint8Array>
  ): AsyncIterable<Uint8Array> {
    let size = 0;
    for await (const bytes of source) {
      size += bytes.byteLength;
      this.#checkSize(path, size);
      yield bytes;
    }
  }
}

function digestOf(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

async function* split(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
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
