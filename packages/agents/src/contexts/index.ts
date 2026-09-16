/**
 * `contexts` — context-window sizing (`context.md`) and provider caching
 * (`README.md`) for a session.
 *
 * Public surface: wrap any {@link SessionStore} in a {@link SessionWindow} for
 * window management (a drop-in store); use {@link cacheDirectivesFor} for the
 * per-provider cache rules. Sizing and caching are siblings — separate files,
 * one entry point.
 */

export {
  CONTEXT_WINDOWS,
  DEFAULT_RESERVED_OUTPUT,
  effectiveLimit,
  FALLBACK_WINDOW,
  resolveBudget,
  resolveWindow,
} from "./budget";
export type {
  CacheDirectives,
  CacheOverrides,
  CacheProvider,
  CacheRuleInput,
  ProviderOptions,
} from "./cache";
export {
  cacheDirectivesFor,
  mergeProviderOptions,
  resolveCacheProvider,
} from "./cache";
export { estimateMessageTokens, estimatingCounter } from "./counter";
export type { PrepareInput, PrepareOutput } from "./prepare";
export { prepareContext } from "./prepare";
export { SessionWindow } from "./session-window";
export type {
  ContextBudget,
  SessionWindowOptions,
  TokenCounter,
  WindowModel,
  WindowPlan,
  WindowResult,
  WindowState,
} from "./types";
