import type {
  BlobFiles,
  ByteInput,
  ExternalBlobInput,
  ReferenceInput,
  StagedBytes,
  StagedChunk,
} from "./blob-staging";
import { BlobStaging, checkSize } from "./blob-staging";
import type { ArtifactChange } from "./change";
import { InvalidArtifactInputError } from "./errors";
import type { BlobId } from "./ids";
import { blobIdSchema } from "./ids";
import type { Blob, BlobSource } from "./schema";

export type { ByteInput, ReferenceInput } from "./blob-staging";
// biome-ignore lint/performance/noBarrelFile: A compatibility re-export at the path consumers imported it from.
export { isReferenceInput } from "./blob-staging";

const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const NUL_FREE_NONEMPTY = /^[^\0]+$/;
const PATH_SEGMENTS = /[\\/]/;

function isValidExternalPath(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed !== value ||
    !NUL_FREE_NONEMPTY.test(value) ||
    value.startsWith("/") ||
    value.startsWith("\\")
  ) {
    return false;
  }
  return !value.split(PATH_SEGMENTS).includes("..");
}

export interface BlobEffects {
  readonly published: Set<string>;
  readonly released: Set<BlobId>;
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
    yield* readFileBlob(blob, blob.path, start, end, reader);
    return;
  }
  yield* readChunkedBlob(blob, start, end, reader);
}

async function* readFileBlob(
  blob: Blob,
  path: string,
  start: number,
  end: number,
  reader: BlobReader
): AsyncIterable<Uint8Array> {
  if (!reader.files) {
    throw new Error("Filesystem blob requires BlobFiles");
  }
  let length = 0;
  for await (const bytes of reader.files.read(path, { end, start })) {
    length += bytes.byteLength;
    yield bytes;
  }
  if (length !== end - start) {
    throw new Error(`Truncated blob: ${blob.id}`);
  }
}

async function resolveChunkLayout(
  blob: Blob & { readonly chunks: readonly BlobId[] },
  reader: BlobReader
): Promise<{ readonly chunkSize: number; readonly firstChunk: Blob }> {
  const [firstId] = blob.chunks;
  if (firstId === undefined) {
    throw new Error(`Missing manifest chunk: ${blob.id}`);
  }
  const firstChunk = await reader.require(firstId);
  if (firstChunk.chunks !== undefined) {
    throw new Error("Nested blob manifests are invalid");
  }
  const chunkSize = firstChunk.byteLength;
  if (
    chunkSize <= 0 ||
    blob.chunks.length !== Math.ceil(blob.byteLength / chunkSize)
  ) {
    throw new Error(`Invalid manifest size: ${blob.id}`);
  }
  return { chunkSize, firstChunk };
}

async function* readChunkedBlob(
  blob: Blob & { readonly chunks: readonly BlobId[] },
  start: number,
  end: number,
  reader: BlobReader
): AsyncIterable<Uint8Array> {
  if (blob.chunks.length === 0) {
    if (blob.byteLength !== 0) {
      throw new Error(`Invalid manifest size: ${blob.id}`);
    }
    return;
  }
  if (start >= end) {
    return;
  }
  const { chunkSize, firstChunk } = await resolveChunkLayout(blob, reader);
  for (
    let index = Math.floor(start / chunkSize);
    index <= Math.floor((end - 1) / chunkSize);
    index += 1
  ) {
    const id = blob.chunks[index];
    if (id === undefined) {
      throw new Error(`Missing manifest chunk: ${blob.id}`);
    }
    const chunk =
      index === 0 && firstChunk !== undefined
        ? firstChunk
        : await reader.require(id);
    if (chunk.chunks !== undefined) {
      throw new Error("Nested blob manifests are invalid");
    }
    const offset = index * chunkSize;
    if (chunk.byteLength !== Math.min(chunkSize, blob.byteLength - offset)) {
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
  readonly #clock: () => Date;
  readonly #effects: BlobEffects;
  readonly #id: () => string;
  readonly #maxFileBytes: number;
  readonly #staging: BlobStaging;

  constructor(
    change: ArtifactChange,
    effects: BlobEffects,
    options: {
      readonly chunkBytes?: number;
      readonly clock?: () => Date;
      readonly files?: BlobFiles;
      readonly id?: () => string;
      readonly maxFileBytes: number;
      readonly staging?: BlobStaging;
    }
  ) {
    this.#change = change;
    this.#clock = options.clock ?? (() => new Date());
    this.#effects = effects;
    this.#id = options.id ?? (() => crypto.randomUUID());
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

  checkExternal(path: string, input: ExternalBlobInput): void {
    checkSize(path, input.bytes, this.#maxFileBytes);
    if (!isValidExternalPath(input.path)) {
      throw new InvalidArtifactInputError(
        "path",
        "External blob path must be a valid non-empty storage key without traversal"
      );
    }
    if (!SHA256_DIGEST.test(input.digest)) {
      throw new InvalidArtifactInputError(
        "digest",
        "External blob digest must be a 64-character lowercase SHA-256 hex string"
      );
    }
  }

  async attach(path: string, input: ExternalBlobInput): Promise<Blob> {
    this.checkExternal(path, input);
    const existingByPath = await this.#change.findBlobByPath(input.path);
    if (existingByPath !== null) {
      if (
        existingByPath.digest === input.digest &&
        existingByPath.byteLength === input.bytes
      ) {
        this.#effects.retired.delete(input.path);
        return existingByPath;
      }
      throw new Error("Blob backing path already belongs to another blob");
    }
    const existingByDigest = await this.#change.findBlob(input.digest);
    if (existingByDigest?.byteLength === input.bytes) {
      if (existingByDigest.path !== undefined) {
        this.#effects.retired.delete(existingByDigest.path);
      }
      return existingByDigest;
    }
    const blob: Blob = {
      byteLength: input.bytes,
      createdAt: this.#clock(),
      digest: input.digest,
      id: blobIdSchema.parse(this.#id()),
      path: input.path,
    };
    await this.#change.putBlob(blob);
    this.#effects.retired.delete(input.path);
    return blob;
  }

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

  reclaim(): Promise<number> {
    const released = [...this.#effects.released];
    this.#effects.released.clear();
    return this.#collect(released);
  }

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
      createdAt: previous?.createdAt ?? this.#clock(),
      digest,
      id: previous?.id ?? blobIdSchema.parse(this.#id()),
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

  async #leaf(chunk: StagedChunk, exclude: BlobId | undefined): Promise<Blob> {
    const existing = await this.#change.findBlob(chunk.digest);
    if (existing && existing.chunks === undefined && existing.id !== exclude) {
      this.#unused([chunk]);
      return existing;
    }
    const blob: Blob = {
      byteLength: chunk.byteLength,
      createdAt: this.#clock(),
      digest: chunk.digest,
      id: blobIdSchema.parse(this.#id()),
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

  #retire(blob: Blob): void {
    if (blob.path) {
      this.#effects.retired.add(blob.path);
    }
    this.release(blob.chunks ?? []);
  }

  async #collect(queue: BlobId[]): Promise<number> {
    let count = 0;
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
