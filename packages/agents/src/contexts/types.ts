/**
 * Public vocabulary for the `contexts` subsystem — the sizing engine that
 * decides **how much** of a session we send each turn. Caching (the breakpoint
 * marking) is a sibling concern owned by `README.md`; this file is sizing only.
 *
 * Kept deliberately free of `ai`-package and provider types: the window manager
 * reasons over the persisted {@link SessionMessage} vocabulary, same as the
 * store it wraps.
 */
import type { SessionMessage } from "../session/types";

/**
 * Model facts used for context budgeting. Window sizes use a local table
 * because catalog baselines may omit limits; absent values fall back
 * conservatively.
 */
export interface WindowModel {
  /** Max INPUT tokens for the model. */
  contextWindow?: number;
  id: string;
  /** Max OUTPUT tokens — informs the reply reservation. */
  maxOutputTokens?: number;
}

/**
 * The numbers we size a turn against. `headroom` is the only one the fit cares
 * about: `window - reservedOutput - safetyMargin`.
 */
export interface ContextBudget {
  /**
   * Optional absolute cap, independent of the window fraction. When lower than
   * `headroom`, it wins.
   */
  hardTokenLimit?: number;
  /** `window - reservedOutput - safetyMargin`. The line the prompt must clear. */
  headroom: number;
  /** Tokens held back for the reply so prompt + reply both fit. */
  reservedOutput: number;
  /** Buffer for estimate error (tokens). */
  safetyMargin: number;
  /** Resolved context window (input tokens). */
  window: number;
}

/**
 * Counts tokens for a slice of parts. The default is a cheap pre-turn estimate;
 * actual usage is the source of truth and is fed back via
 * {@link SessionWindow.recordUsage}.
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

/**
 * The result of {@link SessionWindow.windowFor}: the managed message list plus
 * the budget and plan that produced it. A result object (not a bare array) so
 * the usage meter and telemetry have a home and the signature can stay put as
 * the internals grow.
 */
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
  /** Last actual input tokens reported by the provider — calibration anchor. */
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
