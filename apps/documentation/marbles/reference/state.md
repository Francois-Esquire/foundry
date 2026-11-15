---
title: State
description: Disk layout, recovery of parked runs, locks, and the limits of continuity.
---

## Persisted state

For the guarantees these records support, start with
[Durability](/marbles/foundation/durability). Run snapshots use
[Workflows](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md),
session transcripts use [Agents](https://github.com/Francois-Esquire/foundry/blob/main/packages/agents/README.md),
and reports and versioned outputs use [Artifacts](https://github.com/Francois-Esquire/foundry/blob/main/packages/artifacts/README.md).
Marbles chooses their local stores and connects their identities.

The default state root is `~/.foundry/marbles`; `FOUNDRY_HOME` moves the
whole home, and nothing moves on its own. The root holds the files of
the Marbles process, the one daemon for this machine, and one directory per
workspace: the project root above `.foundry/marbles`, named by the first
twelve hex digits of the SHA-256 of its canonical path. The Marbles
database, `marbles.db` at the state root, is the registry of every
workspace this machine has run, and says which of them the process hosts.

```text
~/.foundry/marbles/
  locks/process           pid of the Marbles process; removing it stops the
                          process within seconds
  process.json            what it is: pid, host "daemon", socket, artifacts dir,
                          the Marbles version it runs (`marbles`), start time
  marbles.sock            the Unix socket it answers on, owner-only (mode 0600)
  marbles.db              the Marbles database (SQLite, WAL mode, with its
                          -wal and -shm files): every workspace's id, root,
                          config, firstSeen, lastSeen, and whether it is hosted;
                          every workspace's tasks, by workspace id, with each
                          change they committed and which observers completed it;
                          and, by workspace id, its workflow Runs, Execution Runs
                          and their observations, retention gaps, each schedule's
                          and monitor's last tick, each monitor's state, the
                          triggers agents created, each agent turn's usage, its
                          artifact and sandbox records, its agent grants, the
                          approvals waiting in the feed, its harness activities,
                          and which engine delivers its task changes; and the
                          machine's and each workspace's provider configuration,
                          with the key instance identities are digested with.
                          Readable by its owner only (mode 0600), as provider
                          settings can hold secrets
  daemon.log              stdout and stderr of a process a client started;
                          `marbles daemon` prints to its own terminal instead
  settings.json           global dashboard preferences (the theme), shared by
                          every workspace; the one file meant to be edited by hand
  <workspace-id>/         one directory per workspace, below
```

```text
~/.foundry/marbles/<workspace-id>/
  output/<runId>.jsonl    append-only output for marbles watch
  locks/process           pid of the worker the Marbles process hosts this
                          workspace in, or of a program hosting it itself
  locks/process.break     transient: the process taking over a dead holder's lock
  process.json            what that process is: pid, host "worker", source, start time
  worktrees/              temporary worktrees cut by `withWorktree`
```

Files an earlier Marbles kept here and the database now holds
(`providers.json` and `identity.key` at the root; `agent-grants.json`,
`agent-approvals.json`, `harness-activities/`, `locks/tasks` and
`locks/providers` in a workspace's directory) are ignored, not imported,
and left as they are.

### Agent identity

Grants and agent-created triggers are kept under the agent's id: its `name`,
else the top-level `const` it is assigned to, else a digest of its prompt
(of its source, for an agent defined by a function). Renaming an agent
gives it a new id, and so does editing the prompt of one with neither a
`name` nor a `const`. Its earlier grants are then asked for again, and the triggers it
created keep firing but leave its `list_automations`. A trigger also belongs
to the session that created it: `list_automations` shows only the calling
session's own.

### Record writes

Records in the Marbles database are written in transactions, so a
concurrent reader never sees half of one. What a record holds as JSON is
kept as JSON gives it back: `-0` reads back as `0`, a property holding
`undefined` is left out, and a value JSON would not give back as it is
(NaN, an infinity, `undefined` in an array, a function) is refused.
Output journals are append-only. Lock files are created in place
(below). Run files and JSON records an earlier Marbles wrote are not
read. The persisted `config` field keeps
its existing spelling and records the authoring folder or single-module path.
A workspace is recorded in the database when it is attached to the Marbles
process (`run`, `roll`, the dashboard, or the MCP server), which sets
`hosted: true`, and by a program that hosts it itself; `list`, `status`,
`sessions`, `watch`, a task read, and anything under `--dry-run` leave an
empty state root empty. Only a process holding `locks/process` at the state
root creates the database and applies the migrations its Marbles ships:
the Marbles process, which holds it while it runs, or another writer of a
workspace's state, which takes it only while it makes the database
current: a program hosting a workspace itself, as it starts, and a task
change from the CLI or the MCP server with no Marbles process running. A
Marbles process can still start beside either once that moment has passed.
When another process holds the lock, such a writer waits up to five
seconds for the database to be current and otherwise fails. The workers,
and the CLI and the MCP server while a Marbles process runs, write only to
a database that is there and current. `status`, every task read, and every
other reader open it read-only: they never create, migrate, or change it,
and never switch its journal mode. A reader that meets the last writer
closing at the moment it opens can leave an empty `marbles.db-wal`; it
holds nothing, and readers and the Marbles process pass over it. A database whose
migrations are behind or ahead of the reading Marbles, or differ from the
ones it ships, is refused with an error that says which. The daemon, its
workers, and the CLI hold it at once: a writer waits up to five seconds for
another process's write to finish. A handle that waited past that, and
so failed with SQLite's busy error, opens a fresh connection before it
runs anything else, because the driver (`@libsql/client` 0.18) leaves the
failed one unable to commit; the failed operation is not retried, and a
refused commit is rolled back. `hosted` goes back to `false` when
`marbles detach` or a client of the process detaches the workspace.

### Tasks

A workspace's tasks live in the Marbles database, scoped by the workspace
id, with each change they commit, written in the same transaction, and the
record of which observers completed it. Detaching a workspace keeps them.
A `tasks.json` left in a workspace's directory by an earlier Marbles is
ignored, not imported, and left as it is, like the other JSON state the
database replaced.

Any number of processes read and write a workspace's tasks at once: the
worker hosting it, a program hosting it itself, and the CLI and the MCP
server. A change takes the database's write lock for its whole
read-check-write, so two processes changing one workspace never lose
either's update; one whose token went stale meanwhile is refused with
`conflict`. A task command with no worker hosting the workspace opens the
database itself for that one command. A read (`tasks list`, `ready`,
`get`, `deps`, and the MCP tools that read) opens it read-only, and without
a database finds no tasks and creates nothing. A change is a writer, and
with no Marbles process running makes and migrates the database under
`locks/process`, as a program hosting a workspace does. Under `--dry-run`
the tasks are in memory and nothing is written.

Every change fact a workspace's stores commit (its tasks, workflow Runs,
artifacts, sandbox containers, agent sessions and workspace catalogue) is
written to its change log, `marbles_changes`, in the same transaction as the
change, at the next position of the workspace's counter in
`marbles_change_logs`, with the run that made it, if one did. Positions
follow commit order and are never given twice. Each observer's place is a
row of `marbles_observers`, by workspace, source and name.

One engine delivers a workspace's changes to its observers at a time: the
one whose claim the workspace's row of `marbles_delivery_claims` holds,
from its start until it stops. A claim is a transaction that reads the row
and takes it; a claim whose process has exited holds nothing. A second
host of the same workspace files its observers, reads and writes the
workspace, but prints `[observe] not delivering here`, and takes delivery
over within a second of the first letting go, each observer from the place
the first left it. An observer's place moves only from where it was read,
so two deliverers never move one back.

Delivery is at least once per observer: a handler that completed but
whose place was not saved runs again. A handler that throws, or runs past
its time limit, keeps its place and is tried again after a backoff; other
handlers go on, each observer on its own. A call past its limit keeps its
observer waiting until it settles, which `marbles_observers.stuck_since`
records. A host that stops waits ten seconds at most for the calls in
flight; their observers keep their places. The
delivering host is woken at once by a change made in its process and
notices one made in another within a second. When it stops, or its
process exits, a host that was refused delivery takes it over within a
second and delivers what was written meanwhile.

Facts every observer seen in the last week has completed, and committed
more than a week ago, are removed every ten minutes by the delivering
host. An engine without the host's database records only what it keeps
there: one that opens its own for a state dir records its tasks, Runs and
sessions, not its artifacts, containers or catalogue, which it keeps in
memory; under `--dry-run` only its tasks, in memory. It says at start which
observers it hands nothing.

Known limits: a workspace's rows stay in the database after its directory
or checkout is deleted, and after it is detached. A host that keeps the
database open while another Marbles migrates it further refuses every
write from then on with an error saying so; restart it with the newer
Marbles. Until then, if it is the one delivering, it keeps the delivery
claim: each new fact runs its observers again, and their places cannot be
recorded.

Text the database cannot give back intact is refused before anything is
written: a title, description, id, or time holding U+0000, or a lone
surrogate (not well-formed UTF-16). The error names the field. Metadata and
tags are JSON and keep such characters.

### Sessions

A workspace's agent sessions live in the Marbles database, scoped by the
workspace id: the `@foundry/agents` session tables, and Marbles' own
`marbles_session_revisions`, one row per session record with a revision
that every change to the session raises, written in the same transaction.
A message moved to another session raises both. A session's row starts
when its record is put, even if messages were written under its id first. Usage
recovery, `marbles sessions` and `status` list a workspace's sessions
through it. Detaching a workspace keeps them. A `sessions/` directory left
in a workspace's directory by an earlier Marbles is ignored, not imported,
and left as it is, like `tasks.json`. Its sessions behave as if their files
had been removed: they are not listed; a session a parked run or a host
recorded before starts afresh under its id, without its history; a
deferred approval kept for one is dropped when the engine starts; and usage recovery counts one that a run or a
usage record still names as an unreadable usage record.

Any number of processes write a workspace's sessions at once. A change is
one transaction that takes the database's write lock for its whole
read-check-write, so two processes appending to one session keep both
messages, and a change that fails writes nothing, however many sessions it
touches. Creating a session under an id that already exists returns the
existing one. `marbles sessions` and `status` read the database read-only,
and without one find no sessions and create nothing. Under `--dry-run`
sessions are in memory and nothing is written.

Text the database cannot give back intact is refused before anything is
written: an id, role, status or title holding U+0000, or a lone surrogate.
The error names the field. A message's parts and metadata are JSON and
keep such characters.

Known limits: nothing prunes sessions or their revisions, so a workspace's
sessions stay in the database after its directory or checkout is deleted,
and after it is detached. Messages written under an id with no session
record are not listed, so usage recovery does not see them. Each turn
reads its session's whole history, and a commit that puts messages reads
where each is filed first, about 150 ms for a thousand.

### Run output

`output/<runId>.jsonl` is the stream read by
[`marbles watch <runId>`](/marbles/reference/cli#watch-a-background-run).
A persisted engine creates a journal for each run, including agent and
workflow runs launched through [MCP](/marbles/reference/mcp). The MCP
`runId` is the engine's run ID, not an agent-session ID.

The journal starts with the run ID, name, and owner PID. Text records carry
agent text, workflow `stream.write` and `exec` output, and step lifecycle
messages. The final record contains the terminal status and rendered result
or error, after execution, publication, cleanup, and the run persistence attempt
finish.
Raw `console.log` and process stdout are not part of this journal.

The writer appends newline-delimited JSON. A watcher reads complete records,
keeps an incomplete final line until more bytes arrive, and follows new
output without modifying state. Completed output remains readable after the
owner exits. If the owner disappears before recording an ending, the watcher
reports that interruption; it does not restart or adopt the run.

These journals are output history, not replay checkpoints or a persistent
job queue. A host pruning a settled Execution Run removes its workflow run
file and output journal together. The CLI has no automatic retention policy.
`--dry-run` and other in-memory engines write no journal. Runs saved before this feature have no
output history to reconstruct. A failed journal write warns the owner;
execution can still finish even when its output cannot be saved.

### Run records

What Marbles keeps beside each Run (`marbles_workflow_runs`) contains:

- **ledger**: what each step opened, by step path and call position. The
  session a step's first `agents.session` returned, the sandbox its first
  `sandboxes.start` returned, and so on. On replay the same call at the same
  position returns the recorded thing.
- **literals**: the input each node was locked with when the run started.
  A recovered run executes against these, whatever a rebuilt tree or an
  edited module would give.
- **session**: the run's own session id. Agent sessions opened in the run
  are children of it.

### Artifact storage

Declared artifacts and feed entries are records in the Marbles database,
scoped by workspace id; their bytes live outside the per-workspace
directories, in the artifact store under the Foundry home
(`~/.foundry/artifacts`):

```text
~/.foundry/artifacts/
  workspaces/<workspace-id>/blobs/   file bytes, one immutable file per blob
```

A `records.json` an earlier Marbles left there is ignored. An engine with
no database (a script no host loaded) keeps its artifacts in memory.

### Execution Runs

An Execution Run record is written when its run is queued, before it
starts, and at each change after. A launch's input is kept on the queued
record, so it must be plain JSON: `null`, booleans, strings, finite
numbers, arrays, and plain objects. A function, symbol, bigint, `Date`,
`Map`, class instance, cycle, non-finite number, or `undefined` in an array
is refused when the run is launched, and nothing is recorded. The run gets a
copy of what was recorded, whether its queue lets it in at once or a later
process lets it in again, so a caller that changes its input object after
launching changes nothing.

Each observation is a row of its own beside its run's record, so
recording one costs the same however many the run has; recording one again
by its id replaces it and moves it last. A record or observation that is
not one (a missing field) is skipped with a warning; the run itself still
loads.

A launch with a `source` looks for a run of the same name and source and
records a new one in one database transaction, so two engines sharing the
database start it once.

`get`, `list` and `gaps` on `engine.executions` answer from the engine at
once: what it changed, and what it last read of other processes' runs, at
start or at the latest `subscribe`. Subscribing reads the database again,
so a fresh subscription's snapshot carries what other processes wrote or
pruned since; their changes are not announced between subscriptions.

Pruning removes a settled run's own files (a workflow's Run and output
journal) before its record. A failure, or an exit in between, leaves the
settled record for a later prune to retry. Each removal and its scope's
retention gap are written in one transaction, so two processes pruning at
once never count one removal twice.

When a workflow's Run parks or resumes, its Execution Run's status is
written in the Run's own commit. A settle is written by the engine after
the Run's; a process that exits between the two leaves the record to the
next start, which settles it as the Run says.

A built-in tool call is observed as `denied` only when the live result was
produced by the Agents compiler's authorization refusal. Provenance is tracked
by object identity outside the JSON payload; business output with the same
shape remains `complete`. Serialized/replayed results do not acquire refusal
provenance from their data. CLI harnesses report explicit refusal outcomes.

## What survives a restart

Every change to a workflow Run is committed to the Marbles database as it
is made, with what the run's scope recorded (its ledger, each node's
literal input, its session) and the engine that owns it. Its Execution Run
is written as it changes, and a park or a resume lands in the same commit
as the Run's own, so the database always says whether a run is waiting or
working.

When the engine starts it lists the settled Runs as history. Adopting a
parked Run requires all of these conditions:

- The process can answer questions. A worker of the Marbles process always
  can: the question waits on the Feed for a dashboard. A `--dry-run` host
  persists nothing and adopts nothing.
- The definition is still registered.
- The engine wins the claim on the Run. The claim is one database
  transaction that reads the Run and its Execution Run and takes the Run's
  owner: it is won only while the Run is still stored parked, its
  Execution Run has not settled (a run cancelled after its process exited
  stays cancelled), and no live engine owns it. A canceller takes the
  same claim before it settles a run, so a settle lands before an
  adoption's claim or not at all.

An adopted Run stays this engine's until it settles or the engine stops,
so two workers never both resume one run. A stop gives up the claim and
leaves the Run parked for the next engine. The run parks again, its
question stays open on the feed, and the answer replays the body against
the recorded sessions and artifacts. A worker starts when its workspace is
attached, when the Marbles process starts and finds the workspace
`hosted`, and after a source edit, which drains the worker first: running
runs finish there, and parked runs stay for the fresh worker to adopt.

A Run left queued or running by a process that died is never run again at
start: nothing picks a run up mid-body. Its Execution Run is reconciled
with the Run as it is stored, in a transaction of its own, so two starting
engines never take one over twice: a Run that settled settles the record
the same way, one left parked keeps the record `suspended` for a process
that can adopt it, and one left running marks the record `interrupted`.
A queued Execution Run that never became a Run stays queued, unless the
host asks to let such runs in again (`recoverQueued`), in their original
order. A parked Run adopted without an Execution Run, one parked before
they existed, gets one when it is adopted. Results already committed stay
in the database, but a step that had not finished is not resumed; `status`
marks a Run whose owner exited while it ran as orphaned. A new launch does
not reuse its step results.

A stored record that cannot be read is skipped with a warning and costs
only that run.

## Scheduling and overlap

Local file coordination uses the [Lib file-lock helper](https://github.com/Francois-Esquire/foundry/blob/main/packages/lib/src/file-lock.ts).
Its PID ownership applies to one host, not a distributed worker pool.

The foreground loop measures an interval schedule's next tick from the
previous tick's completion, seeded from the recorded `lastFinish` so a restart
keeps the cadence. Missed interval ticks do not queue. Calendar slots are
evaluated in machine-local time.

A tick claims its trigger in the database before it runs. If another process holds it,
`roll <key>` prints `skipped: held by <holder>` and exits successfully.
`roll <definition-name>` takes no claim. Two schedules with different keys
have different claims even when they target the same workflow.

### Lock ownership and repair

The one lock left on disk, `locks/process`, the claim of the Marbles
process on the state root and of a worker on its workspace's directory,
is a file created exclusively with mode `0o600` that holds the owner's
pid; every other claim is a row of the Marbles database:

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

A process that finds `locks/<name>` held does not wait. It reports the
holder: `pid N`; `a process that is taking it now; retry` for a fresh empty
lock; `pid N, which has exited (if no process is taking the lock over,
remove <path>.break)` when a `.break` is in the way; or `an unknown process
(if none is running, remove <path>)` for a file that is neither.

### Monitor observations and delivery

Monitors are polled on their cadence. A poll compares what it sees with the
last recorded observation; the handler runs only when something changed, and
the observation is recorded only after the handler resolves, so a throwing
handler sees the same change again next tick. A launch the handler asked for
is recorded as `pending` and handed out on every tick until a start succeeds.
A target that is no longer registered fails one tick and is dropped; a started
run that later fails or is cancelled is not started again.

## Dry runs

Under `--dry-run` the workspace is hosted in the calling process, which
never touches the Marbles process, and nothing under the state root or the
artifact store is written, but for the SQLite side files a read of the
Marbles database may create or update (`marbles.db-shm`, `marbles.db-wal`). Sessions and the feed live in memory, monitor
observations live in the process, worktrees are cut under the system
temporary directory, and parked runs are cancelled when the process quits. Step bodies still execute; see
[safety and limits](/marbles/reference/safety).
