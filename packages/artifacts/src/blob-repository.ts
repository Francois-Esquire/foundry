import type { Blob, BlobFiles, BlobSource } from "./blob";
import type {
  ByteInput,
  ReferenceInput,
  StagedBytes,
  StagedChunk,
} from "./blob-staging";
import { BlobStaging, checkSize } from "./blob-staging";
import type { ArtifactChange } from "./change";
import { CHUNK_BYTES } from "./constants";
import { InvalidArtifactInputError } from "./errors";
import type { BlobId } from "./ref";
import { blobIdSchema } from "./ref";

export type { ByteInput, ReferenceInput } from "./blob-staging";
// biome-ignore lint/performance/noBarrelFile: A compatibility re-export at the path consumers imported it from.
export { isReferenceInput } from "./blob-staging";

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
  store: Pick<ArtifactChange, "getBlob">,
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

export class BlobRepository implements BlobReader {
  readonly files: BlobFiles | undefined;
  readonly #change: ArtifactChange;
  readonly #effects: BlobEffects;
  readonly #maxFileBytes: number;
  readonly #staging: BlobStaging;

  constructor(
    change: ArtifactChange,
    effects: BlobEffects,
    options: {
      readonly files?: BlobFiles;
      readonly maxFileBytes: number;
      readonly staging?: BlobStaging;
    }
  ) {
    this.#change = change;
    this.#effects = effects;
    this.files = options.files;
    this.#maxFileBytes = options.maxFileBytes;
    this.#staging = options.staging ?? new BlobStaging(options);
  }

  require(id: BlobId): Promise<Blob> {
    return requireBlob(this.#change, id);
  }

  read(blob: Blob, start: number, end: number): AsyncIterable<Uint8Array> {
    return readBlob(blob, start, end, this);
  }

  /** The existing object a reference input names. */
  async resolve(path: string, input: ReferenceInput): Promise<Blob> {
    if ("blobId" in input) {
      const blob = await this.require(input.blobId);
      checkSize(path, blob.byteLength, this.#maxFileBytes);
      return blob;
    }
    const blob = await this.#change.findBlob(input.digest);
    if (blob?.byteLength !== input.bytes) {
      throw new InvalidArtifactInputError(
        "digest",
        "Missing blob or mismatched byte length"
      );
    }
    checkSize(path, blob.byteLength, this.#maxFileBytes);
    return blob;
  }

  async write(path: string, input: ByteInput, owned?: BlobId): Promise<Blob> {
    const staged =
      this.#staging.take(path, input) ??
      (await this.#staging.stage(path, input, (bytes) => this.#publish(bytes)));
    return this.#store(staged, owned);
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
    return this.#collect((await this.#change.listBlobs()).map(({ id }) => id));
  }

  release(ids: Iterable<BlobId>): void {
    for (const id of ids) {
      this.#effects.released.add(id);
    }
  }

  async #store(staged: StagedBytes, owned: BlobId | undefined): Promise<Blob> {
    const { digest } = staged;
    const previous = owned
      ? await this.require(owned)
      : await this.#change.findBlob(digest);
    if (previous?.digest === digest) {
      this.#unused(staged.chunks);
      return previous;
    }
    const [only, ...more] = staged.chunks;
    const stored: BlobSource =
      only !== undefined && more.length === 0
        ? await this.#place(only)
        : {
            chunks: await this.#leaves(staged.chunks, owned),
          };
    const blob: Blob = {
      byteLength: staged.byteLength,
      createdAt: previous?.createdAt ?? new Date(),
      digest,
      id: previous?.id ?? blobIdSchema.parse(crypto.randomUUID()),
      ...stored,
    };
    await this.#change.putBlob(blob);
    if (previous) {
      this.#retire(previous);
    }
    return blob;
  }

  async #leaves(
    chunks: readonly StagedChunk[],
    exclude: BlobId | undefined
  ): Promise<BlobId[]> {
    const ids: BlobId[] = [];
    for (const chunk of chunks) {
      ids.push((await this.#leaf(chunk, exclude)).id);
    }
    return ids;
  }

  /** An immutable chunk; never the object being rewritten, which would contain itself. */
  async #leaf(chunk: StagedChunk, exclude: BlobId | undefined): Promise<Blob> {
    const existing = await this.#change.findBlob(chunk.digest);
    if (existing && existing.id !== exclude) {
      this.#unused([chunk]);
      return existing;
    }
    const blob: Blob = {
      byteLength: chunk.byteLength,
      createdAt: new Date(),
      digest: chunk.digest,
      id: blobIdSchema.parse(crypto.randomUUID()),
      ...(await this.#place(chunk)),
    };
    await this.#change.putBlob(blob);
    return blob;
  }

  async #place(
    chunk: StagedChunk
  ): Promise<{ readonly path: string } | { readonly bytes: Uint8Array }> {
    if ("staged" in chunk) {
      const path = await this.#staging.promote(chunk.staged);
      this.#effects.published.add(path);
      return { path };
    }
    if ("published" in chunk) {
      return { path: chunk.published };
    }
    if (!this.files) {
      return { bytes: chunk.bytes.slice() };
    }
    return { path: await this.#publish(chunk.bytes) };
  }

  async #publish(bytes: Uint8Array): Promise<string> {
    if (!this.files) {
      throw new Error("Publishing a blob requires BlobFiles");
    }
    const path = await this.files.publish(bytes);
    this.#effects.published.add(path);
    return path;
  }

  #unused(chunks: readonly StagedChunk[]): void {
    for (const chunk of chunks) {
      if ("published" in chunk) {
        this.#effects.retired.add(chunk.published);
      }
    }
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
      const blob = await this.#change.getBlob(id);
      if (!blob || (await this.#change.isBlobReferenced(id))) {
        continue;
      }
      await this.#change.deleteBlob(id);
      if (blob.path) {
        this.#effects.retired.add(blob.path);
      }
      queue.push(...(blob.chunks ?? []));
      count += 1;
    }
    return count;
  }
}
