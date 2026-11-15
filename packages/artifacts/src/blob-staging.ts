import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { BlobFiles, BlobStagingArea } from "./blob";
import { CHUNK_BYTES } from "./constants";
import { FileTooLargeError, InvalidArtifactInputError } from "./errors";
import type { BlobId } from "./ref";
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

/**
 * Who holds the object a file entry names before a change replaces it: the
 * entry alone (`exclusive`), so the change may rewrite it in place, or more
 * than one reference.
 */
export interface Ownership {
  readonly blobId: BlobId;
  readonly exclusive: boolean;
}

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
  /** Absent: the tree limit is checked only inside the change. */
  readonly maxTreeBytes?: number;
}

/** How many streams one manager takes in ahead of its changes at once. */
export const MAX_STAGING_STREAMS = 8;

/**
 * Turns for streams staged ahead, shared by one manager's changes, so a
 * burst of slow sources holds at most `MAX_STAGING_STREAMS` of them open.
 */
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
  readonly #maxTreeBytes: number | undefined;
  readonly #turns: StagingTurns;
  readonly #ahead = new Map<
    string,
    { readonly input: ByteInput; readonly bytes: StagedBytes }
  >();
  /** Staged files not yet promoted or discarded. */
  readonly #waiting = new Set<string>();
  /** Per Artifact and path, the ownership seen before the bytes were staged. */
  readonly #ownership = new Map<string, Ownership | null>();

  /** `turns` bound the streams staged at once; one manager shares them. */
  constructor(limits: StagingLimits, turns: StagingTurns = new StagingTurns()) {
    this.#files = limits.files;
    this.#maxTreeBytes = limits.maxTreeBytes;
    this.#turns = turns;
    this.#area = limits.files?.staging;
    this.#maxFileBytes = limits.maxFileBytes;
  }

  /**
   * Records the ownership an entry showed when its change was checked,
   * before its bytes were staged. `key` names the Artifact and path.
   */
  recordOwnership(key: string, seen: Ownership | null): void {
    this.#ownership.set(key, seen);
  }

  /**
   * Whether the ownership an entry shows now is the one recorded for it, if
   * any was; the record is spent, so a later write to the same entry in the
   * same change is not held to it.
   */
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

  /** Whether `entries` hold a stream this staging takes in ahead of the change. */
  streamsAhead(entries: EntryInputs | undefined): boolean {
    return byteInputs(entries).some(
      ([, input]) => "source" in input && this.#canStageAhead(input)
    );
  }

  /** Takes in every byte input of `entries` that can wait outside the change. */
  /**
   * Takes in every byte input of `entries` that can wait outside the change.
   * Their sizes add up as they arrive: once the total alone exceeds the tree
   * limit, the change could only fail, so staging stops there. Each stream
   * takes one of the manager's staging turns while it is read.
   */
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
