---
title: The outer loop
description: Give a script a backlog and a dispatcher with tasks, observe, and .launch().
---

The [first ritual](/marbles/get-started/quickstart) runs when you type
`roll`. An outer loop runs it when work appears: a task lands in the
backlog, an observer notices, and the observer launches a run without
waiting for it. A second observer watches runs and flags the ones that fail.

This example needs no agent account. It uses `zod` and features from the
current source checkout (`.launch()` and `runs`); see
[installation](/marbles/get-started/installation#install-the-package). Use a
scratch project so its tasks do not mix with another workspace's.

## Write the loop

Save this complete module as `.foundry/marbles/outer-loop.ts`:

<include>./_example/outer-loop.ts</include>

The module has four parts:

- **`check-task`** is an ordinary step. It runs the tests, writes the exit
  code onto the task's metadata, and completes the task. Its input is the
  task id, so every run says which task it belongs to.
- **`claim`** moves a task from `open` to `active` in one atomic change.
  `requireReady: true` refuses a task whose dependencies are not settled,
  and `expectedUpdatedAt` refuses a task that changed since it was read. A
  refused claim means another pass or another writer got there first.
- **`dispatchChecks`** runs after every committed task change. It asks
  `tasks.ready()` for open, unblocked tasks tagged `checks`, claims each
  one, and calls `checkTask.launch(...)`. `.launch()` resolves as soon as
  the run is admitted, with `{ id, result }`, so the observer returns
  without waiting for the tests.
- **`flagFailures`** observes runs and receives only `run.failed` facts. It
  reads the run with `runs.get(runId)`, takes the task id from the run's
  input, and retags the task `needs-owner` with the error.

The dispatcher queries `ready()` on every change instead of looking for one
task's tag being added. A task that depends on another becomes ready when
that other task completes, and that completion is the change that wakes the
observer.

## Run it

Attach the workspace to the Marbles process, then add two tasks, the second
depending on the first:

```sh
marbles attach
marbles tasks create "Check the release branch" --tag checks --json
marbles tasks create "Check after the first" --tag checks --depends-on <id from the first>
```

A few seconds later, list them:

```sh
marbles tasks list --json
```

Both tasks end `completed` with `"exitCode"` in their metadata, and the
second ran only after the first finished. `marbles runs` shows two
`check-task` runs, and `marbles status` shows both observers `caught up`.
Stop the process with `marbles stop` when you are done.

## How delivery behaves

Observers receive each change at least once, in commit order, starting
from their first start. A handler that throws keeps its place and gets the
same fact again after a backoff, so write handlers that are safe to repeat.
Here the claim makes a repeat harmless: a task that is already `active` is
no longer ready. If a launch fails after its claim, the task stays `active`
without a run; reopen it with `marbles tasks reopen <id>`.

The observer's own writes are changes too. They arrive on the next pass,
where the claimed tasks are no longer ready, so the loop settles.

An observer is known by its name, here the function name. Editing the
handler keeps its place. Renaming it starts a new observer from that
moment. [Tasks and observability](/marbles/concepts/tasks-and-observability)
covers the delivery rules and the event sources.

## Feed the loop

Anything that creates a task feeds the loop: you at the command line, an
MCP client with the task tools, a schedule, or a monitor. Add this to the
module to queue a check every night and whenever source files change:

```ts
const nightly = step("nightly-checks").do(async () => {
  const task = await tasks.create({ tags: ["checks"], title: "Nightly checks" });
  return { task: task.id };
});
schedule(nightly).at({ hour: 2 });

monitor("src/**/*.ts")
  .name("source")
  .do(async () => {
    await tasks.create({ tags: ["checks"], title: "Source changed" });
  });
```

Import `schedule` and `monitor` alongside the others. The monitor polls
every minute and reports existing files as added on its first poll, so it
queues one task when it starts. [Monitoring and
scheduling](/marbles/concepts/monitoring-and-scheduling) covers cadence,
keys, and HTTP sources.

Next, [the Marbles UI](/marbles/get-started/marbles-ui) shows where runs,
questions, tasks, triggers, and observers appear while the loop runs.
