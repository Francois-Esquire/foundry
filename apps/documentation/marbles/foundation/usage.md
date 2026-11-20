---
title: Usage
description: Read remaining subscription allowance or API budget and use it to pick a model.
---

`usage` tells a step what an account has used, what is left, and when it
resets. Marbles exports it and adds
the machine's signed-in Claude Code and Codex logins when it starts, named
`anthropic` and `openai`, so a step can query them without setting anything
up. These capabilities come from
[Usage](https://github.com/Francois-Esquire/foundry/blob/main/packages/usage/README.md).

```ts
import { usage } from "@foundry.sh/marbles";

const claude = await usage.query("anthropic");

claude.weekly?.usedPercent; // 53
claude.weekly?.headroom.share; // 0.47
claude.hourly?.resetsIn; // ms until the hourly window resets
claude.weekly?.exhausted; // false
claude.consumption?.total; // tokens used since the weekly window opened
```

`usage.query()` with no name returns a snapshot for every account.

When a routing decision only needs the remaining allowance, use
`await usage.share("anthropic")`. It reads the current account-wide weekly
window and returns a fraction from 0 to 1. Pass a span such as `"hourly"` to
read another window. A missing account, failed read, or missing window returns
`undefined`. This read skips consumption history.

## Read a dollar budget

Register a named billing account with your company's monthly allocation in
USD and a provider admin API key. This example reads an OpenAI project's
spend for the current UTC calendar month.

```ts
import { usage } from "@foundry.sh/marbles";

usage.add({
  name: "work",
  provider: "openai",
  billing: {
    adminKey: process.env.OPENAI_ADMIN_KEY!,
    cap: 500,
    projectId: "proj_work",
  },
});

const budget = await usage.budget("work");
budget?.spent; // 180 USD
budget?.remaining; // 320 USD
budget?.share; // 0.64
```

Use `provider: "anthropic"` and `workspaceId` for an Anthropic workspace.
Omit the project or workspace ID to read spending for the entire
organization. Register the account once during setup. Changing `cap` in
that setup changes the allocation used by Marbles. The provider manages
the limits it enforces.

`usage.budget("anthropic")` also works when a default Claude Code login
reports a dollar spend cap. The read returns `undefined` when the cap or
its spend is unavailable. Billing reports can lag behind activity. Use
`startsAt` and `resetsAt` when the period is known, and `reportedThrough`
when the provider supplies a freshness timestamp.

### Use a shared company budget

When several harnesses charge the same account, register that account
once and read its combined spend. Omit `provider` and supply your company's
spend reader. It returns USD `spent` and the active period's `startsAt`
and `resetsAt` as dates.

```ts
usage.add({
  name: "shared",
  billing: {
    cap: 500,
    readSpend: () => companyBilling.currentWeek(),
  },
});

const budget = await usage.budget("shared");
```

The reader runs when you query the account. It can read the billing
backend directly or read a snapshot refreshed by a schedule. A snapshot
from an expired period yields `undefined` until the reader has the new
period's spend.

## Pick a model from what is left

Define an agent without a route, then give it one with `extend` when the
step knows which model should run it:

```ts
import { agent, step, usage } from "@foundry.sh/marbles";

const reviewer = agent({ prompt: "Review the changes in this working tree." });

export const review = step("review").do(async ({ agents }) => {
  const claude = await usage.query("anthropic");
  const route = claude.weekly?.exhausted
    ? { provider: "codex" }
    : { provider: "claude-code" };
  const session = await agents.session(reviewer.extend(route));
  return (await session.generate("Review the uncommitted changes.")).text;
});
```

The extended agent keeps the reviewer's id, so approvals you gave the
reviewer apply on either model.
[Agents and sessions](/marbles/foundation/agents-and-sessions#choose-the-route-when-the-step-runs)
covers how `extend` merges settings.

## Let the agent pick its own route

An agent can also be declared with a function that returns its definition.
Marbles calls it each time a session for the agent opens, so the agent
reads usage at that moment and picks the skills and MCP servers that suit
the route it chose:

```ts
import { agent, skills, step, usage } from "@foundry.sh/marbles";

const reviewer = agent(async ({ provider }) => {
  const remaining = provider ? undefined : await usage.share("anthropic");
  const chosen =
    provider ?? (remaining !== undefined && remaining < 0.2 ? "codex" : "claude-code");
  return {
    prompt: "Review the changes in this working tree.",
    provider: chosen,
    skills: skills
      .load()
      .pick(chosen === "codex" ? "codex-review" : "claude-review"),
  };
});

export const review = step("review").do(
  async () => (await reviewer.generate("Review the uncommitted changes.")).text
);
```

The function is given the route the session has to keep: the one set by
`reviewer.extend({ provider })` or a dispatch, or the provider a replayed
session was recorded on. Choose from it when it is set, as above. If the
function returns a different provider or model than the one it was given,
the session does not open.

This agent chooses Codex below 20% remaining and uses Claude when no weekly
share is available. Use `usage.query` when you need consumption or the
provider's failure message. `usage.query` rejects a name that was never added.
A snapshot holds dates, which a step result cannot carry, so return the
fields you need from it.

## What a snapshot holds

A snapshot is one account at one moment, as plain data you can log or
return from a step. `limits` lists every limit the provider reported.
`hourly`, `weekly` and `monthly` point at the account-wide window of each
span; a per-model window, such as Claude's weekly Fable window, sits in
`limits` with its `model`. Each limit arrives with its `headroom`, its
`resetsIn` measured from the snapshot's `at`, and whether it is `exhausted`.

Limits and consumption are separate reads. When one fails, `failed` or
`consumptionFailed` says why, and the other is still there.

Claude Code and Codex report their own limits: Usage starts each client
without a prompt, asks it, and closes it, so the query spends no tokens.
Consumption comes from the session history each client already writes,
which means work done outside Marbles counts too. Nothing is stored between
queries, and each one takes a second or two per login, so query once, where
the step makes its decision.
