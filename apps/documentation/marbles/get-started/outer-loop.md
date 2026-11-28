---
title: The outer loop
description: Give a script a backlog and a dispatcher with tasks, observe, and .enqueue().
---

The [first ritual](/marbles/get-started/quickstart) runs when you type
`marbles run`. An outer loop runs it when work appears: a task lands in the
backlog, an observer notices, and the observer enqueues a run without
waiting for it. A second observer watches runs and flags the ones that fail.

This example needs no agent account. It uses `zod` and features from the
current source checkout (`.enqueue()` with a key, and `runs`); see
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
  refused claim means another pass, another writer, or the run itself got
  there first.
- **`dispatchChecks`** runs after every committed task change. It asks
  `tasks.ready()` for open, unblocked tasks tagged `checks`. For each one it
  calls `checkTask.enqueue(...)` with a key, then claims the task.
  `.enqueue()` resolves as soon as the run is admitted, with `{ id, result }`,
  so the observer returns without waiting for the tests.
- **`flagFailures`** observes runs and receives only `run.failed` and
  `run.cancelled` facts. It reads the run with `runs.get(runId)`, takes the
  task id from the run's input, counts the attempt, and retags the task
  `needs-owner` with the error.

The dispatcher queries `ready()` on every change instead of looking for one
task's tag being added. A task that depends on another becomes ready when
that other task completes, and that completion is the change that wakes the
observer.

## Run it

Attach the workspace to the Marbles process, then add two tasks, the second
depending on the first:

```sh
marbles daemon attach
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
Stop the process with `marbles daemon stop` when you are done.

## How delivery behaves

Observers receive each change at least once, in commit order, starting
from their first start. A handler that throws keeps its place and gets the
same fact again after a backoff, so write handlers that are safe to repeat.

The key makes the enqueue safe to repeat. `check-task:<task id>:attempt-0`
names one run of `check-task`. If the handler throws after enqueuing, the
redelivered change enqueues with the same key and gets that run back, so
the tests run once.

The dispatcher enqueues first and claims second, so a task is never left
`active` without a run. If the enqueue throws, nothing is claimed, and the
next delivery tries again. Once the claim lands, the task drops out of
`ready()` and later passes skip it.

A key matches its run whatever became of it. If the key never changed, a
reopened task would get its old failed run back and nothing would check
it. So `flagFailures` adds one to the task's `attempt` when a check fails
or is cancelled, and the next enqueue uses a new key. Once you have fixed
the cause, put the task back:

```sh
marbles tasks update <id> --tag checks
marbles tasks reopen <id>
```

The reopened task is ready, the dispatcher enqueues
`check-task:<task id>:attempt-1`, and the check runs again.

A run can also end without either fact, such as one marked `interrupted`
after the Marbles process stopped mid-body. Before you reopen its task,
set `attempt` one higher yourself, adding `--metadata '{"attempt":1}'` to
the update for a task still on its first attempt.

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
