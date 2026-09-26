---
title: State
description: Disk layout, recovery of parked runs, locks, and the limits of continuity.
---

## Persisted state

The default state root is `~/.foundry/quirks`. Each workspace, the directory
that holds the config, gets a directory named by the first twelve hex digits
of the SHA-256 of its canonical path. Listing the state root is the registry
of every workspace this machine has run.

```text
~/.foundry/quirks/<workspace-id>/
  workspace.json          id, root, config, firstSeen, lastSeen
  runs/<runId>.json       one run: its record, frames, jobs, queue row, suspensions,
                          the owning pid, and what the run recorded (below)
  schedules/<key>.json    kind, label, lastStart, lastFinish, lastStatus, nextDue
  monitors/<key>.json     the last observation: file digests, or the HTTP body and
                          its hash; plus a pending launch until it has started
  locks/<key>             pid of the tick running a schedule or monitor
  locks/run-<runId>       pid of the process that owns a recovered run
  heartbeat.json          pid and start time of the foreground `run` loop
  sessions/<id>.json      agent conversations
  worktrees/              temporary worktrees cut by `withWorktree`
```

Every file is written to a temporary name and renamed, so a concurrent reader
never sees a half-written file. Run files are `version: 2`; the other
Quirks-owned records are `version: 1`. Session files use the session store's
own format. Version 1 run files still load.

A run file carries, under `quirks`, three things the run scope recorded:

- **ledger**: what each step opened, by step path and call position. The
  session a step's first `agents.session` returned, the sandbox its first
  `sandboxes.start` returned, and so on. On replay the same call at the same
  position returns the recorded thing.
- **literals**: the input each node was locked with when the run started.
  A recovered run executes against these, whatever a rebuilt tree or an
  edited config would give.
- **session**: the run's own session id. Agent sessions opened in the run
  are children of it.

Declared artifacts and feed entries live outside the per-workspace
directories, in the artifact store shared by every workspace (default
`~/.foundry/artifacts`, set with `--artifacts`):

```text
~/.foundry/artifacts/
  records.json            artifacts and their content versions
  records.json.lock       pid holding the write lock during a commit
  blobs/                  file bytes, one immutable file per blob
```

Writers take the lock, reload `records.json`, and replace it atomically, so
concurrent Quirks processes do not lose each other's entries.

## What survives a restart

Run files are written when a run settles, when a step parks on a question or
a pause, and again when it is answered, so the file always says whether the
run is waiting or working.

When the engine starts it reads every run file. A settled run always loads,
as history. A suspended run is adopted when four things hold: this process
can answer questions (the dashboard can; `once` and a launchd tick cannot),
the step it ran is still registered in the config, the process that wrote the
file is gone, and `locks/run-<runId>` is free. Adoption rewrites the file with
the new pid and holds the lock until the run settles or the process stops, so
two dashboards never both resume one run. The run parks again, its question
stays open on the feed, and the answer replays the body against the recorded
sessions and artifacts.

A run that was queued or running when its process died is skipped with a
warning. Nothing picks a run up mid-body; the recorded result of a finished
step is kept, but the run itself is not resumed. `status` marks such a run
as orphaned.

An invalid run file is skipped with a warning and costs only that run. If the
files disagree with each other, the engine warns and starts empty.

## Scheduling and overlap

The foreground loop measures an interval schedule's next tick from the
previous tick's completion, seeded from the recorded `lastFinish` so a restart
keeps the cadence. Missed interval ticks do not queue. Calendar slots are
evaluated in machine-local time.

A tick takes `locks/<key>` before it runs. If another live process holds it,
`once <key>` prints a skipped message and exits successfully. A lock whose
pid is dead is stale and is replaced. `once <definition-name>` takes no lock.
Two schedules with different keys have different locks even when they target
the same workflow.

Monitors are polled on their cadence. A poll compares what it sees with the
last recorded observation; the handler runs only when something changed, and
the observation is recorded only after the handler resolves, so a throwing
handler sees the same change again next tick. A launch the handler asked for
is recorded as `pending` and handed out on every tick until a start succeeds.
A target that is no longer registered fails one tick and is dropped; a started
run that later fails or is cancelled is not started again.

## Dry runs

Under `--dry` nothing under the state root or the artifact store is written.
Sessions and the feed live in memory, monitor observations live in the
process, worktrees are cut under the system temporary directory, and parked
runs are cancelled when the process quits. Step bodies still execute; see
[safety and limits](/quirks/safety-and-limits).
