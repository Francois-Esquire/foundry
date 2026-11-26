import type { ContextBudget, SessionWindowOptions, WindowModel } from "./types";

const FALLBACK_WINDOW = 128_000;

const DEFAULT_RESERVED_OUTPUT = 8192;

const DEFAULT_SAFETY_MARGIN_RATIO = 0.08;

function resolveWindow(model: WindowModel): number {
  return model.contextWindow ?? FALLBACK_WINDOW;
}

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

export function effectiveLimit(
  budget: ContextBudget,
  highWaterRatio: number
): number {
  const highWater = Math.floor(budget.headroom * highWaterRatio);
  return budget.hardTokenLimit === undefined
    ? highWater
    : Math.min(highWater, budget.hardTokenLimit);
}
