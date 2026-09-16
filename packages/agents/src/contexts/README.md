# Context sizing and cache directives

`@foundry/agents/contexts` exports two independent sets of helpers: session
window estimates and provider cache options. Neither requires a model registry.

## Session window

`SessionWindow` wraps a `SessionStore`, delegates its storage operations, and
adds a budgeted view of a conversation:

```ts
import { SessionWindow } from "@foundry/agents/contexts";

const window = new SessionWindow(store);
const result = await window.windowFor(sessionId, {
  id: "my-model",
  contextWindow: 128_000,
  maxOutputTokens: 8192,
});

// result.messages, result.budget, result.plan
window.recordUsage(sessionId, usage);
const state = window.stateFor(sessionId);
```

`windowFor` currently returns the full history unchanged. Its plan reports
estimated tokens and `overBudget`; `dropped` is empty and `summarized` is false.
It does not enforce a context limit or perform compaction. The session harness
owns its separate compaction mechanism.

`resolveWindow` chooses the explicit model window, then a matching entry in
`CONTEXT_WINDOWS`, then `FALLBACK_WINDOW`. `resolveBudget` reserves output tokens
and a safety margin. `effectiveLimit` applies a high-water ratio and optional
hard cap. The default high-water ratio in `SessionWindow` is 0.8.

The default `estimatingCounter` uses a heuristic rather than a tokenizer. Supply
an alternative `TokenCounter` through `SessionWindowOptions.counter` when needed.
`recordUsage` stores actual input usage and its change between turns in memory;
it does not recalibrate the counter or persist that bookkeeping.

## Cache directives

`cacheDirectivesFor` returns options for the resolved provider family:

| Family | Returned options |
| --- | --- |
| Anthropic | An anchor breakpoint with `cacheControl: { type: "ephemeral" }`, plus an optional TTL override |
| OpenAI | Request-level `promptCacheKey` when `sessionId` is supplied |
| Google | Request-level `cachedContent` when a resource name is supplied |
| Unknown or disabled | No directives |

`resolveCacheProvider` checks the explicit provider and then the model id.
`mergeProviderOptions` combines option bags without replacing unrelated provider
keys. The session harness applies the returned request and breakpoint options;
these helpers do not create cache resources or guarantee a cache hit.

## Implementation and checks

- `budget.ts`, `counter.ts` and `prepare.ts` implement the sizing calculations.
- `session-window.ts` wraps the store and records usage.
- `cache.ts` implements provider-family rules and option merging.
- Tests live in the package's `src/test/` directory. Run `bun run test` from
  `packages/agents`, or `bun run --cwd packages/agents test` from the repo root.
