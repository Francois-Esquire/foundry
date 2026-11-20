import type { EmbeddingModelV4 } from "@ai-sdk/provider";

import type { AiLoggerSession } from "../logger";
import type { ChunkStrategy } from "./chunk";

export interface EmbedSource {
  embedding(model?: string, provider?: string): EmbeddingModelV4;
}

export interface EmbedOptions {
  abortSignal?: AbortSignal;
  model?: string;
  provider?: string;
  session?: AiLoggerSession;
}

export interface EmbedFieldInput {
  field: string;
  text: string | null | undefined;
}

export interface EmbeddingPayload {
  chunkIndex: number;
  dimensions: number;
  field: string;
  isChunked: boolean;
  model: string;
  vector: number[];
}

export interface EmbedFieldsOptions extends EmbedOptions {
  strategy?: ChunkStrategy;
}
