---
status: accepted
---

# Usage keeps nothing; a query reads it as it is now

Usage is never tracked. A query asks each account's provider for its limits
and reads its consumption from the history its own client already writes,
such as Claude Code's and Codex's session files, and the answer is built
for that moment and dropped after it. We chose this because what callers
need is usage as it is now, which the providers and their clients already
hold; keeping our own copy only adds a second, staler truth to reconcile.

## Considered options

- **Record usage in Marbles as work happens.** The first attempt captured
  every agent turn into per-turn records, persisted provider windows across
  processes, and merged live rate-limit events from running turns with
  on-demand reads. It worked, but it spread one concept across the drivers,
  the session store, the sandbox and the engine, and needed merge rules,
  jitter handling and attribution to stay correct. Rejected.
- **Cache readings with a maximum age.** Rejected with storage: a caller
  that wants to ask less often holds the last snapshot itself.

## Consequences

- Asking takes as long as the providers take, a second or two per login.
- Consumption covers work done outside Foundry too, since it is the
  clients' whole history.
- What work was for is not known here. A caller that knows, such as
  Foundry mapping sessions to runs, groups by session itself.
- An API key has no local history, so its consumption is absent.
