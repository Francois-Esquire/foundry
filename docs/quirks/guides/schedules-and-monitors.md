---
title: React to change and recur
description: Observe files and HTTP sources, then choose when work returns.
---

A schedule decides when work runs. A monitor checks a source and runs its
handler when something changed. Begin with deterministic detection:

```ts
import { monitor } from "@foundry/quirks";

monitor("**/{AGENTS,CLAUDE}.md")
  .every("30s")
  .do(({ files, log }) => log(files));
```

```sh
quirks list
quirks once <the monitor key list printed>
quirks
```

A monitor has no name of its own. `list` prints its key, derived from the
source, such as `agents-claude-md-1a2b3c`; `once <key>` polls it once. The
first poll has no baseline, so every matching file arrives as `added`; later
polls compare digests with the last observation and report `added`,
`modified`, and `removed`. A glob that matches nothing fires nothing. The
observation is recorded after the handler resolves, so a handler that throws
sees the same change next tick.

Add an agent session when judging what a change means; the
[caretaker pattern](/quirks/use-cases/repository-caretaker) does this.

## Network sources

Replace the illustrative URL with your source before running it:

```ts
monitor("https://example.com/releases.json")
  .every("1h")
  .do(async ({ response, log }) => log(await response.json()));
```

An HTTP monitor fires when the body changes: each poll hashes the body, as
stable JSON when it parses, as text otherwise, and compares it with the last
hash. A body that carries noise such as a timestamp fires every poll; read
`response` and return early when nothing you care about changed. Monitors
still perform their network I/O under `--dry`.

## A monitor that starts a workflow

A handler that returns a locked node starts it, attributed to the monitor:

```ts
monitor("https://tracker.example.com/issues/latest")
  .every("10m")
  .do(async ({ response }) => ship({}, { task: (await response.json()).title }));
```

The target is a named step or workflow, locked without children. Return
`undefined` to do nothing this tick. The launch is held until a tick has
started it, so a crash in between does not lose it.

## Choose a cadence

For the `inspect` step from [Start Here](/quirks/start-here), either form is
valid:

```ts
schedule(inspect).every("30m");
schedule(inspect).at({ weekday: "mon", hour: 9, minute: 30 });
```

Import `schedule` alongside `step`. An interval is an integer with `s`, `m`,
`h`, or `d`. Calendar times are machine-local; `weekday` is a day or an
array, omitted for every day. A schedule's key is its target's name, with a
short hash of the input when a locked node carries one; the two above share
a target and no input, so the second is keyed `inspect-2`.

Foreground intervals count from completion and do not queue missed ticks. A
tick takes a lock for its key, so an overlapping tick from another live
process skips instead of doubling up; `once <step-name>` takes no lock.
Globs are polled on the monitor's cadence, one minute by default; there is no
live file watching.

For macOS scheduling between processes, continue to [launchd](/quirks/guides/launchd).
