---
title: Plan and build
description: Have an agent plan and implement the task on its own branch in a worktree, then hand the commit to verification.
---

The build stage gives each task its own branch, `factory/<task id>`, and
works in a throwaway worktree so your checkout is never touched. An agent
plans against the task's criteria, implements, and commits. The stage
returns the commit, and `factory-change` hands it to verification.

Save this as `.foundry/marbles/_factory/build.ts`:

<include>./_example/_factory/build.ts</include>

## What the step does

- **Picks the branch.** A first attempt creates the branch from `HEAD`. A
  revision checks out the existing branch, so the builder adds a commit on
  top of its earlier work.
- **Works in a worktree.** Commands and the agent session opened inside
  `withWorktree` use the checkout as their working directory. The checkout
  is removed when the callback returns; the branch and its commits stay.
- **Checks the result.** The builder must leave a new commit and a clean
  checkout. Anything else fails the step, and the failure is flagged on the
  task by the [revision loop](/marbles/use-cases/software-factory/revise).
- **Returns the commit.** The step's result is the commit SHA, plain JSON
  that the next stage can check out. It enqueues nothing. In
  `factory-change` it is the `commit` child of `factory-verify`, so its
  result becomes verification's input in the same run.

The step has a 30-minute timeout and no `retry`. A retry would run the
whole body again with a fresh agent turn, starting from whatever the
failed attempt had already committed on the branch. A failed build fails the run
instead, and the [revision loop](/marbles/use-cases/software-factory/revise)
flags it for a person.

## One agent or two

This builder plans and implements in one session. To review the plan
before any code is written, split it: a `factory-plan` step whose agent
writes the plan to task metadata, then `ask.approval` on the plan in its
own step, then the build. The [approval
pattern](/marbles/use-cases/software-factory/deliver#why-two-steps) is the
same one delivery uses.

To route the builder by quota, declare it with a function and read
[`usage`](/marbles/concepts/usage#let-the-agent-pick-its-own-route).

## Try the stage alone

With the dispatcher not yet attached, you can run one build directly. Claim
a task first, since the dispatcher normally does:

```sh
marbles tasks start <task id>
marbles run factory-build --input '{"task":"<task id>"}'
```

The build stops at its commit and starts no verification. To run the whole
line for that task, run `factory-change` with the same input instead.

Next: [Verify in parallel](/marbles/use-cases/software-factory/verify).
