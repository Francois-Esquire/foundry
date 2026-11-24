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
  name. Inferred names need TypeScript 6 installed in the project.
- Fix import errors, duplicate names, and missing project dependencies
  reported during loading.
- Wait a second after changing a module: the Marbles process starts its
  next engine generation on its own. A change that throws while loading
  keeps the previous load running, and the workspace shows the error; fix
  it, and the next edit loads. A header showing `failed` means no load of
  the workspace runs: fix it, then open `marbles` (or `marbles run <name>`) again.

[Discovery rules](/marbles/reference/project#discovery-and-ignored-files)
also explain how imported helper modules register work.

## Input is rejected or the launch form is JSON

Pass valid JSON to `--input` with fields matching the input schema.
`marbles run <definition>` uses that input; a schedule key already carries its
configured input. The CLI's error lists fields and matching schedule keys.

The dashboard uses structured fields when a schema exposes Standard JSON
Schema. Other schemas remain valid for execution and use a JSON field.
Install the schema library in the project containing the importing module.

## A schedule does not run

`list` does not keep a clock running. `marbles`, `marbles </dev/null`,
`marbles run <name>`, and `marbles enqueue <name>` attach the workspace to the Marbles process, which keeps its
schedules running until `marbles daemon stop`; `marbles status` shows
`marbles process: pid …` and `hosted: yes` when it does. `--dry-run`
dispatches schedules only while the command runs. Check the cadence and host
timezone, and inspect schedule history with `status`. An interval schedule
waits for its previous run to settle, so a run still open or suspended holds
its next occurrence back. An occurrence another live process claimed runs
there, not here. Different keys are claimed separately.

## A monitor repeats or appears idle

The first poll reports the current source as a change. Later polls require
changed content. A failed handler leaves the prior observation in place,
so it can receive the same change again. HTTP bodies containing changing
timestamps may trigger every poll. See [monitor semantics](/marbles/concepts/monitoring-and-scheduling).

## An agent or sandbox cannot start

Run the configured `claude` or `codex` command directly in the same
environment to verify installation and authentication. Check the configured
providers (`ProviderConfiguration.list()` in `@foundry.sh/marbles/lib`) and
the agent's `provider` and `model`: a model no
configured catalog lists is refused, and a session stays on the provider it
started with. A `[providers]` line saying a provider "is unavailable:
this workspace does not define it" means the configuration names Pi, Vercel
AI Gateway, a gateway or a provider of your own that the workspace's source
does not pass to [`defineProvider`](/marbles/reference/api#providers); the
line names the import and the call to add.

For sandbox sessions, check the optional runtime installation, supported
host setup, image, mounts, network policy, and credentials. Host `cwd`
cannot be combined with sandbox session options. Native CLI sessions reject
host `compaction` settings. See [Agent sessions](/marbles/reference/agent-sessions).

## A question cancels the run

`marbles run` and piped `marbles` cannot answer workflow questions. Through the
Marbles process the run suspends with its question on the Feed, and `marbles run`
waits; open `marbles` to answer it. Under `--dry-run` the run is cancelled
at the ask. Work before the ask has already run; launching again can repeat
it.

## A failed step did not retry

Retries are provided by [Workflows](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md),
but there is no default retry policy. Add `.config({ retry: { maxAttempts: 3 } })`
to the step that should retry, after making its effects safe to repeat.
The limit includes the first attempt; `bail(error)` does not retry. A
parent's policy does not configure its children, and the next schedule
occurrence is a new run. See [retry policies](/marbles/concepts/durability#retry-a-failed-attempt).

## An agent turn repeated after answering a question

A resumed body replays from the top. `agents.session` reopens its recorded
conversation, but an explicit `session.generate` sends another turn if
reached again. Put completed agent work in a preceding child step and ask
in its own step, as in [Software Factory approval](/marbles/use-cases/software-factory/deliver).
The [replay table](/marbles/concepts/durability#replay-is-different-from-retry)
also explains one-shot agent calls and artifact writes.

## A run did not resume

Only suspended runs resume after a restart. Keep the workspace path, state
root, and registered definitions available; the question waits on the
Feed for a dashboard, and once it is answered the current engine
generation resumes the run.
Runs interrupted while actively executing appear orphaned. See
[recovery conditions](/marbles/reference/state#what-survives-a-restart).

## State reports a stale lock

Follow the path and owner information in the error. Confirm the owning
process is gone before removing a stale lock or its `.break` file. Deleting
state is not a general repair: it can discard run history, sessions, and
trigger continuity. The [state reference](/marbles/reference/state#scheduling-and-overlap)
documents the lock protocol.
