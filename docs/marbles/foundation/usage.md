---
title: Usage
description: Read what each Claude Code and Codex login has left, and pick a model from it.
---

`usage` tells a step how much of each subscription is used and when it
comes back, as it is at the moment the step asks. Marbles exports it and adds
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
  const claude = provider ? undefined : await usage.query("anthropic");
  const chosen =
    provider ?? (claude?.weekly?.exhausted ? "codex" : "claude-code");
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

When the limits read fails, `claude.failed` says why and `weekly` is
absent, so this step stays on Claude. `usage.query` rejects a name that was
never added, such as `anthropic` on a machine where Claude Code is not
signed in. A snapshot holds dates, which a step result cannot carry, so
return the fields you need rather than the snapshot.

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
