# Queue

The queue context decides when submitted work runs and keeps a durable
record of every attempt, every pause, and how each piece of work ended. It
knows nothing about schedules, calendars, or what the work does.

## Language

### Work

**Job**:
One piece of work someone asked for: which handler does it, with what
input, in which pool, under which policy. A job ends exactly once, as
complete, failed, or cancelled.
_Avoid_: task (a backlog item), request, execution

**Run**:
One attempt at a job. A job has at most one open run at a time; a retry is
a new run with the next attempt number.
_Avoid_: execution, try, invocation

**Attempt**:
The ordinal of a run within its job, starting at one.
_Avoid_: retry count

**Handler**:
The named piece of code that carries out a job's runs.
_Avoid_: worker, processor, executor

**Outcome**:
What a handler reports at the end of a run: complete with output,
suspended on a suspension, or bailed with an error that must not be
retried.
_Avoid_: result, status

**Bail**:
A handler's refusal of the work itself, such as invalid input. A bailed run
fails its job without a retry.
_Avoid_: abort, reject

### Capacity

**Concurrency pool**:
A named limit on how many runs may be running at once. Every job belongs to
one pool; a pool can be paused.
_Avoid_: lane, channel, worker pool

**Slot**:
One unit of a pool's limit, held by a running run and nothing else.
_Avoid_: permit, token

**Admission**:
Whether the queue accepts new top-level jobs and starts queued runs.
_Avoid_: intake, acceptance

### Pauses and progress

**Suspension**:
A durable pause a run asks for until something outside the queue answers,
such as a person's approval. A suspension is resolved with a value or
cancelled.
_Avoid_: wait, signal, hook

**Suspended**:
The state of a run, and of its job, held by a pending suspension. A
suspended run holds no slot.
_Avoid_: parked, waiting, sleeping, blocked

**Resolution**:
The value a resolved suspension answered with, handed to the run that
resumes after it.
_Avoid_: answer, reply

**Checkpoint**:
Progress a handler saves on its run so a later attempt or a resumed run can
pick up where it left off. Only the handler understands its contents.
_Avoid_: snapshot, state, savepoint

### Ownership

**Lease**:
A queue's claim on a running run, recording who runs it and since when.
_Avoid_: lock, claim

**Owner**:
The queue a queued run or a lease belongs to. Several queues can live in
one process, and each owns only its own work. An owner that names only a
process stands for any queue in it.
_Avoid_: host, node, worker

**Unowned**:
A queued run no queue owns, which any live queue that is not retiring and
has its handler may start. Retries and resumed runs are unowned.
_Avoid_: orphaned, free

**Recovery**:
Taking back runs whose owner is gone: running ones are interrupted and
retried if their policy allows; queued ones are adopted.
_Avoid_: restart, resync

**Adoption**:
Taking over a run another queue left: a queued run during recovery, or a
suspended run, whose pending suspensions move to a new revision so a
resolution read before the takeover is refused as stale.
_Avoid_: steal, claim

**Abandonment**:
Failing an open run whose driver is gone, without retrying it.
_Avoid_: kill, reap

**Retirement**:
A queue closing admission for good while its running work finishes
untouched. A retiring queue starts no queued run. Children of its running
runs are still admitted, unowned, and the queued runs it owns are handed
over to a successor or left unowned.
_Avoid_: shutdown, decommission

**Hand-over**:
Giving a queued run to another queue, or to any queue in another process,
to own.
_Avoid_: transfer, migration

**Removal**:
Deleting a settled job together with its runs and suspensions.
_Avoid_: purge, cleanup

**Drain**:
Stopping new runs from starting and letting running ones finish, up to an
optional grace period after which they are interrupted.
_Avoid_: flush, quiesce

### Policy

**Retry policy**:
How many attempts a job gets, how long to back off between them, and the
longest it may keep trying.
_Avoid_: retry config

**Backoff**:
The delay before the next attempt becomes available: fixed, linear,
exponential, or jittered.
_Avoid_: delay strategy

**Idempotency key**:
A caller's name for a job that makes submitting it again return the
existing job instead of new work.
_Avoid_: dedupe key, request id
