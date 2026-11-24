---
title: Approve and deliver
description: Park the verified commit on an approval, then push it and open or update its pull request.
---

Nothing leaves your machine until a person approves. Delivery is a
two-step workflow: the first step asks, the second pushes the approved
commit and opens or updates its pull request.

Save this as `.foundry/marbles/_factory/deliver.ts`:

<include>./_example/_factory/deliver.ts</include>

## Answer the approval

When verification passes, `factory-deliver` starts and parks on
`ask.approval`. Open `marbles`, press `Shift+F` for the Feed, and read the
request. It names the branch, the commit, and the artifact version holding
the test output and review. The verification report sits beside it in the
Feed. Choose approve or decline, with an optional note.

The parked run waits as long as it needs to. Quitting the dashboard,
`marbles daemon stop`, or a crash leaves it parked, and the next dashboard shows it
again.

## Why two steps

When the answer arrives, the approval step's body runs again from the top
and reads the recorded answer. Anything before `ask.approval` in that body
runs twice. Keeping the push in a later step means it runs once, after the
answer, and never on replay. [Durability](/marbles/concepts/durability#ask-a-person)
explains the rule.

`factory-ship` also checks that the branch still points at the approved
commit. If someone pushed to it in the meantime, the step fails rather
than shipping code nobody approved.

## On approval and decline

- **Approved.** The step pushes the branch, reuses an open pull request for
  it or creates one, stores the URL on the task, and completes the task.
- **Declined.** `sendBack` records the note as findings and reopens the
  task, so the builder addresses the note on its next attempt.

Merging stays with you and your repository's review rules.

Next: [Close the loop](/marbles/use-cases/software-factory/revise).
