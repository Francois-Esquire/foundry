import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { BlobFiles, BlobStagingArea } from "./blob";
import { stagingOf } from "./blob";
import { CHUNK_BYTES } from "./constants";
import { FileTooLargeError, InvalidArtifactInputError } from "./errors";
import type { EntryInput, EntryInputs, FileInput } from "./substrate";

/** File inputs that name an existing object instead of supplying bytes. */
export type ReferenceInput =
  | Extract<FileInput, { readonly blobId: unknown }>
  | Extract<FileInput, { readonly digest: string }>;
export type ByteInput = Exclude<FileInput, ReferenceInput>;

export function isReferenceInput(input: FileInput): input is ReferenceInput {
  return "blobId" in input || "digest" in input;
}

/** At most `CHUNK_BYTES` of a file's bytes, and where they wait to be stored. */
export type StagedChunk = {
  readonly byteLength: number;
  readonly digest: string;
} & (
  | { readonly bytes: Uint8Array }
  /** Waiting in the staging area under this name. */
  | { readonly staged: string }
  /** Already published, inside the change, to this path. */
  | { readonly published: string }
);

/** A file's bytes, taken in, hashed and held for the change that stores them. */
export interface StagedBytes {
  readonly byteLength: number;
  /** One or more, in order; one chunk is stored as the file's own object. */
  readonly chunks: readonly StagedChunk[];
  readonly digest: string;
}

interface StagingLimits {
  readonly files?: BlobFiles;
  readonly maxFileBytes: number;
}

/**
 * The bytes one change stores. Ahead of the change, `stageAll` takes in every
 * byte input, a stream included, before the change enters the manager's
 * queue or the store's exclusion; `take` hands each to the change. An input
 * the change meets without staged bytes (a call inside `transaction`) is
 * staged as the change reaches it.
 *
 * With `blobFiles`, staged bytes wait as files in its staging area until the
 * change promotes them; `discard` removes whatever the change did not.
 * Without files they wait in memory. A `BlobFiles` without a staging area
 * cannot take a stream in ahead: the change publishes its chunks as the
 * stream yields them.
 */
export class BlobStaging {
  readonly #files: BlobFiles | undefined;
  readonly #area: BlobStagingArea | undefined;
  readonly #maxFileBytes: number;
  readonly #ahead = new Map<
    string,
    { readonly input: ByteInput; readonly bytes: StagedBytes }
  >();
  /** Staged files not yet promoted or discarded. */
  readonly #waiting = new Set<string>();

  constructor(limits: StagingLimits) {
    this.#files = limits.files;
    this.#area = stagingOf(limits.files);
    this.#maxFileBytes = limits.maxFileBytes;
  }

  /** Whether `entries` hold a stream this staging takes in ahead of the change. */
  streamsAhead(entries: EntryInputs | undefined): boolean {
    return byteInputs(entries).some(
      ([, input]) => "source" in input && this.#canStageAhead(input)
    );
  }

  /** Takes in every byte input of `entries` that can wait outside the change. */
  async stageAll(entries: EntryInputs | undefined): Promise<void> {
    for (const [path, input] of byteInputs(entries)) {
      if (this.#canStageAhead(input)) {
        this.#ahead.set(path, {
          bytes: await this.#stage(path, input, { ahead: true }),
          input,
        });
      }
    }
  }

  /** The bytes staged ahead for `input` at `path`, handed over once. */
  take(path: string, input: ByteInput): StagedBytes | undefined {
    const ahead = this.#ahead.get(path);
    if (ahead?.input !== input) {
      return;
    }
    this.#ahead.delete(path);
    return ahead.bytes;
  }

  /**
   * Takes `input` in inside the change. A stream into a `BlobFiles` is
   * published chunk by chunk through `publish`, so it never waits in memory.
   */
  stage(
    path: string,
    input: ByteInput,
    publish: (bytes: Uint8Array) => Promise<string>
  ): Promise<StagedBytes> {
    return this.#stage(path, input, { ahead: false, publish });
  }

  /** Moves a staged chunk to its published path; the chunk is spent. */
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

  /**
   * Removes every staged file the change did not promote. A failure to
   * remove one is reported, not thrown: the change's own outcome stands, and
   * the file is abandoned once this process is gone.
   */
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
      | { readonly ahead: true }
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
      pieces = split(checked(path, input.source, this.#maxFileBytes));
      declared = input.bytes;
    } else {
      const bytes =
        typeof input.bytes === "string"
          ? new TextEncoder().encode(input.bytes)
          : input.bytes;
      checkSize(path, bytes.byteLength, this.#maxFileBytes);
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

  /** Removes the staged files of chunks a failed staging held. */
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

/** Removes staging that crashed processes left in `files`, if it stages. */
export async function abandonStaging(
  files: BlobFiles | undefined
): Promise<void> {
  await stagingOf(files)?.abandon();
}

export function checkSize(path: string, size: number, max: number): void {
  if (size > max) {
    throw new FileTooLargeError(path, size, max);
  }
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new InvalidArtifactInputError("bytes", "Invalid byte length");
  }
}

export function digestOf(bytes: Uint8Array): string {
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
  max: number
): AsyncIterable<Uint8Array> {
  let size = 0;
  for await (const bytes of source) {
    size += bytes.byteLength;
    checkSize(path, size, max);
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
