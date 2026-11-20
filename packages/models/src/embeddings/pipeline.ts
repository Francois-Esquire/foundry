import type { EmbeddingModelV4 } from "@ai-sdk/provider";
import type { Chunk } from "@chonkiejs/core";

import { embedMany } from "ai";
import { modelErrors } from "../errors";
import type { AiLoggerSession } from "../logger";
import { recursiveChunk } from "./recursive";
import { semanticChunk } from "./semantic";
import type { ChunkSource } from "./source";
import { collectSource } from "./source";
import { embedUsage, resolveEmbeddingModel, runEmbed } from "./text";
import type { EmbedSource } from "./types";

type ChunkMethod = "semantic" | "recursive";

export interface EmbedChunksOptions {
  abortSignal?: AbortSignal;
  batchSize?: number;
  chunkSize?: number;
  method?: ChunkMethod;
  model?: string;
  provider?: string;
  session?: AiLoggerSession;
  similarityWindow?: number;
  threshold?: number;
}

export interface EmbeddedChunk {
  dimensions: number;
  endIndex: number;
  index: number;
  model: string;
  startIndex: number;
  text: string;
  tokenCount: number;
  vector: number[];
}

const DEFAULT_BATCH_SIZE = 32;

export async function* embedChunks(
  input: ChunkSource,
  source: EmbedSource,
  options: EmbedChunksOptions = {}
): AsyncGenerator<EmbeddedChunk> {
  const text = await collectSource(input);
  const chunks = await chunkWith(
    options.method ?? "semantic",
    text,
    source,
    options
  );
  if (chunks.length === 0) {
    return;
  }

  const model = resolveEmbeddingModel(source, options);
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);

  let index = 0;
  for (let start = 0; start < chunks.length; start += batchSize) {
    const batch = chunks.slice(start, start + batchSize);
    const vectors = await embedBatch(model, batch, options);
    for (const [i, c] of batch.entries()) {
      const vector = vectors[i];
      if (vector === undefined) {
        throw modelErrors.EMBEDDING_COUNT_MISMATCH({
          expected: batch.length,
          returned: vectors.length,
        });
      }
      yield {
        dimensions: vector.length,
        endIndex: c.endIndex,
        index,
        model: model.modelId,
        startIndex: c.startIndex,
        text: c.text,
        tokenCount: c.tokenCount,
        vector,
      };
      index += 1;
    }
  }
}

function chunkWith(
  method: ChunkMethod,
  text: string,
  source: EmbedSource,
  options: EmbedChunksOptions
): Promise<Chunk[]> {
  const shared = {
    ...(options.chunkSize === undefined
      ? {}
      : { chunkSize: options.chunkSize }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  };
  if (method === "recursive") {
    return recursiveChunk(text, shared);
  }
  return semanticChunk(text, source, {
    ...shared,
    ...(options.threshold === undefined
      ? {}
      : { threshold: options.threshold }),
    ...(options.similarityWindow === undefined
      ? {}
      : { similarityWindow: options.similarityWindow }),
  });
}

function embedBatch(
  model: EmbeddingModelV4,
  chunks: Chunk[],
  options: EmbedChunksOptions
): Promise<number[][]> {
  const run = async (ai: AiLoggerSession): Promise<number[][]> => {
    const result = await embedMany({
      model,
      values: chunks.map((c) => c.text),
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    });
    ai.captureEmbed({
      count: result.embeddings.length,
      dimensions: result.embeddings[0]?.length,
      model: model.modelId,
      usage: embedUsage(result.usage),
    });
    return result.embeddings;
  };
  return runEmbed(
    options.session,
    { operation: "embedMany", provider: model.provider },
    run
  );
}
