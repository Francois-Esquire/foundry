---
title: Verify in parallel
description: Run the tests and an agent review of the exact commit side by side, keep the evidence, and decide what happens next.
---

Verification checks the exact commit the build produced. Tests and review
run at the same time, each in its own worktree at that commit. A verdict
step reads both, saves the evidence as an artifact version, and either
enqueues delivery or sends the task back.

Save this as `.foundry/marbles/_factory/verify.ts`:

<include>./_example/_factory/verify.ts</include>

## The tree

`factory-verify` is a workflow whose root is `verdict` with two parallel
children. `factory-change`, in `factory.ts`, locks it with the build as its
`commit` child:

```text
factory-change
├─ commit        factory-build (agent session in a worktree, returns the SHA)
└─ $workflow     factory-verdict, the nested factory-verify tree
   ├─ tests      bun install, bun test in a worktree at the commit
   └─ review     agent session in a worktree at the commit
```

The build runs first. Marbles then checks its SHA, with the branch and task
id given as literal input, against `factory-verify`'s input schema, and
calls the workflow's setup. Setup passes that input to every node as
literal input, so both siblings check out the same commit. Locking the
build under each sibling instead would run it twice, since data flows only
from children to their parent.

It all stays one run. The dashboard shows the verification steps under
`$workflow`, and cancelling `factory-change` stops a review in progress.
`factory-verify` still runs on its own, for a commit you already have:

```sh
marbles run factory-verify --input '{"task":"<task id>","branch":"factory/<task id>","commit":"<sha>"}'
```

If one child throws, Marbles aborts the other and fails the run. A failed
test suite is not a throw: `check: false` turns it into an exit code the
verdict reads.

## The review

The reviewer returns structured output, a list of blockers that each name
a file and a problem. Marbles validates the reply against the schema, so
the verdict can count blockers instead of parsing prose. The reviewer's
session continues across attempts; see [keep the reviewer's
memory](/marbles/use-cases/software-factory/revise#keep-the-reviewers-memory).

## The verdict

The commit passes when the tests exit 0 and the review has no blockers.
Either way, `report.artifact` writes a version of **Factory verification**
with the test output and the verdict, and posts the summary to the Feed.

- **Passed.** `deliver.enqueue(...)` starts the delivery run with the
  artifact version id, so the approval names the evidence for this commit.
  Its key, `factory-deliver:<commit>`, asks for one approval per commit.
  Verifying the same commit again, from `marbles run factory-verify` or a
  second engine, gets the existing delivery back.
- **Needs changes.** `sendBack` puts the findings on the task, counts the
  attempt, and reopens it. The dispatcher sees a ready task and enqueues
  another `factory-change` under the next attempt's key.

Delivery is enqueued rather than nested. It parks on an approval that can
wait for days, and as its own run it does that without holding the
verification run open. The verdict keeps only the id, so it finishes at
once.

Next: [Approve and deliver](/marbles/use-cases/software-factory/deliver).
