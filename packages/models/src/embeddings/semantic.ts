import type { Chunk, EmbedFunction } from "@chonkiejs/core";

import { SemanticChunker } from "@chonkiejs/core";
import { embedMany } from "ai";

import type { ChunkSource } from "./source";
import { streamFrom } from "./source";
import { resolveEmbeddingModel } from "./text";
import type { EmbedSource } from "./types";

/**
 * Semantic, embedding-driven chunking backed by `@chonkiejs/core`.
 *
 * Where {@link recursiveChunk} splits on syntactic delimiters, the
 * {@link SemanticChunker} splits on *meaning*: it embeds sliding windows of
 * sentences, finds similarity valleys (topic shifts), and cuts there. That makes
 * it the seam that couples chunking to `@foundry/models` — it *consumes* an
 * embedder to decide boundaries.
 *
 * **It consumes embeddings; it does not emit them.** The returned {@link Chunk}s
 * carry offsets and `tokenCount` but leave `embedding` empty — boundary
 * detection uses per-sentence-window vectors, not per-chunk ones. To attach a
 * vector to each final chunk, run a second embed pass over the chunk texts
 * (`embedStream`/`embedMany`). Keeping the two passes separate is deliberate:
 * chunking emits chunks, embedding emits vectors, and a chunk stream is just a
 * source the embedder consumes.
 */
export type { Chunk, EmbeddingModel, EmbedFunction } from "@chonkiejs/core";

export interface SemanticChunkOptions {
  abortSignal?: AbortSignal;
  /** Maximum tokens per chunk (default tokenizer is character-based). Default 512. */
  chunkSize?: number;
  /** Embedding model id to resolve from the source. */
  model?: string;
  /** Provider id (only used when the source is a {@link ModelManager}). */
  provider?: string;
  /** Sentences per sliding-similarity window. Inherits chonkie's default (3). */
  similarityWindow?: number;
  /**
   * Similarity threshold (0–1); valleys below it are split points. Lower → more
   * splits. Inherits chonkie's default (0.8) when omitted.
   */
  threshold?: number;
}

/** Default semantic chunk size (tokens), above the ~256 coverage floor. */
export const DEFAULT_SEMANTIC_CHUNK_SIZE = 512;

/**
 * Adapt a `@foundry/models` {@link EmbedSource} into the `(texts) => number[][]`
 * {@link EmbedFunction} the {@link SemanticChunker} calls. The chunker hands all
 * window/sentence texts to the embedder at once, so this batches through a
 * single `embedMany` call rather than looping per text.
 *
 * No telemetry is emitted here on purpose: these are chunking-internal window
 * embeddings, not document embeddings, and logging them as `embed` events would
 * pollute the wide-event stream with non-document vectors.
 */
export function toEmbedFunction(
  source: EmbedSource,
  options: Pick<SemanticChunkOptions, "model" | "provider" | "abortSignal"> = {}
): EmbedFunction {
  const model = resolveEmbeddingModel(source, options);
  return async (texts) => {
    const { embeddings } = await embedMany({
      model,
      values: texts,
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    });
    return embeddings;
  };
}

/** Build a {@link SemanticChunker} bound to a `@foundry/models` embed source. */
export function createSemanticChunker(
  source: EmbedSource,
  options: SemanticChunkOptions = {}
): Promise<SemanticChunker> {
  return SemanticChunker.create({
    chunkSize: options.chunkSize ?? DEFAULT_SEMANTIC_CHUNK_SIZE,
    embeddings: toEmbedFunction(source, options),
    ...(options.threshold === undefined
      ? {}
      : { threshold: options.threshold }),
    ...(options.similarityWindow === undefined
      ? {}
      : { similarityWindow: options.similarityWindow }),
  });
}

/** One-shot: chunk `text` on semantic (embedding-detected) boundaries. */
export async function semanticChunk(
  text: string,
  source: EmbedSource,
  options: SemanticChunkOptions = {}
): Promise<Chunk[]> {
  const chunker = await createSemanticChunker(source, options);
  return chunker.chunk(text);
}

/**
 * Stream semantic chunks from a {@link ChunkSource}. Buffers the whole source
 * first (semantic boundary detection needs the global similarity signal) — see
 * {@link streamFrom}.
 */
export function semanticChunkStream(
  input: ChunkSource,
  source: EmbedSource,
  options: SemanticChunkOptions = {}
): AsyncGenerator<Chunk> {
  return streamFrom(input, (text) => semanticChunk(text, source, options));
}
