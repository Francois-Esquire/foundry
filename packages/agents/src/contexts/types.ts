/**
 * Public vocabulary for the `contexts` subsystem — the sizing engine that
 * decides **how much** of a session we send each turn. Caching (the breakpoint
 * marking) is a sibling concern owned by `README.md`; this file is sizing only.
 *
 * Kept deliberately free of `ai`-package and provider types: the window manager
 * reasons over the persisted {@link SessionMessage} vocabulary, same as the
 * store it wraps.
 */
import type {
  SessionMessage,
  SessionPart,
  SessionUsage,
} from "../session/types";

/**
 * The model facts the sizing engine needs. Self-contained for now (see
 * `context.md` §1/§5): `contextWindow` / `maxOutputTokens` come from a local
 * table, not `@foundry/models`, because catalog baselines often omit limits.
 * Either field may be absent — {@link resolveBudget} falls back conservatively.
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
   * Optional absolute cap, independent of the window fraction (context.md §4,
   * trigger #2). When set and lower than `headroom`, it wins.
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
 * Counts tokens for a slice of parts. The default is a cheap pre-turn estimator
 * (context.md §2) — actual reported usage is the source of truth and is fed back
 * via {@link SessionWindow.recordUsage}. Swap for an exact counter later.
 */
export interface TokenCounter {
  count(message: SessionMessage): number;
}

/**
 * What the fit decided this turn. In Phase 1 it's purely informational — the fit
 * is a behavior-preserving stub that keeps the full history — but the shape is
 * already where trimming/summarization telemetry will land.
 */
export interface WindowPlan {
  /** Messages folded away (always empty in Phase 1). */
  dropped: SessionMessage[];
  /** Estimated prompt tokens for `kept`. */
  estimatedTokens: number;
  /** Messages sent this turn (full history in Phase 1). */
  kept: SessionMessage[];
  /** True when `estimatedTokens` crosses the effective limit — the fit *would* act. */
  overBudget: boolean;
  /** Whether a summarization was performed (always false in Phase 1). */
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
 * Ephemeral per-session bookkeeping (context.md §2). Lives in-memory on the
 * {@link SessionWindow} instance for now; the durable home is an open item, and
 * we do **not** widen `session/types.ts` (the other thread owns it).
 */
export interface WindowState {
  /** Last pre-turn estimate, kept to correct the estimator against actuals. */
  lastEstimate?: number;
  /** Last actual input tokens reported by the provider — calibration anchor. */
  lastInputTokens?: number;
  /** Turn-to-turn growth in input tokens — a stat for later, nothing reads it yet. */
  velocity?: number;
}

/** Construction knobs for {@link SessionWindow}. All optional with sane defaults. */
export interface SessionWindowOptions {
  /** Token counter; defaults to the built-in estimator. */
  counter?: TokenCounter;
  /** Absolute token cap (context.md §4, trigger #2). */
  hardTokenLimit?: number;
  /** High-water fraction of headroom that flags `overBudget`. Default 0.8. */
  highWaterRatio?: number;
  /** Flat reply reservation (tokens). Per-call override is a later refinement. */
  reservedOutput?: number;
  /** Fraction of the window reserved as safety buffer. Default 0.08. */
  safetyMarginRatio?: number;
}

export type { SessionMessage, SessionPart, SessionUsage };
