/**
 * Purely estimates the full history and reports whether it exceeds the limit.
 * It currently returns the history unchanged; no trimming or summarization is
 * performed.
 */
import type {
  ContextBudget,
  SessionMessage,
  TokenCounter,
  WindowPlan,
} from "./types";

export interface PrepareInput {
  budget: ContextBudget;
  counter: TokenCounter;
  history: SessionMessage[];
  /** Effective token ceiling (high-water, lowered by any hard cap). */
  limit: number;
}

export interface PrepareOutput {
  messages: SessionMessage[];
  plan: WindowPlan;
}

/** Estimate a turn's history and report whether it exceeds the limit. */
export function prepareContext(input: PrepareInput): PrepareOutput {
  const { history, counter, limit } = input;

  let estimatedTokens = 0;
  for (const message of history) {
    estimatedTokens += counter.count(message);
  }

  const plan: WindowPlan = {
    dropped: [],
    estimatedTokens,
    kept: history,
    overBudget: estimatedTokens > limit,
    summarized: false,
  };

  return { messages: history, plan };
}
