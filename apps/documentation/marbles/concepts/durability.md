---
title: Durability, approvals, and local state
description: What Marbles keeps, how a run waits for a person, how replay and retry differ, and where the local process keeps its state.
sidebar:
  label: Durability and approvals
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

## Ask a person

`ask.approval(...)` waits for a decision, and `ask.question(...)` waits for
an answer:

```ts
const decision = await ask.approval({ body: findings, title: "Publish this revision?" });
const region = await ask.question({ choices: ["us", "eu"], title: "Which region?" });
```

`approval` returns `{ approved, note? }`, and `question` returns a string.
While it waits, the run is **parked**: its state is saved, and the question
waits in the dashboard's Feed. An approval blocks the run until someone
decides. A question holds its step while siblings keep going.

Only a dashboard answers. `marbles run` and piped `marbles` leave the run parked
until one does, and `--dry-run` cancels it at the ask. A parked run
survives a quit, a `marbles daemon stop`, and a crash.

When the answer comes, the step body starts again from the top and reads
the recorded answer at the same call. That is replay, below. Put an
approval at the start of its own step, with the work it authorizes in a
later step, so nothing before the ask runs twice. The [Software
Factory](/marbles/use-cases/software-factory/deliver) gates a push this way.

## What the run remembers

| Part | Guarantee |
| --- | --- |
| Finished step | Its recorded result is reused when the same run continues. A new run executes fresh work, unless its key matches an earlier enqueue. |
| Waiting question or pause | The parked run is saved. The current engine generation adopts it with the same source and state, after a restart or a switch; a dashboard answers it. |
| Managed operations | Recorded sessions, answers, and artifact writes are matched by step path and call position during replay. |
| Agent conversation | Messages live in the session store. A session reference can continue that conversation in another run. |
| Artifact | A declared output has stable identity and content versions, independent of a temporary checkout. |
| Failed attempt | The runtime applies the step's retry policy, if configured. An exhausted policy leaves a failed run. |

A run's state is committed to the Marbles database as it changes: when it
starts, parks, resumes and settles. A committed state contains the finished results available at that point; Marbles
does not checkpoint every instruction or every completed child to disk.

## Agent execution belongs to a step

Consider a workflow that reviews code, asks for approval, then saves a
report. While approval waits, the completed review step keeps its findings.
The unfinished approval step is the work that must continue.

