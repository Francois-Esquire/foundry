---
title: State
description: Disk layout, recovery of parked runs, locks, and the limits of continuity.
---

## Persisted state

The default state root is `~/.foundry/marbles`. Each workspace, the project root above `.foundry/marbles`, gets a directory named by the first twelve hex digits
of the SHA-256 of its canonical path. Listing the state root is the registry
of every workspace this machine has run.

```text
~/.foundry/marbles/<workspace-id>/
  workspace.json          id, root, config, firstSeen, lastSeen
  runs/<runId>.json       one run: its record, frames, jobs, queue row, suspensions,
                          the owning pid, and what the run recorded (below)
  schedules/<key>.json    kind, label, lastStart, lastFinish, lastStatus, nextDue
  monitors/<key>.json     the last observation: file digests, or the HTTP body and
                          its hash; plus a pending launch until it has started
  automations/<id>.json   a trigger an agent created: target, cadence, source, owner
  locks/<key>             pid of the tick running a schedule or monitor
  locks/run-<runId>       pid of the process that owns a recovered run
  locks/edit-<id>         pid of the process changing an agent-created trigger
  locks/<name>.break      transient: the process taking over a dead holder's lock
  heartbeat.json          pid and start time of the foreground `run` loop
  sessions/<id>.json      agent conversations
  sessions/<id>.json.lock pid of the process writing that session
  agent-grants.json       tool grants approved for future runs, by agent id
  agent-grants.json.lock  pid of the process changing grants; never taken over,
                          so remove it by hand if its process is gone
  agent-approvals.json    refused requests waiting in the feed as future permissions
  harness-activities/     native subagent and background activity, for the dashboard
  worktrees/              temporary worktrees cut by `withWorktree`
```

Grants and agent-created triggers are kept under the agent's id: its `name`,
else the top-level `const` it is assigned to, else a digest of its prompt,
provider, and model. Renaming an agent gives it a new id, and so does
editing the prompt, provider, or model of one with neither a `name` nor a
`const`. Its earlier grants are then asked for again, and the triggers it
created keep firing but leave its `list_automations`. A trigger also belongs
to the session that created it: `list_automations` shows only the calling
session's own.

Every record is written to a temporary name and renamed, so a concurrent
reader never sees a half-written file. Lock files are created in place
(below). Run files are `version: 2`; the other
Marbles-owned records are `version: 1`. Session files use the session store's
own format. Version 1 run files still load. The persisted `config` field keeps
its existing spelling and records the authoring folder or single-module path.
`workspace.json` is written only by a command that runs something here (`run`,
`roll`, the dashboard after Enter); `list`, `status`, `sessions`, and
`launchd` leave an empty state root empty.

Session files are read again for every operation, and each change is a
read-change-write under `<id>.json.lock`, so two processes appending to one
session keep both messages. A session file that cannot be read is skipped
with a warning and never overwritten; changing that session fails until the
file is repaired or removed. Creating a session under an id that already
exists returns the existing one.

A run file carries, under `marbles`, three things the run scope recorded:

- **ledger**: what each step opened, by step path and call position. The
  session a step's first `agents.session` returned, the sandbox its first
  `sandboxes.start` returned, and so on. On replay the same call at the same
  position returns the recorded thing.
- **literals**: the input each node was locked with when the run started.
  A recovered run executes against these, whatever a rebuilt tree or an
  edited module would give.
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
concurrent Marbles processes do not lose each other's entries.

## What survives a restart

Run files are written when a run settles, when a step parks on a question or
a pause, and again when it is answered, so the file always says whether the
run is waiting or working.

When the engine starts it reads every run file. A settled run always loads,
as history. A suspended run is adopted when four things hold: this process
can answer questions (the dashboard can; `roll` and a launchd tick cannot),
the step it ran is still registered in the module, the process that wrote the
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

A tick takes `locks/<key>` before it runs. If another process holds it,
`roll <key>` prints `skipped: held by <holder>` and exits successfully.
`roll <definition-name>` takes no lock. Two schedules with different keys
have different locks even when they target the same workflow.

Every lock under `locks/`, and each session's `<id>.json.lock`, is a file
created exclusively with mode `0o600` that holds the owner's pid:

- A lock whose pid has exited is broken by one process at a time. That
  process creates `<lock>.break`, reads the lock again, removes it if it
  still names the same dead pid, removes `.break`, and then tries to create
  the lock; another process may create it first. A `.break` left by a
  crashed process stops anyone breaking that lock until it is removed.
- A lock file that is still empty (its creator has not written its pid yet)
  is left alone for 30 seconds; after that it counts as abandoned and is
  broken the same way.
- A lock file that holds anything else is never removed.
- A process releases a lock only while it still names that process, so a
  late release never removes a lock someone else has taken.

A tick or edit that finds `locks/<name>` held does not wait. It reports the
holder: `pid N`; `a process that is taking it now; retry` for a fresh empty
lock; `pid N, which has exited (if no process is taking the lock over,
remove <path>.break)` when a `.break` is in the way; or `an unknown process
(if none is running, remove <path>)` for a file that is neither. A session
write waits up to 10 seconds for `<id>.json.lock`, then fails with
`[json-session-store] session <id> is locked by process N. If no Marbles
process is using it, remove <path> (and <path>.break, if present) and
retry.`

Monitors are polled on their cadence. A poll compares what it sees with the
last recorded observation; the handler runs only when something changed, and
the observation is recorded only after the handler resolves, so a throwing
handler sees the same change again next tick. A launch the handler asked for
is recorded as `pending` and handed out on every tick until a start succeeds.
A target that is no longer registered fails one tick and is dropped; a started
run that later fails or is cancelled is not started again.

## Dry runs

Under `--dry-run` nothing under the state root or the artifact store is written.
Sessions and the feed live in memory, monitor observations live in the
process, worktrees are cut under the system temporary directory, and parked
runs are cancelled when the process quits. Step bodies still execute; see
[safety and limits](/marbles/safety-and-limits).
