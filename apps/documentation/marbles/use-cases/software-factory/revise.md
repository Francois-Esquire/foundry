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
reopened task is ready again, so the dispatcher enqueues another
`factory-change`. The builder reads the findings through `brief` and
commits on the same branch.

The attempt count is also part of the dispatcher's enqueue key. A run
enqueued under `factory-change:<task id>:attempt-2` is the run for that
key for as long as its record is kept, so the count only goes up.
`sendBack` adds one, and so does `factoryFailures` below for a failed or
cancelled run.

After three attempts, `sendBack` stops reopening. It retags the task
`needs-owner`, which takes it out of the dispatcher's query. A person reads
the findings and changes the task or the code. To resume, restore the tag
and reopen the task:

```sh
marbles tasks update <task id> --tag factory
marbles tasks reopen <task id>
```

Each reopen past the cap buys one more attempt. Do not reset `attempts` to
zero. The next enqueue would reuse the first attempt's key and get that old
run back, and the task would sit `active` with nothing building. For the
same reason, raise `attempts` yourself before reopening a task whose run
ended some other way, such as `interrupted` after the Marbles process
stopped mid-body.

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

`factoryFailures` observes runs and receives only `run.failed` and
`run.cancelled` facts. It reads the run with `runs.get(runId)`. Every
factory run carries the task id in its input, so the observer finds the
task without a lookup table, even when the run failed before writing
anything. It records the stage and error on the task, counts the failure
as an attempt, and retags it `needs-owner`. It does not reopen the task: a
failed build may have left commits on the branch, so a person looks before
the factory builds on them. A fact delivered twice is skipped the second
time, since the task already names that run in `failedRun`. Resume the
task the same way once the cause is fixed, and the next enqueue has a new
key.

`marbles tasks list --tag needs-owner --json` is the factory's inbox. The
[release patrol's digest](/marbles/use-cases/release-patrol#make-it-yours)
lists these tasks every weekday.

## What you have

The whole factory is five stages of ordinary marbles. Each stage runs on
its own with `marbles run`, every run is visible in the dashboard, and the
factory waits on a person for approval and to recover failed builds.
Start supervised, and read every diff the factory ships until you trust it.
