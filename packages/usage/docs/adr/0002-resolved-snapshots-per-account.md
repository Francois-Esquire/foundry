---
status: accepted
---

# Consumers read resolved snapshots per account; provider authors get the building blocks

A snapshot describes one named account, and everything a consumer asks of
it is already answered on it: `claude.weekly.usedPercent`,
`claude.weekly.headroom`, `claude.hourly.resetsIn`, `claude.weekly.exhausted`.
A query for one name returns that account's snapshot; a query with nothing
named returns one per account. The building blocks that turn a provider's
report into limits live in a separate entry, `@foundry/usage/provider`,
which only provider authors import. We chose this because a snapshot is
the answer for one moment, so everything that follows from it can be worked
out when it is built, and a consumer should read an answer, not assemble
one.

## Considered options

- **The first cut (replaced).** A single snapshot held every account, found
  with `snapshot.of(account)` and `account.window("weekly-window")`, and a
  consumer computed what followed with exported functions: `headroom`,
  `resetsIn`, `exhausted`. That made every consumer import helpers and do
  work the package could already have done, and mixed the provider author's
  tools into the consumer's API.
- **A snapshot class with getters.** Rejected: a getter recomputes against
  the clock at read time, so `resetsIn` would drift from the moment the
  snapshot describes, and getters are lost when a snapshot crosses MCP or
  is logged as JSON. Resolved fields stay true to their moment and stay
  plain data.

## Consequences

- Window ids such as `weekly-window` became spans: `hourly`, `weekly`,
  `monthly`, `custom`. Claude's five-hour window is the hourly one; its
  duration says five hours.
- Accounts are named. Default accounts are named after their provider,
  `anthropic` and `openai`, and `usage.initialize()` adds them.
- What a caller adds is an **account**: a name, its provider, and the
  credential that reaches it. Who the provider says it is, the account's
  **identity**, is read into each snapshot. Two accounts with the same
  identity get a snapshot each.
- `resetsIn` is measured from the snapshot's own `at`, not from whenever it
  is read.
- Each limit is reached one way. The `windows` list, which repeated the
  named windows, is gone; a window whose span is custom is listed in
  `custom`. Of two account-wide windows of one span, two per-model windows
  of one slug, or two limits of one kind, the first reported is kept, and a
  per-model window with no account-wide window of its span is dropped.
- Failures are grouped in `errors`, as `limits` and `consumption`, present
  only when a read failed. `unsupported` is not an error: it says what the
  credential is.
- `usage.initialize()` returns the default accounts now added, not their
  names, so a caller can read each one's provider and credential.
