/**
 * Resolves a model's input limits into the {@link ContextBudget} used to size a
 * turn.
 *
 * Uses a local table rather than `@foundry/models`, whose catalog baselines may
 * omit limits.
 */
import type { ContextBudget, SessionWindowOptions, WindowModel } from "./types";

/**
 * Overrides for models whose catalog metadata does not provide a context
 * window.
 */
const CONTEXT_WINDOWS: Record<string, number> = {};

/**
 * Used when neither the model nor {@link CONTEXT_WINDOWS} provides a window.
 * The conservative default reduces the chance of exceeding the real limit.
 */
const FALLBACK_WINDOW = 128_000;

const DEFAULT_RESERVED_OUTPUT = 8192;

const DEFAULT_SAFETY_MARGIN_RATIO = 0.08;

/** Resolve the input context window for a model: explicit → table → fallback. */
function resolveWindow(model: WindowModel): number {
  return model.contextWindow ?? CONTEXT_WINDOWS[model.id] ?? FALLBACK_WINDOW;
}

/**
 * Build the {@link ContextBudget} for a model. `reservedOutput` defaults to a
 * flat hold-back unless the model or caller supplies a value.
 */
export function resolveBudget(
  model: WindowModel,
  options: SessionWindowOptions = {}
): ContextBudget {
  const window = resolveWindow(model);
  const reservedOutput =
    options.reservedOutput ?? model.maxOutputTokens ?? DEFAULT_RESERVED_OUTPUT;
  const safetyMargin = Math.ceil(
    window * (options.safetyMarginRatio ?? DEFAULT_SAFETY_MARGIN_RATIO)
  );
  const headroom = Math.max(0, window - reservedOutput - safetyMargin);
  return {
    hardTokenLimit: options.hardTokenLimit,
    headroom,
    reservedOutput,
    safetyMargin,
    window,
  };
}

/**
 * The effective token ceiling: the high-water mark over headroom, lowered to
 * the hard cap when one is set.
 */
export function effectiveLimit(
  budget: ContextBudget,
  highWaterRatio: number
): number {
  const highWater = Math.floor(budget.headroom * highWaterRatio);
  return budget.hardTokenLimit === undefined
    ? highWater
    : Math.min(highWater, budget.hardTokenLimit);
}
