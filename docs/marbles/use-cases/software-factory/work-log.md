---
title: Keep a work log
description: Use one artifact per issue to retain intent, evidence, decisions, and handoffs.
---

Give each issue one artifact named by repository and issue number. Every
stage writes a new version. The next run reads its current record.

| File | Purpose |
| --- | --- |
| `record.json` | Current issue snapshot, plan, candidate, review, decision, and event history. |
| `chronicle.md` | The same history in reading order, with timestamps and run IDs. |
| `issue.md` | The captured issue body. |
| `attempts/<number>/tests.json` | Command exit codes, stdout, and stderr for that attempt. |

The work log records the original request, plan, each implementation
explanation and commit, failed checks, review findings, decisions, and
on-call handoffs. Agent conversations can continue, but each reviewer also
receives the written record. It need not reconstruct the task from memory.

## Define the record

Create `.foundry/marbles/_factory/record.ts`. Set `repository` and
`baseBranch` to match your checkout:

<include>./_example/_factory/record.ts</include>

[Artifacts](https://github.com/Francois-Esquire/foundry/blob/main/packages/artifacts/README.md)
keeps the versions. `replace: false` retains earlier evidence files when a
stage adds new ones. Each version contains the full event history so far.
This is a work log, not a transactional queue. Concurrent writers can
replace one another's changes; serialize work for the same issue.

## Capture the issue

Create `.foundry/marbles/_factory/intake.ts`:

<include>./_example/_factory/intake.ts</include>

This step reads the issue, fetches `origin`, and pins the starting commit.
Fetching updates remote refs. It does not switch branches or merge into
your checkout. Later stages use the recorded SHA.

Create `.foundry/marbles/factory.ts`:

<include>./_example/_intake.ts</include>

Run it with an open issue that has acceptance criteria:

```sh
marbles list
marbles roll factory --input '{"issue":42}'
```

Inspect the returned issue, base SHA, and `intake` event. Artifact versions
live in the [artifact store](/marbles/reference/state#persisted-state), which
is separate from the temporary Git worktrees used later.

Rerunning `factory` reads the existing record. Finished stages return their
recorded result, so you can extend the walkthrough using the same issue.
A planning failure before implementation can be retried after updating the
issue. For a candidate that needs changes, use the revision chapter instead.

The log records completed writes and captured failures. A process killed
between a Git or GitHub operation and its log write can leave external work
ahead of the record. Reconcile the branch or pull request before continuing.
[Durability](/marbles/foundation/durability) explains that boundary.

Next: [Plan the work](/marbles/use-cases/software-factory/plan).
