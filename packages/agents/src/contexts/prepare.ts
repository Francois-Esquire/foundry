/**
 * The fit — pure over (history, budget, counter), no store, no I/O — so it's
 * testable in isolation (advisor's "keep the fit pure").
 *
 * **Phase 1 is behavior-preserving:** it keeps the *full* history unchanged and
 * only reports whether it would act, so dropping a {@link SessionWindow} in
 * anywhere is a guaranteed no-op until the real fit lands (context.md §3, §7).
 * Trimming / summarization replace this body in Phase 2 without touching the
 * signature.
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

/**
 * Size a turn. Phase 1: estimate the full history, flag whether it crosses the
 * limit, and return it untouched.
 */
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

  // Phase 1 stub: keep everything. Phase 2 trims/summarizes `kept` here.
  return { messages: history, plan };
}
