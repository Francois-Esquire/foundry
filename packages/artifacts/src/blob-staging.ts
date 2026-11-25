import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { CHUNK_BYTES } from "./constants";
import { FileTooLargeError, InvalidArtifactInputError } from "./errors";
import type { BlobId } from "./ids";
import type { EntryInput, EntryInputs, FileInput } from "./substrate";

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

export type ReferenceInput =
  | Extract<FileInput, { readonly blobId: unknown }>
  | Extract<FileInput, { readonly digest: string }>;
export type ByteInput = Exclude<FileInput, ReferenceInput>;

export function isReferenceInput(input: FileInput): input is ReferenceInput {
  return "blobId" in input || "digest" in input;
}

export type StagedChunk = {
  readonly byteLength: number;
  readonly digest: string;
} & (
  | { readonly bytes: Uint8Array }
  | { readonly staged: string }
  | { readonly published: string }
);

export interface Ownership {
  readonly blobId: BlobId;
  readonly exclusive: boolean;
}

export interface StagedBytes {
  readonly byteLength: number;
  readonly chunks: readonly StagedChunk[];
  readonly digest: string;
}

interface StagingLimits {
  readonly files?: BlobFiles;
  readonly maxFileBytes: number;
  readonly maxTreeBytes?: number;
}

export const MAX_STAGING_STREAMS = 8;

export class StagingTurns {
  #free = MAX_STAGING_STREAMS;
  readonly #waiting: (() => void)[] = [];

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#free > 0) {
      this.#free -= 1;
    } else {
      await new Promise<void>((resolve) => {
        this.#waiting.push(resolve);
      });
    }
    try {
      return await work();
    } finally {
      const next = this.#waiting.shift();
      if (next) {
        next();
      } else {
        this.#free += 1;
      }
    }
  }
}

export class BlobStaging {
  readonly #files: BlobFiles | undefined;
  readonly #area: BlobStagingArea | undefined;
  readonly #maxFileBytes: number;
  readonly #maxTreeBytes: number | undefined;
  readonly #turns: StagingTurns;
  readonly #ahead = new Map<
    string,
    { readonly input: ByteInput; readonly bytes: StagedBytes }
  >();
  readonly #waiting = new Set<string>();
  readonly #ownership = new Map<string, Ownership | null>();

  constructor(limits: StagingLimits, turns: StagingTurns = new StagingTurns()) {
    this.#files = limits.files;
    this.#maxTreeBytes = limits.maxTreeBytes;
    this.#turns = turns;
    this.#area = limits.files?.staging;
    this.#maxFileBytes = limits.maxFileBytes;
  }

  recordOwnership(key: string, seen: Ownership | null): void {
    this.#ownership.set(key, seen);
  }

  confirmOwnership(key: string, now: Ownership | null): boolean {
    if (!this.#ownership.has(key)) {
      return true;
    }
    const expected = this.#ownership.get(key) ?? null;
    this.#ownership.delete(key);
    return (
      expected?.blobId === now?.blobId && expected?.exclusive === now?.exclusive
    );
  }

  streamsAhead(entries: EntryInputs | undefined): boolean {
    return byteInputs(entries).some(
      ([, input]) => "source" in input && this.#canStageAhead(input)
    );
  }

  async stageAll(entries: EntryInputs | undefined): Promise<void> {
    const tree = { bytes: 0 };
    const count = (bytes: number) => {
      tree.bytes += bytes;
      if (this.#maxTreeBytes !== undefined && tree.bytes > this.#maxTreeBytes) {
        throw new FileTooLargeError(null, tree.bytes, this.#maxTreeBytes);
      }
    };
    for (const [path, input] of byteInputs(entries)) {
      if (this.#canStageAhead(input)) {
        const stage = () => this.#stage(path, input, { ahead: true, count });
        this.#ahead.set(path, {
          bytes: await ("source" in input ? this.#turns.run(stage) : stage()),
          input,
        });
      }
    }
  }

  take(path: string, input: ByteInput): StagedBytes | undefined {
    const ahead = this.#ahead.get(path);
    if (ahead?.input !== input) {
      return;
    }
    this.#ahead.delete(path);
    return ahead.bytes;
  }

  stage(
    path: string,
    input: ByteInput,
    publish: (bytes: Uint8Array) => Promise<string>
  ): Promise<StagedBytes> {
    return this.#stage(path, input, { ahead: false, publish });
  }

  async promote(staged: string): Promise<string> {
    const area = this.#requireArea();
    this.#waiting.delete(staged);
    try {
      return await area.promote(staged);
    } catch (error) {
      this.#waiting.add(staged);
      throw error;
    }
  }

  async discard(): Promise<void> {
    this.#ahead.clear();
    const area = this.#area;
    if (!area) {
      return;
    }
    for (const staged of [...this.#waiting]) {
      this.#waiting.delete(staged);
      try {
        await area.discard(staged);
      } catch (error) {
        console.error("Staged blob cleanup failed", error);
      }
    }
  }

  #canStageAhead(input: ByteInput): boolean {
    return (
      !("source" in input) ||
      this.#files === undefined ||
      this.#area !== undefined
    );
  }

