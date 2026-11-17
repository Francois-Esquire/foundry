---
title: Observe a task
description: Build a small task observation loop and inspect its result.
---

Build a small intake loop: when an open task gains the `intake` tag, record
that it was seen. The record stays on the task for a person to inspect. This
example does not launch an agent or do the task's work.

Complete [installation](/marbles/get-started/installation) first. This example
uses the current source checkout. Use a scratch project so that replaying its task history does
not affect an existing workspace. It needs no agent credentials.

## Write the observer

Create `.foundry/marbles` in the project and save this complete file as
`.foundry/marbles/task-loop.ts`:

<include>./_example/task-loop.ts</include>

`observe` registers a handler for committed task changes. A change contains
the task before and after the write. The handler looks for the transition into
the `intake` tag, then reads the current task: the task may have changed since
the event was recorded. It only marks tasks that are still open and tagged.

The update sets the `intakeRecorded` key and keeps the task's other metadata.
It uses `updatedAt` as an optimistic token. If another write wins first, this update fails instead of overwriting
it. The host retries the event on a later change or restart. The marker makes
repeated delivery harmless while it remains on the task. The observer's own
update emits another event, but that event does not add the `intake` tag, so
it does not trigger another update.

## Run it

From the scratch project, start the Marbles process and create a tagged task:

```sh
marbles run </dev/null
```

In another terminal in the same project:

```sh
marbles tasks create "Review the release notes" --tag intake
marbles tasks list --json
```

The observer runs asynchronously. Once it has processed the change, the task
has `"intakeRecorded": true` in its metadata. List again if the first read
arrives before the observer. If a task command says the workspace worker is
starting, retry once it is ready. Stop the process with `marbles stop` when done.
Tasks and their events live in workspace state; the source file stays in the
project. See the [state reference](/marbles/reference/state).

## Grow the loop

This is an intake marker, not a worker: it does not claim a task, check its
dependencies, or complete it. A worker can use `ready()` and an atomic
`requireReady` transition before starting work, then leave the result for a
person to review. For external effects, a metadata marker alone is not a
transaction with the external system; use an idempotency strategy for that
system too.

The [factory floor](/marbles/use-cases/software-factory) describes how
several such workflows can cooperate.

Observers receive changes at least once, in order. Editing an observer makes
it a new observer that can receive earlier history; stored events are not
currently compacted. See [task observation](/marbles/reference/api#exports) for
delivery and storage details.
