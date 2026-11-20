import type { Chunk } from "@chonkiejs/core";

import { RecursiveChunker } from "@chonkiejs/core";

import type { ChunkSource } from "./source";

import { streamFrom } from "./source";

export type { Chunk } from "@chonkiejs/core";

export interface RecursiveChunkOptions {
  chunkSize?: number;
  minCharactersPerChunk?: number;
}

const DEFAULT_RECURSIVE_CHUNK_SIZE = 512;

function createRecursiveChunker(
  options: RecursiveChunkOptions = {}
): Promise<RecursiveChunker> {
  return RecursiveChunker.create({
    chunkSize: options.chunkSize ?? DEFAULT_RECURSIVE_CHUNK_SIZE,
    ...(options.minCharactersPerChunk === undefined
      ? {}
      : { minCharactersPerChunk: options.minCharactersPerChunk }),
  });
}

export async function recursiveChunk(
  text: string,
  options: RecursiveChunkOptions = {}
): Promise<Chunk[]> {
  const chunker = await createRecursiveChunker(options);
  return chunker.chunk(text);
}

export function recursiveChunkStream(
  input: ChunkSource,
  options: RecursiveChunkOptions = {}
): AsyncGenerator<Chunk> {
  return streamFrom(input, (text) => recursiveChunk(text, options));
}
