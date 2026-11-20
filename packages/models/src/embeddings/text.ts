import type { EmbeddingModelV4 } from "@ai-sdk/provider";

import { pipeline } from "@huggingface/transformers";
import { cosineSimilarity, embedMany, embed as embedWithSdk } from "ai";
import { LOCAL_EMBEDDING_MODEL_ID } from "../catalog/local";
import { modelErrors } from "../errors";
import type { AiLoggerSession } from "../logger";
import { withAiLogger } from "../logger";
import { chunk } from "./chunk";
import type {
  EmbeddingPayload,
  EmbedFieldInput,
  EmbedFieldsOptions,
  EmbedOptions,
  EmbedSource,
} from "./types";
export function resolveEmbeddingModel(
  source: EmbedSource,
  opts: { model?: string; provider?: string }
): EmbeddingModelV4 {
  return opts.provider === undefined
    ? source.embedding(opts.model)
    : source.embedding(opts.model, opts.provider);
}

export async function embed(
  source: EmbedSource,
  text: string,
  options: EmbedOptions = {}
): Promise<number[]> {
  const model = resolveEmbeddingModel(source, options);
  const run = async (ai: AiLoggerSession) => {
    const { embedding, usage } = await embedWithSdk({
      abortSignal: options.abortSignal,
      model,
      value: text,
    });
    ai.captureEmbed({
      dimensions: embedding.length,
      model: model.modelId,
      usage: embedUsage(usage),
    });
    return embedding;
  };
  return runEmbed(
    options.session,
    { operation: "embed", provider: model.provider },
    run
  );
}

export async function embedViaPipeline(text: string): Promise<number[]> {
  return withAiLogger(
    { operation: "embed", provider: "local-pipeline" },
    async (ai) => {
      const pipe = await getPipeline();
      const output = await pipe(text, { normalize: true, pooling: "mean" });
      const embedding = Array.from(output.data);
      ai.captureEmbed({
        dimensions: embedding.length,
        model: LOCAL_EMBEDDING_MODEL_ID,
        usage: { tokens: 0 },
      });
      return embedding;
    }
  );
}

export async function embedFields(
  source: EmbedSource,
  fields: EmbedFieldInput[],
  options: EmbedFieldsOptions = {}
): Promise<EmbeddingPayload[]> {
  const active = fields.filter((f): f is { field: string; text: string } => {
    const { text } = f;
    return text !== null && text !== undefined && text.length > 0;
  });
  if (active.length === 0) {
    return [];
  }

  const strategy = options.strategy ?? { kind: "whole" };
  const model = resolveEmbeddingModel(source, options);

  const expanded = active.flatMap(({ field, text }) =>
    chunk(text, strategy).map((c) => ({ chunk: c, field }))
  );

  const run = async (ai: AiLoggerSession) => {
    const result = await embedMany({
      abortSignal: options.abortSignal,
      model,
      values: expanded.map((e) => e.chunk.text),
    });
    ai.captureEmbed({
      count: result.embeddings.length,
      dimensions: result.embeddings[0]?.length,
      model: model.modelId,
      usage: embedUsage(result.usage),
    });
    return result;
  };
  const { embeddings } = await runEmbed(
    options.session,
    { operation: "embedMany", provider: model.provider },
    run
  );

  return expanded.map(({ field, chunk: c }, i) => {
    const vector = embeddings[i];
    if (vector === undefined) {
      throw modelErrors.EMBEDDING_COUNT_MISMATCH({
        expected: expanded.length,
        returned: embeddings.length,
      });
    }
    return {
      chunkIndex: c.index,
      dimensions: vector.length,
      field,
      isChunked: c.isChunked,
      model: model.modelId,
      vector,
    };
  });
}

export function serializeEmbedding(vector: number[]): string {
  return JSON.stringify(vector);
}

export function deserializeEmbedding(json: string): number[] {
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) {
    throw modelErrors.INVALID_EMBEDDING_JSON();
  }
  return parsed.map(Number);
}

export function rankBySimilarity<T extends { embedding: string }>(
  query: number[],
  rows: T[],
  limit: number
): { row: T; score: number }[] {
  return topK(
    query,
    rows.map((row) => ({
      embedding: deserializeEmbedding(row.embedding),
      item: row,
    })),
    limit
  ).map(({ item, score }) => ({ row: item, score }));
}

export interface ScoredCandidate<T> {
  item: T;
  score: number;
}

export function topK<T>(
  query: number[],
  candidates: { item: T; embedding: number[] }[],
  k: number
): ScoredCandidate<T>[] {
  const scored = candidates.map(({ item, embedding }) => ({
    item,
    score: cosineSimilarity(query, embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

export function runEmbed<T>(
  session: AiLoggerSession | undefined,
  ctx: { operation: string; provider?: string },
  run: (ai: AiLoggerSession) => Promise<T>
): Promise<T> {
  return session ? run(session) : withAiLogger(ctx, run);
}

export function embedUsage(usage: { tokens: number } | undefined): {
  tokens: number;
} {
  const tokens = usage?.tokens ?? 0;
  return { tokens: Number.isFinite(tokens) ? tokens : 0 };
}

type FeatureExtractionPipeline = (
  text: string,
  opts: { pooling: string; normalize: boolean }
) => Promise<{ data: Float32Array }>;

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

function getPipeline(): Promise<FeatureExtractionPipeline> {
  pipelinePromise ??= pipeline(
    "feature-extraction",
    LOCAL_EMBEDDING_MODEL_ID
  ) as Promise<FeatureExtractionPipeline>;
  return pipelinePromise;
}
