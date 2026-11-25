---
title: Software Factory
description: SDLC on the factory floor, built from the same small marbles as everything else.
sidebar:
  label: The factory floor
---

> This factory will not solve your engineering woes. Agents can do
> substantial work, but this guide keeps a person responsible for scope,
> judgment, and what ships. Review the code and its evidence. Loosen that
> supervision only when your own evaluations justify it.

The Software Factory takes a task from intake to a reviewed pull request.
It introduces nothing new. Every piece is a marble from the earlier pages:
a task backlog, an observer that dispatches ready work, steps that run in
a worktree, a parallel check, an artifact of evidence, and an approval that
suspends until a person answers.

The factory is built from smaller factories. `factory-verify` is a whole
workflow you can run on its own, and `factory-change` locks it under the
build, so one run takes a task from a plan to a verdict. Delivery is a
separate run, because it waits on a person.

```text
          ┌──────────── revision loop: findings back on the task ────────────┐
          ▼                                                                  │
intake ─▶ task ─▶ factory-change: build ─▶ factory-verify (tests ∥ review) ─▶ verdict
 (gh)    (ready)  (one run per attempt)                                       │
                                                                              ▼
                                       factory-deliver: approve ─▶ ship (push, PR)
                                       (its own run, once per commit)
```

## The stages

| Stage | Marbles | Page |
| --- | --- | --- |
| Intake | `tasks.create`, `observe(tasks)`, `.enqueue()` with a key | [Take work in](/marbles/use-cases/software-factory/intake) |
| Plan and build | `withWorktree`, an agent session | [Plan and build](/marbles/use-cases/software-factory/build) |
| Parallel verify | A nested `workflow`, `.parallel`, structured output, `report.artifact` | [Verify in parallel](/marbles/use-cases/software-factory/verify) |
| Human gate and deliver | `ask.approval`, a later step that pushes | [Approve and deliver](/marbles/use-cases/software-factory/deliver) |
| Revision loop | Task status, metadata, `observe(workflow)`, `runs.get` | [Close the loop](/marbles/use-cases/software-factory/revise) |

The task is the work record. Its description holds the request and
acceptance criteria. Its metadata holds what the stages learned: attempts,
the last findings, the reviewer's session reference, and the pull request.
Each run carries the task id as input, so any run can be traced back to its
task with `runs.get(id)`.

## The files

The factory is one discovered module and five helpers, about 370 lines in
all:

```text
.foundry/marbles/
  factory.ts          intake step, factory-change, and the dispatcher
  _factory/work.ts    input schemas, the branch name, and the task brief
  _factory/build.ts   plan and build in a worktree
  _factory/verify.ts  tests and review in parallel, then a verdict
  _factory/deliver.ts approval, push, and pull request
  _factory/revise.ts  send work back, and flag failed runs
```

Names starting with `_` are left out of discovery, so the helpers load only
through `factory.ts`. Each stage is still a named step or workflow you can
launch with `marbles run` while you debug it.

## Before you start

Complete [the outer loop](/marbles/get-started/outer-loop). The factory
needs:

- A Git repository with at least one commit and an `origin` remote.
- An authenticated [GitHub CLI](https://cli.github.com/) (`gh auth status`).
- An authenticated agent CLI: Claude Code, Codex, or Pi. Pi also needs
  [`defineProvider(pi)`](/marbles/reference/api#providers) in the workspace's source.
- Bun and a `bun test` suite. Change the commands in `verify.ts` for
  another toolchain.
- `zod@4.4.3` in the project, and the current source checkout of Marbles
  for `.enqueue()` with a key, nested workflows, and `runs`.

Work in a repository you can afford to experiment in. The factory pushes
branches and opens pull requests only after you approve in the dashboard.

A hosted workspace runs up to four runs at once, so four tasks can be on
the floor together, each with its own agent session. Each build holds an
agent for up to 30 minutes. To keep fewer going, set the workspace's queue
once, in any one module:

```ts
import { queue } from "@foundry.sh/marbles";

export default defineConfig({ pools: { default: 2 } });
```

A delivery suspended on its approval does not hold a place in the queue. See
[how many runs at once](/marbles/concepts/durability#how-many-runs-at-once).

## Where to grow it

The factory is a starting point. Add a [docs drift
watcher](/marbles/use-cases/docs-drift) or a [release
patrol](/marbles/use-cases/release-patrol) that tags its tasks `factory`.
Run [evaluations](/marbles/use-cases/evaluations) before changing the
builder's or reviewer's prompts and skills. Keep separate records for an
issue, a review, and an evaluation trial, and link them by task id, commit,
and artifact version.

Start with [taking work in](/marbles/use-cases/software-factory/intake).
