import type { Chunk, EmbedFunction } from "@chonkiejs/core";

import { SemanticChunker } from "@chonkiejs/core";
import { embedMany } from "ai";

import type { ChunkSource } from "./source";
import { streamFrom } from "./source";
import { resolveEmbeddingModel } from "./text";
import type { EmbedSource } from "./types";

export type { Chunk, EmbedFunction } from "@chonkiejs/core";

export interface SemanticChunkOptions {
  abortSignal?: AbortSignal;
  chunkSize?: number;
  model?: string;
  provider?: string;
  similarityWindow?: number;
  threshold?: number;
}

const DEFAULT_SEMANTIC_CHUNK_SIZE = 512;

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

function createSemanticChunker(
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

export async function semanticChunk(
  text: string,
  source: EmbedSource,
  options: SemanticChunkOptions = {}
): Promise<Chunk[]> {
  const chunker = await createSemanticChunker(source, options);
  return chunker.chunk(text);
}

export function semanticChunkStream(
  input: ChunkSource,
  source: EmbedSource,
  options: SemanticChunkOptions = {}
): AsyncGenerator<Chunk> {
  return streamFrom(input, (text) => semanticChunk(text, source, options));
}
