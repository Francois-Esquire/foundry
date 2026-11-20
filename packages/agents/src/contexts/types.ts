import type { SessionMessage } from "../session/types";

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

export interface WindowPlan {
  dropped: SessionMessage[];
  estimatedTokens: number;
  kept: SessionMessage[];
  overBudget: boolean;
  summarized: boolean;
}

export interface WindowResult {
  budget: ContextBudget;
  messages: SessionMessage[];
  plan: WindowPlan;
}

export interface WindowState {
  lastEstimate?: number;
  lastInputTokens?: number;
  velocity?: number;
}

export interface SessionWindowOptions {
  counter?: TokenCounter;
  hardTokenLimit?: number;
  highWaterRatio?: number;
  reservedOutput?: number;
  safetyMarginRatio?: number;
}

export type {
  SessionMessage,
  SessionPart,
  SessionUsage,
} from "../session/types";
