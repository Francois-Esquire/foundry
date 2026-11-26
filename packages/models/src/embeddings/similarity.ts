import { cosineSimilarity } from "ai";
import { modelErrors } from "../errors";

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
