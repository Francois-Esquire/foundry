---
title: Close the loop
description: Send findings back to the builder, cap the attempts, keep the reviewer's memory, and flag runs that fail.
---

A factory that only moves forward stalls on the first blocker. The revision
loop sends findings back to the builder, keeps the reviewer's conversation
across attempts, and hands the task to a person when the loop stops making
progress.

Save this as `.foundry/marbles/_factory/revise.ts`:

<include>./_example/_factory/revise.ts</include>

## Send work back

`sendBack` is called by the verdict when a commit needs changes, and by the
ship step when a person declines. It writes the findings and the attempt
count to the task's metadata and reopens the task in one atomic batch. The
reopened task is ready again, so the dispatcher launches another build.
The builder reads the findings through `brief` and commits on the same
branch.

After three attempts, `sendBack` stops reopening. It retags the task
`needs-owner`, which takes it out of the dispatcher's query. A person reads
the findings and changes the task or the code. To resume, reset the count,
restore the tag, and reopen the task:

```sh
marbles tasks update <task id> --tag factory --metadata '{"attempts":0}'
marbles tasks reopen <task id>
```

Or close it with `marbles tasks cancel <task id>`.

## Keep the reviewer's memory

The review step stores its `session.ref` on the task. On the next attempt
it continues that session, so the reviewer remembers its earlier findings
and can say which ones the new commit resolved. Each review is a new run
continuing an old conversation; it does not resume the earlier run.

The reference pins the conversation to the provider instance that opened
it. If you change the reviewer's provider, clear `reviewer` from the task's
metadata to start a fresh conversation:

```sh
marbles tasks update <task id> --metadata '{"reviewer":null}'
```

## Flag failed runs

`factoryFailures` observes runs and receives only `run.failed` facts. It
reads the run with `runs.get(runId)`. Every factory run carries the task
id in its input, so the observer finds the task without a lookup table,
even when the run failed before writing anything. It records the stage and
error on the task and retags it `needs-owner`. Resume it the same way once
the cause is fixed.

`marbles tasks list --tag needs-owner --json` is the factory's inbox. The
[release patrol's digest](/marbles/use-cases/release-patrol#make-it-yours)
lists these tasks every weekday.

## What you have

The whole factory is five stages of ordinary marbles. Each stage runs on
its own with `marbles roll`, every run is visible in the dashboard, and the
only place work waits on a person is the approval. Start supervised, and
read every diff the factory ships until you trust it.