  async #stage(
    path: string,
    input: ByteInput,
    how:
      | { readonly ahead: true; readonly count: (bytes: number) => void }
      | {
          readonly ahead: false;
          readonly publish: (bytes: Uint8Array) => Promise<string>;
        }
  ): Promise<StagedBytes> {
    let pieces: AsyncIterable<Uint8Array>;
    let declared: number | undefined;
    if ("source" in input) {
      if (input.bytes !== undefined) {
        checkSize(path, input.bytes, this.#maxFileBytes);
      }
      pieces = split(
        checked(
          path,
          input.source,
          this.#maxFileBytes,
          how.ahead ? how.count : undefined
        )
      );
      declared = input.bytes;
    } else {
      const bytes =
        typeof input.bytes === "string"
          ? new TextEncoder().encode(input.bytes)
          : input.bytes;
      checkSize(path, bytes.byteLength, this.#maxFileBytes);
      if (how.ahead) {
        how.count(bytes.byteLength);
      }
      pieces = split([bytes]);
      declared = bytes.byteLength;
    }
    const hold = (piece: Uint8Array): Promise<StagedChunk> => {
      if (how.ahead && this.#area) {
        return this.#stageFile(piece);
      }
      if (!how.ahead && this.#files && "source" in input) {
        return how.publish(piece).then((published) => ({
          ...described(piece),
          published,
        }));
      }
      return Promise.resolve({ ...described(piece), bytes: piece });
    };
    const hash = sha256.create();
    const chunks: StagedChunk[] = [];
    let total = 0;
    try {
      for await (const piece of pieces) {
        total += piece.byteLength;
        hash.update(piece);
        chunks.push(await hold(piece));
      }
      if (chunks.length === 0) {
        chunks.push(await hold(new Uint8Array()));
      }
      if (declared !== undefined && declared !== total) {
        throw new InvalidArtifactInputError(
          "bytes",
          "Stream length differs from declared length"
        );
      }
    } catch (error) {
      await this.#forget(chunks);
      throw error;
    }
    return { byteLength: total, chunks, digest: bytesToHex(hash.digest()) };
  }

  async #stageFile(piece: Uint8Array): Promise<StagedChunk> {
    const staged = await this.#requireArea().stage(piece);
    this.#waiting.add(staged);
    return { ...described(piece), staged };
  }

  async #forget(chunks: readonly StagedChunk[]): Promise<void> {
    const area = this.#area;
    for (const chunk of chunks) {
      if (area && "staged" in chunk) {
        this.#waiting.delete(chunk.staged);
        await area.discard(chunk.staged).catch((error: unknown) => {
          console.error("Staged blob cleanup failed", error);
        });
      }
    }
  }

  #requireArea(): BlobStagingArea {
    if (!this.#area) {
      throw new Error("Staged blob requires a staging area");
    }
    return this.#area;
  }
}

export async function abandonStaging(
  files: BlobFiles | undefined
): Promise<void> {
  await files?.staging?.abandon();
}

export function checkSize(path: string, size: number, max: number): void {
  if (size > max) {
    throw new FileTooLargeError(path, size, max);
  }
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new InvalidArtifactInputError("bytes", "Invalid byte length");
  }
}

function digestOf(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

function described(piece: Uint8Array) {
  return { byteLength: piece.byteLength, digest: digestOf(piece) };
}

function byteInputs(entries: EntryInputs | undefined): [string, ByteInput][] {
  return Object.entries(entries ?? {}).flatMap(
    ([path, entry]): [string, ByteInput][] =>
      isByteInput(entry) ? [[path, entry]] : []
  );
}

function isByteInput(entry: EntryInput): entry is ByteInput {
  return (
    (entry.type === undefined || entry.type === "file") &&
    !isReferenceInput(entry as FileInput)
  );
}

async function* checked(
  path: string,
  source: AsyncIterable<Uint8Array>,
  max: number,
  count?: (bytes: number) => void
): AsyncIterable<Uint8Array> {
  let size = 0;
  for await (const bytes of source) {
    size += bytes.byteLength;
    checkSize(path, size, max);
    count?.(bytes.byteLength);
    yield bytes;
  }
}

async function* split(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>
): AsyncIterable<Uint8Array> {
  let buffer = new Uint8Array(CHUNK_BYTES);
  let filled = 0;
  for await (const bytes of source) {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const take = Math.min(CHUNK_BYTES - filled, bytes.byteLength - offset);
      buffer.set(bytes.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === CHUNK_BYTES) {
        yield buffer;
        buffer = new Uint8Array(CHUNK_BYTES);
        filled = 0;
      }
    }
  }
  if (filled > 0) {
    yield buffer.slice(0, filled);
  }
}
