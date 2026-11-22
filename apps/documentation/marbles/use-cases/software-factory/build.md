---
title: Plan and build
description: Have an agent plan and implement the task on its own branch in a worktree, then hand the commit to verification.
---

The build stage gives each task its own branch, `factory/<task id>`, and
works in a throwaway worktree so your checkout is never touched. An agent
plans against the task's criteria, implements, and commits. The stage
records the commit and launches verification with it.

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
- **Hands off.** `verify.launch(...)` starts verification as a separate run
  with the commit as input and returns at once. The build run completes;
  verification shows up as its own run on the dashboard.

The step has a 30-minute timeout and no `retry`. A retry would run the
whole body again, with a fresh agent turn, and nothing promises it would
not launch verification a second time.

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
marbles roll factory-build --input '{"task":"<task id>"}'
```

`verify.ts` is imported by this file, so complete [Verify in
parallel](/marbles/use-cases/software-factory/verify) first.

Next: [Verify in parallel](/marbles/use-cases/software-factory/verify).
