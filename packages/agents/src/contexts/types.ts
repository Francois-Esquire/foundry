/** Types for context budgeting and session window estimates. */
import type { SessionMessage } from "../session/types";

/**
 * Model facts used for context budgeting. Window sizes use a local table
 * because catalog baselines may omit limits; absent values use a fallback.
 */
export interface WindowModel {
  /** Max INPUT tokens for the model. */
  contextWindow?: number;
  id: string;
  /** Max OUTPUT tokens — informs the reply reservation. */
  maxOutputTokens?: number;
}

/**
 * The numbers used to calculate a turn's effective token limit.
 */
export interface ContextBudget {
  /**
   * Optional absolute cap on the effective limit, after the high-water ratio.
   */
  hardTokenLimit?: number;
  /** `max(0, window - reservedOutput - safetyMargin)`. */
  headroom: number;
  /** Tokens held back for the reply so prompt + reply both fit. */
  reservedOutput: number;
  /** Buffer for estimate error (tokens). */
  safetyMargin: number;
  /** Resolved context window (input tokens). */
  window: number;
}

/**
 * Counts tokens for a message. The default is a pre-turn estimate;
 * {@link SessionWindow.recordUsage} stores actual usage separately.
 */
export interface TokenCounter {
  count(message: SessionMessage): number;
}

/**
 * The current fit estimate and decisions for one turn. The fit presently keeps
 * all history and does not summarize.
 */
export interface WindowPlan {
  dropped: SessionMessage[];
  estimatedTokens: number;
  kept: SessionMessage[];
  /** True when `estimatedTokens` crosses the effective limit — the fit *would* act. */
  overBudget: boolean;
  summarized: boolean;
}

/** The messages, budget, and plan returned by {@link SessionWindow.windowFor}. */
export interface WindowResult {
  budget: ContextBudget;
  messages: SessionMessage[];
  plan: WindowPlan;
}

/**
 * In-memory per-session bookkeeping held by {@link SessionWindow}.
 */
export interface WindowState {
  lastEstimate?: number;
  /** Last actual input tokens reported by the provider. */
  lastInputTokens?: number;
  velocity?: number;
}

/** Construction knobs for {@link SessionWindow}. All optional with sane defaults. */
export interface SessionWindowOptions {
  /** Token counter; defaults to the built-in estimator. */
  counter?: TokenCounter;
  /** Optional absolute token cap. */
  hardTokenLimit?: number;
  /** High-water fraction of headroom that flags `overBudget`. Default 0.8. */
  highWaterRatio?: number;
  /** Tokens reserved for the model's reply. */
  reservedOutput?: number;
  /** Fraction of the window reserved as safety buffer. Default 0.08. */
  safetyMarginRatio?: number;
}

export type {
  SessionMessage,
  SessionPart,
  SessionUsage,
} from "../session/types";
