# Marbles: findings from guides and recipes

Maintainer note, excluded from the Blume site. Writing a guide or recipe
against the real library is how we learn where the API runs out. Each
finding records the page that found it, what the page does instead today,
and a proposal. When a finding lands, update the page that worked around it
and delete the entry here. Where a proposal here and
[`_api-alt.md`](./_api-alt.md) disagree, settle it in `_api-alt.md`, which
wins.

The technical design that turns these into changes, with files, types,
tests, and an order, is [`_next-api.md`](./_next-api.md). Where it corrects
an entry below, it says so; it wins until the entry is updated.

Each entry has the same parts: **Found by**, **Today**, **The page does
instead**, **Proposal**, and **Open**. A finding that came from use rather
than a page says what changed or what the rule is in place of **The page
does instead**.

## 7. Pass-through to the packages underneath

**Found by** using Marbles for real, 2026-10-09: structured output from an
agent turn was not possible, and the investigation that followed.

**The rule.** Marbles fills in what it owns: the working directory,
cancellation, the step's stream, dry-run echo, replay, and run identity.
Everything else passes through to the package underneath. A default is an
argument filled in, not an option removed. Concretely, each wrapper takes
the underlying options type minus the keys Marbles owns, and returns the
underlying result plus Marbles' own fields. Today most wrappers do the
opposite: they declare a small shape of their own and copy a few fields
across.

Structured output came first and has landed; the other sections are the
same problem in the other context keys. Paths are relative to the repository root.

### 7.1 Agents: structured output and model settings

Landed 2026-10-10 ([`_next-api.md`](./_next-api.md), Part B). Still open:
`tools` and `mcp` on `agent()`, which stay with the `AgentSpec` fields
`_api-alt.md` lists as unwired.

### 7.2 Sandboxes

Landed 2026-10-10 ([`_next-api.md`](./_next-api.md), E.1). Still open: a
files sandbox that also mounts a workspace.

### 7.3 Workspaces

Landed 2026-10-10 ([`_next-api.md`](./_next-api.md), C.1 and E.2). The
workspace system's `on("change")`, `list`, `open`, and `close`, and a
workspace's `rename` and `remove`, stay host operations.

### 7.4 Artifacts

Landed 2026-10-10 ([`_next-api.md`](./_next-api.md), C.2 and E.3). Still
open: `tag`, `freeze`, `fork`, `archive`, and transactions.

### 7.5 Steps and workflows

`.config({ retry, timeout })` and `bail` landed 2026-10-10
([`_next-api.md`](./_next-api.md), E.4). Still open: hooks, `skip`, an
author-side `waitIfPaused`, and structured log fields, which need a form
that does not overload `log(...values)`.

### 7.6 Skills

Bytes, `skills.add(skill)`, and `skills.none()` landed 2026-10-10
([`_next-api.md`](./_next-api.md), E.5). Still open, with 7.1's `tools`
and `mcp`: in a sandbox session, skill instructions are pasted into the
system prompt and the skill's files and registry tools are dropped
(`apps/marbles/src/lib/managers/agents.ts`, `openSandboxSession`).

## 9. A roll cancelled at an ask is not saved

**Found by** use, 2026-10-10, while landing `_next-api.md` C.3. Not yet
investigated; it may predate C.3.

**Reproduction.** A workspace with `step("asks").do(({ ask }) =>
ask.question({ title: "Name?" }))` and a state dir. `marbles roll asks
--state <dir>` prints, before its one-line cancellation:

```text
[state] run rn-… not saved: InconsistentStoreSnapshotError: Run rn-… status suspended conflicts with terminal frame cancelled
```

twice. The run is cancelled at the ask as intended, but its record is not
written, so `status` and the dashboard may not show it.

**Proposal.** Find where the engine saves a run cancelled while suspended
(the run row says `suspended`, its frame says `cancelled`), and settle the
run's status before the save.

## 10. A step that returns a Date hangs its run

**Found by** use, 2026-10-10, while landing `_next-api.md` E.3, whose
artifact versions first carried `Date` fields.

**Reproduction.** `step("dated").do(() => ({ when: new Date() }))`,
launched on a started engine: the run never settles, and the test times
out. Step results are documented as JSON-serializable, but nothing says so
when one is not.

**Proposal.** Find where the result is checked or serialized (likely the
workflows package's step snapshot schema), and fail the step with a clear
message naming the step and the value's path, rather than hanging.

