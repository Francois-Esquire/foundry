---
title: Troubleshooting
description: Diagnose installation, discovery, input, scheduling, agent, and state problems.
---

Start with `marbles --help`, then `marbles list` from the project root.
`list` imports your modules, so keep module scope to declarations. Use
`marbles status` and `marbles sessions` to inspect saved state without
importing them.

## The command is missing

Check `bun --version` and the global binary directory from
`bun pm bin --global`. Put that directory on `PATH`, then reopen the terminal
if needed. See [Installation](/marbles/get-started/installation).

## My automation is not listed

- Run from the project root containing `.foundry/marbles/`, or select the
  correct source with `--source`.
- Check that the module is JavaScript or TypeScript and is not under a
  leading-underscore path, a hidden directory, or a symlink.
- Use `step("name")` or `workflow("name", ...)` for an explicit launchable
  name. Inferred names need TypeScript available in the project.
- Fix import errors, duplicate names, and missing project dependencies
  reported during loading.
- Wait a second after changing a module: the workspace's worker reloads on
  its own. A dashboard header showing `failed` means the module threw while
  loading; fix it, then open `marbles` (or run `roll`) again, which starts
  a fresh worker.

[Discovery rules](/marbles/reference/project#discovery-and-ignored-files)
also explain how imported helper modules register work.

## Input is rejected or the launch form is JSON

Pass valid JSON to `--input` with fields matching the input schema.
`roll <definition>` uses that input; a schedule key already carries its
configured input. The CLI's error lists fields and matching schedule keys.

The dashboard uses structured fields when a schema exposes Standard JSON
Schema. Other schemas remain valid for execution and use a JSON field.
Install the schema library in the project containing the importing module.

## A schedule does not fire

`list` does not keep a clock running. `marbles`, `marbles run </dev/null`,
and `roll` attach the workspace to the Marbles process, which keeps its
schedules ticking until `marbles stop`; `marbles status` shows
`marbles process: pid …` and `hosted: yes` when it does. `--dry-run` ticks
only while the command runs. Check the cadence and host timezone, and inspect schedule history with
`status`. A live process holding the same schedule key makes another tick
skip. Different keys do not share that lock.

## A monitor repeats or appears idle

The first poll reports the current source as a change. Later polls require
changed content. A failed handler leaves the prior observation in place,
so it can receive the same change again. HTTP bodies containing changing
timestamps may trigger every poll. See [monitor semantics](/marbles/foundation/triggers).

## An agent or sandbox cannot start

Run the selected `claude` or `codex` command directly in the same environment
to verify installation and authentication. Check `--harness` and the
agent's `provider`; model names do not select a provider.

For sandbox sessions, check the optional runtime installation, supported
host setup, image, mounts, network policy, and credentials. Host `cwd`
cannot be combined with sandbox session options. Native CLI sessions reject
host `compaction` settings. See [Agent sessions](/marbles/reference/agent-sessions).

## A question cancels the run

`roll` and headless `run` cannot answer workflow questions. Through the
Marbles process the run parks with its question on the Feed, and `roll`
waits; open `marbles` to answer it. Under `--dry-run` the run is cancelled
at the ask. Work before the ask has already run; launching again can repeat
it.

## A failed step did not retry

Retries are provided by [Workflows](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md),
but there is no default retry policy. Add `.config({ retry: { maxAttempts: 3 } })`
to the step that should retry, after making its effects safe to repeat.
The limit includes the first attempt; `bail(error)` does not retry. A
parent's policy does not configure its children, and the next schedule
tick is a new run. See [retry policies](/marbles/foundation/durability#retry-a-failed-attempt).

## An agent turn repeated after answering a question

A resumed body replays from the top. `agents.session` reopens its recorded
conversation, but an explicit `session.generate` sends another turn if
reached again. Put completed agent work in a preceding child step and ask
in its own step, as in [Software Factory approval](/marbles/use-cases/software-factory/development/approve).
The [replay table](/marbles/foundation/durability#replay-is-different-from-retry)
also explains one-shot agent calls and artifact writes.

## A run did not resume

Only parked runs are adopted after restart. Keep the workspace path, state
root, and registered definitions available; the workspace's worker adopts
when it starts, and the question waits on the Feed for a dashboard.
Runs interrupted while actively executing appear orphaned. See
[recovery conditions](/marbles/reference/state#what-survives-a-restart).

## State reports a stale lock

Follow the path and owner information in the error. Confirm the owning
process is gone before removing a stale lock or its `.break` file. Deleting
state is not a general repair: it can discard run history, sessions, and
trigger continuity. The [state reference](/marbles/reference/state#scheduling-and-overlap)
documents the lock protocol.
