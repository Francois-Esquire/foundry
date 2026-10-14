---
title: Schedules and monitors
description: Run work on a clock or react when a file or HTTP source changes.
---

A schedule starts work on a clock. A monitor polls files or an HTTP source
and starts work when it detects a change. Both need a running Marbles loop.
`roll` runs one target or poll immediately and exits.

The CLI owns the polling and clock loops. A launched step or workflow runs
through [Workflows](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md),
with its own results and configured retry policies. Trigger continuity and
run [durability](/marbles/foundation/durability) are related: a later poll
or schedule tick creates a new run, while a retry is another attempt within
the current run.

## Schedules

This complete module logs a heartbeat every 30 seconds:

```ts
import { schedule, step } from "@foundry.sh/marbles";

const heartbeat = step("heartbeat").do(({ log }) => {
  log("Marbles is running");
  return { alive: true };
});

schedule(heartbeat).every("30s");
```

Open `marbles` and press Enter to start the clock. Replace `.every("30s")`
with `.at({ weekday: "mon", hour: 9, minute: 30 })` for a Monday slot.
Calendar times use the machine's local timezone. Intervals are positive
integers followed by `s`, `m`, `h`, or `d`.

A schedule takes a named definition, or a childless locked definition
carrying input. For example, `schedule(count({}, { extension: ".ts" }))`
can target the `count` step from [Using Marbles](/marbles/get-started/using-marbles#give-work-input).
Finish the declaration with `.every(...)` or `.at(...)`.

Configured interval schedules count from completion, preserve their last
completion across restarts, and do not queue missed ticks. An overlapping
tick of the same schedule key on the same machine is skipped. A direct
launch by definition name is not protected by that schedule lock.

## File monitors

Save this module to observe repository instructions:

```ts
import { monitor } from "@foundry.sh/marbles";

monitor("**/{AGENTS,CLAUDE}.md")
  .every("30s")
  .do(({ change, log }) => {
    if (change.kind === "files") log(change);
  });
```

Run `marbles list`, copy the monitor key, and run `marbles roll <key>`.
The first poll reports existing matches as added. Edit a matching file and
poll again to see a modification. The handler receives added, modified,
and removed paths with their checksums, relative to the workspace root.

File monitors poll; they do not subscribe to filesystem events. Their
default cadence is one minute. The stored observation advances only after
the handler resolves. A throwing handler sees the same change next time.

The scan uses [Workspaces](https://github.com/Francois-Esquire/foundry/blob/main/packages/workspaces/README.md)
for the project's file inventory. Digests identify changes; preserving
the observation does not keep a copy of every file's previous bytes.

## HTTP monitors

A source beginning with `http://` or `https://` uses HTTP polling. This
complete module observes Bun's public release metadata:

```ts
import { monitor } from "@foundry.sh/marbles";

monitor("https://api.github.com/repos/oven-sh/bun/releases/latest")
  .every("6h")
  .do(({ change, log }) => {
    if (change.kind === "http") log(change.status, change.current);
  });
```

The first response counts as a change. Later polls compare the body with
the last handled observation. Fields such as timestamps can change even
when nothing relevant changed; filter them in the handler, as the
[release monitor](/marbles/use-cases/software-factory/maintenance/signals#watch-upstream-releases) does.

`.request(init)` supplies request options or a function evaluated on every
poll. A function can read the current token from the environment. Request
options are not included in the monitor key or stored observation. Network
errors and `401`/`403` fail the poll; other error statuses are observations
the handler can inspect. Dry execution still performs monitor I/O.

## Launch work from a change

This complete module launches a named step when Markdown files change:

```ts
import { monitor, step } from "@foundry.sh/marbles";

const inventory = step("markdown-inventory").do(async ({ workspaces }) => ({
  files: (await workspaces.current.files()).filter((file) =>
    file.path.endsWith(".md")
  ).length,
}));

monitor("**/*.md")
  .every("1m")
  .do(() => inventory({}));
```

The same form works with a workflow. Return a childless lock of a named
target, or return `undefined` to launch nothing. Returning the bare
definition does not launch it.

A pending launch is kept until a start succeeds. A crash between starting
and acknowledging it can cause redelivery, so make external effects
idempotent. A launched run that later fails is not automatically launched
again for the same observation.

## Agent-created triggers

Sandbox agents can also create durable schedules and monitors through
approved tools. They retain ownership by agent and session and appear in
the dashboard. Their creation-time cadence differs from the completion-based
intervals above. See [managed automation](/marbles/reference/agent-sessions#child-agents-and-automation).

The [trigger reference](/marbles/reference/api#triggers) covers exact forms
and keys; [state](/marbles/reference/state#scheduling-and-overlap) covers
locks and persisted observations.

Next: [Local execution and state](/marbles/foundation/execution-and-state)
connects these launches to the CLI process and its persistent stores.