The [session bindings](/marbles/concepts/agents-and-sessions#how-the-session-joins-the-workflow)
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
| `definition.enqueue(...)`, `step.enqueue(name, ...)` | Returns the run it enqueued before, for the same definition at that position. Another definition is enqueued. With a `key`, a retried attempt gets the same run back too. |
| Command, raw filesystem write, or `fetch` | Can execute again. The run does not make arbitrary external effects happen exactly once. |

Keep step keys and managed call order stable while a run is parked. Put
non-repeatable work in a preceding child step, and put an approval at the
start of its own step. The [factory's delivery step](/marbles/use-cases/software-factory/deliver)
shows this arrangement. Return JSON data and durable references such as
commit SHAs and artifact version IDs across step boundaries, rather than
temporary paths or live handles.

## Retry a failed attempt

With an [authenticated agent CLI](/marbles/concepts/agents-and-sessions),
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

Run `marbles run review-with-retries`. A thrown error can trigger another
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

The engine generation hosting a workspace adopts a saved parked run when
its definition is still registered and its claim on it is free: its
previous owner is gone, or was a generation that retired and let it go,
at the switch or the moment it parked afterwards. Keep the workspace path
and state stores stable. The generation rebuilds the workflow tree, restores its recorded inputs,
and waits for the answer or resume action, which a dashboard gives. Workflow
setup must therefore stay free of work that should only happen once.

A run interrupted mid-body is not automatically resumed. If the Marbles
database records its Run as running or queued, Marbles leaves it orphaned
rather than adopting it. Launching the automation again creates a new run, which can
repeat earlier effects. An enqueue with the same key gets the orphaned run
back instead, so give the retry a new key. See [state and adoption rules](/marbles/reference/state#what-survives-a-restart).

## Design work that can repeat safely

Use an idempotency key when an external API supports it, check whether an
intended change already exists, and keep irreversible work separate from
retryable reads. Marbles has one for its own runs:
`definition.enqueue(input, { key })` returns the run an earlier enqueue with
that key started, from any engine over the same store, so an observer
delivered a change twice or a retried step still enqueues once. See
[enqueue once per key](/marbles/concepts/steps-and-workflows#enqueue-once-per-key). Cancellation stops owned operations; it does not roll
back commits, sent requests, or file changes. Persist output as an
[artifact](/marbles/concepts/workspaces-and-artifacts#artifacts-and-the-feed) or a commit before
discarding a temporary worktree or sandbox.

Durability also depends on the host keeping its stores. It does not provide
distributed locking, recreate a lost sandbox guest, or validate a model's
judgment. [Local execution and state](#local-execution-and-state)
explains the process lifecycle; [remote execution](/marbles/reference/remote)
applies the same guarantees to another host.

## Local execution and state

The CLI hosts Marbles on your machine. A command can dispatch one run and
exit, or stay open to launch runs and answer questions, while the Marbles
process keeps schedules and monitors running.

A process and a run have different lifetimes. Starting the CLI loads your
modules and runtime; launching an automation creates a run within that
runtime. Keeping a dashboard open does not turn all its launches into one run.

### From a module to a result

| Stage | What the CLI does | What your module does |
| --- | --- | --- |
| Discover | Finds and imports automation modules. | Declares named work, resources, and triggers. |
| Bind | Prepares workspaces, providers, stores, and resource managers. | Supplies definitions that describe what it needs. |
| Launch | Starts a run with validated input. | Builds a workflow tree, or supplies a single step. |
| Execute | Runs the steps in dependency order. | Uses the execution context and returns results. |
| Retain | Saves run outcomes and updates the relevant stores. | Writes reports or artifacts that future work needs. |

This is the declaration-and-execution distinction from the earlier pages,
now applied to a real process. Top-level module code executes during import,
including for inspection commands. Step bodies execute when launched.

### Choose the process lifetime

| Mode | Lifetime |
| --- | --- |
| `marbles run <name-or-key>` | Run one step, workflow, schedule, or monitor in the Marbles process's current engine generation, wait for it, and exit. A question parks the run until a dashboard answers it. |
| `marbles enqueue <name>` | Queue one step or workflow in the Marbles process, print its run ID, and exit without waiting. `marbles watch <runId>` follows it. |
| `marbles` | Attach the workspace and open the dashboard on it: launches, answers, and every hosted workspace. |
| `marbles` with piped input or output | Attach the workspace and follow its status lines with plain output. Cannot answer a question. |
| `marbles daemon`, `marbles daemon stop` | Run the Marbles process in the foreground, or stop it with every workspace it hosts. |

Each of the first four attaches the workspace to the Marbles process, one
per machine, which starts when none runs and keeps the workspace's
schedules and monitors ticking after the command exits; `marbles run` executes one
target immediately on top of that, and `marbles enqueue` queues one. All modes use the same workspace state.
Editing a module starts the Marbles process's next engine generation, which takes over once it has loaded; nothing needs restarting.
`--dry-run` hosts the workspace in the command's own process instead and
persists nothing. See the [CLI reference](/marbles/reference/cli) for
commands and controls.

### How many runs at once

Every run of a workspace's steps and workflows waits in one queue for a
place to run. A hosted workspace runs up to eight at once, and the ninth
waits as `queued` until one ends. Set the number once per workspace, in any one
module:

```ts
import { queue } from "@foundry.sh/marbles";

queue({ concurrency: 2 });
```

`concurrency` is a positive integer or `Infinity`. A second `queue()` call
in the same workspace is an error, and there are no named queues yet.
These runs do not hold a place:

- **A parked run.** A run waiting on a question or a pause gives its place
  up until it resumes.
- **A run awaiting an enqueued run.** A step that reads `result` of a run it
  enqueued gives its run's place up until that result settles, so awaiting
  an enqueued run never deadlocks, even at `queue({ concurrency: 1 })`.

A plain `bun` script's default engine also runs eight at once and honors
its own `queue()`. An [`Engine`](/marbles/reference/engine#host-settings)
you construct runs one at a time unless you pass `queues`.

### Different stores remember different things

| State | What it answers |
| --- | --- |
| Run snapshot | Which steps finished, what they returned, and whether this run is waiting. |
| Agent session | Which messages belong to this conversation. |
| Artifact content | Which files and evidence a particular output version contains. |
| Trigger state | When a schedule finished or which observation a monitor last handled. |
| Tasks and change facts | What there is to do, and which committed changes each observer has handled. |

[Workflows](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md),
[Agents](https://github.com/Francois-Esquire/foundry/blob/main/packages/agents/README.md),
and [Artifacts](https://github.com/Francois-Esquire/foundry/blob/main/packages/artifacts/README.md)
supply the underlying contracts. Marbles connects their records and provides
local persistent stores by default. A transcript alone cannot tell the
workflow which steps finished; a run snapshot alone does not contain every
artifact's file bytes.

Run and session state belongs to the canonical workspace path, under
`~/.foundry/marbles/<workspace-id>/` by default. Artifact content lives
separately under `~/.foundry/artifacts/`. Preserve both when moving or backing
up an automation. The [state reference](/marbles/reference/state) documents
the files and their ownership rules.

### What a restart keeps

A new engine generation reads the saved state. It adopts a parked run when its
definition remains available and its previous ownership has ended, and the
question waits on the Feed for a dashboard. A run interrupted while
actively executing is not adopted.
[Recovery after a restart](#recovery-after-a-restart) explains the boundary
and why a fresh launch can repeat earlier work.

Under `--dry-run`, Marbles keeps its state in memory and substitutes managed
operations. Ordinary TypeScript and monitor I/O still execute. See
[safety and limits](/marbles/reference/safety) for the precise boundary.

An [embedding host](/marbles/reference/engine) provides its own package
instances and persistent stores. A [remote host](/marbles/reference/remote)
uses the same process model with its own tools and credentials.

Next: [Foundry primitives](/marbles/concepts/primitives) maps these pieces to
the libraries underneath Marbles.
