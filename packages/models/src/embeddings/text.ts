import type { EmbeddingModelV4 } from "@ai-sdk/provider";

import { pipeline } from "@huggingface/transformers";
import { cosineSimilarity, embedMany, embed as embedWithSdk } from "ai";
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

export { cosineSimilarity };

export function resolveEmbeddingModel(
  source: EmbedSource,
  opts: { model?: string; provider?: string }
): EmbeddingModelV4 {
  return opts.provider === undefined
    ? source.embedding(opts.model)
    : source.embedding(opts.model, opts.provider);
}

// ── Entry points ────────────────────────────────────────────────────────────

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
        model: LOCAL_MODEL_ID,
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
  const active = fields.filter(
    (f): f is { field: string; text: string } =>
      f.text != null && f.text.length > 0
  );
  if (active.length === 0) {
    return [];
  }

  const strategy = options.strategy ?? { kind: "whole" };
  const model = resolveEmbeddingModel(source, options);

  // Expand every field into a flat list of (field, chunk) pairs in a
  // stable order, batch-embed in one call, then re-attach metadata.
  // `embedMany` returns embeddings in the same order as `values`, and
  // transparently splits the request if the model has a per-call cap.
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

// ── Serialization + ranking ─────────────────────────────────────────────────

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
  topK: number
): { row: T; score: number }[] {
  const scored = rows.map((row) => ({
    row,
    score: cosineSimilarity(query, deserializeEmbedding(row.embedding)),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export interface ScoredCandidate<T> {
  item: T;
  score: number;
}

/**
 * Rank pre-decoded embeddings by cosine similarity and keep the top `k`.
 *
 * Sibling to {@link rankBySimilarity}: that one decodes serialized
 * (`embedding: string`) DB rows, this one takes raw `number[]` vectors a caller
 * already has in hand — the shape a JSON-ranked node search produces. Signature
 * and result type intentionally mirror the desktop `@foundry-/models` `topK`,
 * so a consumer migrates by swapping the import alone.
 */
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

// ── Internals ───────────────────────────────────────────────────────────────

/**
 * Run an embed call under telemetry: reuse the caller's logger `session` when
 * present, otherwise open a scoped {@link withAiLogger} for `ctx`.
 */
export function runEmbed<T>(
  session: AiLoggerSession | undefined,
  ctx: { operation: string; provider?: string },
  run: (ai: AiLoggerSession) => Promise<T>
): Promise<T> {
  return session ? run(session) : withAiLogger(ctx, run);
}

/**
 * Local transformers models don't report token usage, which would land in
 * the wide event as `NaN`/`undefined` tokens. Normalize to 0 so the
 * `ai.embedding` field stays clean and queryable.
 */
export function embedUsage(usage: { tokens: number } | undefined): {
  tokens: number;
} {
  const tokens = usage?.tokens ?? 0;
  return { tokens: Number.isFinite(tokens) ? tokens : 0 };
}

// Local transformers.js pipeline — singleton because model load is
// expensive. Used only by `embedViaPipeline` for the manager-less path;
// `embed` routes through `LocalProvider` which has its own pipeline cache.

const LOCAL_MODEL_ID = "Xenova/all-MiniLM-L6-v2";

type FeatureExtractionPipeline = (
  text: string,
  opts: { pooling: string; normalize: boolean }
) => Promise<{ data: Float32Array }>;

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

function getPipeline(): Promise<FeatureExtractionPipeline> {
  pipelinePromise ??= pipeline(
    "feature-extraction",
    LOCAL_MODEL_ID
  ) as Promise<FeatureExtractionPipeline>;
  return pipelinePromise;
}
