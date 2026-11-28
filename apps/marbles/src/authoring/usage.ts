import { createUsage, type Usage } from "@foundry/usage";

interface UsageState {
  active: Usage;
}

const USAGE_STATE_KEY = Symbol.for("marbles.usage.state.v1");

function usageState(): UsageState {
  const holder = globalThis as Record<symbol, UsageState | undefined>;
  let state = holder[USAGE_STATE_KEY];
  if (state === undefined) {
    state = { active: createUsage() };
    holder[USAGE_STATE_KEY] = state;
  }
  return state;
}

export function setUsage(instance: Usage): void {
  usageState().active = instance;
}

export function resetUsage(): void {
  usageState().active = createUsage();
}

const facade: Usage = {
  add: (account) => usageState().active.add(account),
  budget: (name) => usageState().active.budget(name),
  initialize: () => usageState().active.initialize(),
  query: ((...args: Parameters<Usage["query"]>) =>
    (usageState().active.query as (...values: unknown[]) => unknown)(
      ...args
    )) as Usage["query"],
  share: (name, span) => usageState().active.share(name, span),
  use: (provider) => usageState().active.use(provider),
};

export const usage: Usage = Object.freeze(facade);
