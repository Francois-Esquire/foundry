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
  limit: number;
}

export interface PrepareOutput {
  messages: SessionMessage[];
  plan: WindowPlan;
}

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
