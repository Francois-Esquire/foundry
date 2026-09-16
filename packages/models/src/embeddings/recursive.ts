import type { Chunk } from "@chonkiejs/core";

import { RecursiveChunker } from "@chonkiejs/core";

import type { ChunkSource } from "./source";

import { streamFrom } from "./source";

/**
 * Recursive, boundary-aware chunking backed by `@chonkiejs/core`.
 *
 * This is the replacement for the home-brew `fixed-cutoff` strategy in
 * `chunk.ts`. Where fixed-cutoff slices blindly every N characters, chonkie's
 * {@link RecursiveChunker} splits on a hierarchy of delimiters
 * (paragraphs → sentences → punctuation → words → characters) and merges small
 * splits back up to the size limit — so cuts land on natural boundaries instead
 * of mid-token.
 *
 * The native chonkie {@link Chunk} is surfaced verbatim — `text`, `startIndex`,
 * `endIndex`, `tokenCount`, and an optional `embedding` slot (filled by the
 * semantic chunker). We deliberately do **not** remap it onto the legacy
 * `{ index, isChunked, span }` shape: `tokenCount` and the embedding slot are
 * the reason to adopt this, and faking `isChunked` would discard them.
 *
 * **Provenance note.** `startIndex`/`endIndex` index into the original text and
 * round-trip losslessly (`text.slice(startIndex, endIndex) === chunk.text`) at
 * realistic chunk sizes. They degrade only below ~256, where sub-sentence word
 * splits trim boundary whitespace; keep `chunkSize` at embedding scale and the
 * span stays exact.
 *
 * **Units.** `chunkSize` is in *tokens*. The default tokenizer is
 * character-based, so tokens ≈ characters until a real tokenizer is wired in.
 */
export type { Chunk } from "@chonkiejs/core";

export interface RecursiveChunkOptions {
  /**
   * Maximum tokens per chunk. With the default character tokenizer this is an
   * effective character cap. Default {@link DEFAULT_RECURSIVE_CHUNK_SIZE}.
   */
  chunkSize?: number;
  /**
   * Minimum characters per chunk when merging small trailing splits. chonkie's
   * own default is 24; omit to inherit it.
   */
  minCharactersPerChunk?: number;
}

/** Default chunk size (tokens). Sized for embedding inputs, above the ~256 floor. */
export const DEFAULT_RECURSIVE_CHUNK_SIZE = 512;

/**
 * Build a {@link RecursiveChunker} with our defaults. Async because chonkie
 * lazily initializes its WASM split engine (and any non-default tokenizer).
 */
export function createRecursiveChunker(
  options: RecursiveChunkOptions = {}
): Promise<RecursiveChunker> {
  return RecursiveChunker.create({
    chunkSize: options.chunkSize ?? DEFAULT_RECURSIVE_CHUNK_SIZE,
    ...(options.minCharactersPerChunk === undefined
      ? {}
      : { minCharactersPerChunk: options.minCharactersPerChunk }),
  });
}

/** One-shot: chunk `text` on recursive delimiter boundaries. Returns native chonkie chunks. */
export async function recursiveChunk(
  text: string,
  options: RecursiveChunkOptions = {}
): Promise<Chunk[]> {
  const chunker = await createRecursiveChunker(options);
  return chunker.chunk(text);
}

/**
 * Stream recursive chunks from a {@link ChunkSource} (string or sync/async
 * stream of pieces). Buffers the whole source before chunking — see
 * {@link streamFrom} for why this is not constant-memory streaming.
 */
export function recursiveChunkStream(
  input: ChunkSource,
  options: RecursiveChunkOptions = {}
): AsyncGenerator<Chunk> {
  return streamFrom(input, (text) => recursiveChunk(text, options));
}
