/**
 * Budget resolution (context.md §1) — turns a {@link WindowModel} into the
 * {@link ContextBudget} the fit sizes against.
 *
 * Self-contained: window sizes come from a local table here, not
 * `@foundry/models`, because catalog baselines often omit limits. The table is
 * the consolidation target for the scattered window numbers noted in §5.
 */
import type { ContextBudget, SessionWindowOptions, WindowModel } from "./types";

/**
 * Local context-window table, keyed by model id. Seed/extend as we consolidate
 * the app-level tables and display meters (context.md §5). Conservative by
 * design — overshooting the real window is the failure we're preventing.
 */
export const CONTEXT_WINDOWS: Record<string, number> = {};

/**
 * Fallback when a model has no table entry and carries no `contextWindow`
 * (context.md §5 open item — deliberately conservative). Tune once the catalog
 * consolidation lands.
 */
export const FALLBACK_WINDOW = 128_000;

/** Default reply reservation when a turn doesn't override it. */
export const DEFAULT_RESERVED_OUTPUT = 8192;

const DEFAULT_SAFETY_MARGIN_RATIO = 0.08;

/** Resolve the input context window for a model: explicit → table → fallback. */
export function resolveWindow(model: WindowModel): number {
  return model.contextWindow ?? CONTEXT_WINDOWS[model.id] ?? FALLBACK_WINDOW;
}

/**
 * Build the {@link ContextBudget} for a model. `reservedOutput` defaults to a
 * flat hold-back (per-call override is a later refinement, context.md §1).
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
    headroom,
    reservedOutput,
    safetyMargin,
    window,
    ...(options.hardTokenLimit === undefined
      ? {}
      : { hardTokenLimit: options.hardTokenLimit }),
  };
}

/**
 * The effective token ceiling for a budget: the high-water mark over headroom,
 * lowered to the hard cap when one is set (context.md §4 — two triggers).
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
