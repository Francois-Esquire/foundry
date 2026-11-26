# Context sizing and cache directives

`src/contexts/` is internal to `@foundry/agents`; no package entry exports it.
The session harness and the compactor use its two independent sets of
helpers: window estimates and provider cache options. Neither requires a model
registry.

## Window sizing

`resolveBudget` takes the explicit model window, else `FALLBACK_WINDOW`, and
reserves output tokens and a safety margin. `effectiveLimit` applies a
high-water ratio and optional hard cap. The session harness uses both to
decide when to compact, with a default high-water ratio of 0.8.

The default `estimatingCounter` uses a heuristic rather than a tokenizer.
Supply an alternative `TokenCounter` through `SessionWindowOptions.counter`
when needed.

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

- `budget.ts` and `counter.ts` implement the sizing calculations.
- `cache.ts` implements provider-family rules and option merging.
- Tests live in the package's `src/test/` directory. Run `bun run test` from
  `packages/agents`, or `bun run --cwd packages/agents test` from the repo root.
