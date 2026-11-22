---
title: Verify in parallel
description: Run the tests and an agent review of the exact commit side by side, keep the evidence, and decide what happens next.
---

Verification checks the exact commit the build produced. Tests and review
run at the same time, each in its own worktree at that commit. A verdict
step reads both, saves the evidence as an artifact version, and either
launches delivery or sends the task back.

Save this as `.foundry/marbles/_factory/verify.ts`:

<include>./_example/_factory/verify.ts</include>

## The tree

`factory-verify` is a workflow whose root is `verdict` with two parallel
children:

```text
factory-verify
└─ factory-verdict
   ├─ tests    (bun install, bun test in a worktree at the commit)
   └─ review   (agent session in a worktree at the commit)
```

The commit arrives as launch input, and the workflow passes it to every
node as literal input. That is why build launches verification rather than
locking it as a child: data flows only from children to their parent, and a
build locked under both siblings would run twice.

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

- **Passed.** `deliver.launch(...)` starts the delivery run with the
  artifact version id, so the approval names the evidence for this commit.
- **Needs changes.** `sendBack` puts the findings on the task and reopens
  it. The dispatcher sees a ready task and launches another build.

Next: [Approve and deliver](/marbles/use-cases/software-factory/deliver).
