import type { SessionMessage } from "../schema";

export interface WindowModel {
  contextWindow?: number;
  id: string;
  maxOutputTokens?: number;
}

export interface ContextBudget {
  hardTokenLimit?: number;
  headroom: number;
  reservedOutput: number;
  safetyMargin: number;
  window: number;
}

export interface TokenCounter {
  count(message: SessionMessage): number;
}

export interface SessionWindowOptions {
  counter?: TokenCounter;
  hardTokenLimit?: number;
  highWaterRatio?: number;
  reservedOutput?: number;
  safetyMarginRatio?: number;
}
