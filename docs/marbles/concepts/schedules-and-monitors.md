---
title: Schedules and monitors
description: Observe files and HTTP sources, then choose when work returns.
---

A schedule decides when work runs. A monitor checks a source and runs its
handler when something changed. Both are declared in a module; neither starts
a clock until the dashboard runs them, `roll` dispatches them once, or
[launchd](/marbles/reference/launchd) starts a process for them.

## Schedules

`schedule` takes a named step or workflow. For the `inspect` step from
[Start Here](/marbles/start-here), either form is valid:

```ts
schedule(inspect).every("30m");
schedule(inspect).at({ weekday: "mon", hour: 9, minute: 30 });
```

An interval is a positive integer with `s`, `m`, `h`, or `d`. Calendar times
are machine-local; `weekday` is a day or an array, omitted for every day. To
schedule a step with input, lock it with that input:

```ts
schedule(review({}, { target: "packages" })).every("6h");
```

Foreground intervals count from completion and do not queue missed ticks. An
overlapping tick of the same schedule from another live process skips
instead of doubling up.

## Monitors

Begin with deterministic detection:

```ts
import { monitor } from "@foundry/marbles";

monitor("**/{AGENTS,CLAUDE}.md")
  .every("30s")
  .do(({ files, log }) => log(files));
```

```sh
marbles list
marbles roll <the monitor key list printed>
```

A monitor has no name of its own. `list` prints its key, derived from the
source; `roll <key>` polls it once. The first poll has no baseline, so every
matching file arrives as `added`; later polls compare digests with the last
observation and report `added`, `modified`, and `removed`. The observation is
recorded after the handler resolves, so a handler that throws sees the same
change next tick. Globs are polled, one minute by default; there is no live
file watching.

A source starting with `http://` or `https://` is fetched instead, and the
handler runs when the body changes:

```ts
monitor("https://example.com/releases.json")
  .every("1h")
  .do(async ({ response, log }) => log(await response.json()));
```

A body that carries noise such as a timestamp changes every poll; read
`response` and return early when nothing you care about changed. The
[release watcher](/marbles/recipes/release-watcher) compares one field this
way.

A source that needs a token, a method, or a body takes `.request`. Give it
a function to read the token at each poll rather than when the module
loads:

```ts
monitor("https://api.github.com/repos/acme/app/releases/latest")
  .request(() => ({ headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } }))
  .every("1h")
  .do(async ({ response }) => …);
```

What `.request` sends is never part of the monitor's key, its stored state,
`list`, or the feed. A move to an error status such as `404` or `500` is a
change like any other, with `change.status` set; a `401` or `403` fails the
poll and logs the status and the URL.

## A monitor that starts a workflow

A handler that returns a locked node starts it, attributed to the monitor.
The [Software Factory](/marbles/guides/software-factory) starts `ship` for
each new issue:

```ts
monitor("https://tracker.example.com/issues/latest")
  .every("10m")
  .do(async ({ response }) => ship({}, { task: (await response.json()).title }));
```

The target is a named step or workflow, locked without children. Return
`undefined` to do nothing this tick. The launch is held until a tick has
started it, so a crash in between does not lose it.

Add an agent session when judging what a change means; the
[repository caretaker](/marbles/recipes/repository-caretaker) does this.

See the [API reference](/marbles/reference/api#triggers) for keys and every
trigger form, and [state](/marbles/reference/state#scheduling-and-overlap)
for locks and missed ticks.
