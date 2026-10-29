---
title: Durability
description: How Marbles records work, owns agent execution, retries failures, and resumes parked runs.
---

Durability means retaining completed work and enough state to continue
from a supported waiting point. A workflow can finish its review, wait for
a person, and continue using the recorded review result. Agent sessions and
artifact versions keep their own records alongside the run.

These facilities come from the [Workflows runtime](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md)
and Marbles' integration with [Agents](https://github.com/Francois-Esquire/foundry/blob/main/packages/agents/README.md)
and [Artifacts](https://github.com/Francois-Esquire/foundry/blob/main/packages/artifacts/README.md).
You get the execution machinery with the CLI; no separate queue or retry
service is needed for local use.

Retries are available when configured on a step. Restart recovery adopts
parked runs; it does not resume work interrupted mid-execution. The CLI
persists state by default, while `--dry-run` keeps its state in memory.

## What the run remembers

| Part | Guarantee |
| --- | --- |
| Finished step | Its recorded result is reused when the same run continues. A new launch executes fresh work. |
| Waiting question or pause | The parked run is saved. A later answering dashboard can adopt it with the same source and state. |
| Managed operations | Recorded sessions, answers, and artifact writes are matched by step path and call position during replay. |
| Agent conversation | Messages live in the session store. A session reference can continue that conversation in another run. |
| Artifact | A declared output has stable identity and content versions, independent of a temporary checkout. |
| Failed attempt | The runtime applies the step's retry policy, if configured. An exhausted policy leaves a failed run. |

Run snapshots are saved at suspension, resumption, and settlement. A saved
snapshot contains the finished results available at that point; Marbles
does not checkpoint every instruction or every completed child to disk.

## Agent execution belongs to a step

Consider a workflow that reviews code, asks for approval, then saves a
report. While approval waits, the completed review step keeps its findings.
The unfinished approval step is the work that must continue.

The [session bindings](/marbles/foundation/agents-and-sessions#how-the-session-joins-the-workflow)
connect the agent to this run. The session keeps the conversation; the
workflow records that the review step completed. Keeping one does not
replace keeping the other. The [Software Factory](/marbles/use-cases/software-factory)
uses these boundaries for implementation, verification, approval, and reporting.

## Replay is different from retry

Continuing a waiting step is replay; repeating a failed attempt is retry.
After a question is answered or a pause is resumed, the unfinished step
body starts again from the top. This is **replay**. Its recorded operations
reconnect it to the work already done:

| Operation in the replayed body | What happens |
| --- | --- |
| `agents.session(...)` | Reopens the recorded session at that call position, with its transcript. |
| `session.generate(...)` or `session.stream(...)` | Sends a turn to that session again if execution reaches the call. Session continuity does not cache each explicit turn. |
| `agentInstance.generate(...)` or `.stream(...)` | Reuses a recorded completed one-shot reply when available; an unfinished turn can execute again. |
| `ask.*` | Reads the recorded answer, or parks at an unanswered question. |
| Managed artifact write | Returns its recorded version instead of creating another version at that position. |
| Command, raw filesystem write, or `fetch` | Can execute again. The run does not make arbitrary external effects happen exactly once. |

Keep step keys and managed call order stable while a run is parked. Put
non-repeatable work in a preceding child step, and put an approval at the
start of its own step. The [approval chapter](/marbles/use-cases/software-factory/development/approve)
shows this arrangement. Return JSON data and durable references such as
commit SHAs and artifact version IDs across step boundaries, rather than
temporary paths or live handles.

## Retry a failed attempt

With an [authenticated agent CLI](/marbles/foundation/agents-and-sessions),
save this module as `.foundry/marbles/review-with-retries.ts`:

```ts
import { agent, step } from "@foundry.sh/marbles";

const reviewer = agent({
  prompt:
    "Review README.md for clarity. Report findings without editing files.",
});

step("review-with-retries")
  .config({
    retry: {
      maxAttempts: 3,
      backoff: { kind: "exponential", initial: "1s", max: "10s" },
    },
    timeout: "5m",
  })
  .do(
    async () => (await reviewer.generate("Review the current README.md.")).text
  );
```

Run `marbles roll review-with-retries`. A thrown error can trigger another
attempt, up to three attempts **including the first**. Each attempt has a
five-minute deadline. The policy belongs to this step; it does not set the
policy for its children or every agent in the project.

A retry runs the failed body again with fresh managed operations. It can
send another model request, repeat a command, or write another artifact
version. Finished child steps in the same run keep their results. Without
`retry`, a thrown error fails the step immediately; `bail(error)` ends a step
without retry even when a policy exists. Use `shouldRetry` to select which
errors warrant another attempt. See the [builder options](/marbles/reference/api#the-builder).

## Recovery after a restart

The worker hosting a workspace adopts a saved parked run when its
definition is still registered, its previous owner is gone, and its
ownership lock is available. Keep the workspace path and state stores
stable. The worker rebuilds the workflow tree, restores its recorded inputs,
and waits for the answer or resume action, which a dashboard gives. Workflow setup must therefore stay free of work
that should only happen once.

A run interrupted mid-body is not automatically resumed. If a run file
records it as running or queued, Marbles leaves it orphaned rather than
adopting it. Launching the automation again creates a new run, which can
repeat earlier effects. See [state and adoption rules](/marbles/reference/state#what-survives-a-restart).

## Design work that can repeat safely

Use an idempotency key when an external API supports it, check whether an
intended change already exists, and keep irreversible work separate from
retryable reads. Cancellation stops owned operations; it does not roll
back commits, sent requests, or file changes. Persist output as an
[artifact](/marbles/foundation/artifacts-and-results) or a commit before
discarding a temporary worktree or sandbox.

Durability also depends on the host keeping its stores. It does not provide
distributed locking, recreate a lost sandbox guest, or validate a model's
judgment. [Execution and state](/marbles/foundation/execution-and-state)
explains the process lifecycle; [remote execution](/marbles/reference/remote)
applies the same guarantees to another host.

Next: [Schedules and monitors](/marbles/foundation/triggers) starts new
runs automatically, using the same work and durability rules.
