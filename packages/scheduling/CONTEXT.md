# Scheduling

The scheduling context decides when recurring or future work is due and
hands each due moment to a dispatcher exactly once. It knows nothing about
concurrency, retries, or how the work runs.

## Language

**Schedule**:
A standing instruction to dispatch the same target on a cadence, with rules
for overlap and misfire. A schedule is active or paused.
_Avoid_: job, cron job, timer, trigger

**Cadence**:
When a schedule is due: every fixed interval, at a wall-clock time on chosen
weekdays in a timezone, on a cron expression in a timezone, once at an
instant, or a fixed delay after its previous work settled.
_Avoid_: frequency, recurrence, period

**Occurrence**:
A schedule's record of one moment its cadence made due (its scheduled-for
time): claimed, dispatched, skipped, or settled once its dispatched work
ended. Its identity is the schedule and that time, so no due time is
dispatched twice.
_Avoid_: run, execution, firing, slot, tick

**Claim**:
The first scheduler to record an occurrence wins it; any other scheduler,
in this process or another, sees it as already claimed. A claim whose
dispatch fails is released.
_Avoid_: lock, lease

**Cursor**:
A schedule's durable progress: the next due time, the last one handled,
when dispatched work last settled, and which dispatched work is still open.
A scheduler commits a cursor only over the one it read.
_Avoid_: state, checkpoint, offset, watermark

**Instance**:
One live scheduler, named by its process and its own instance id. Two
schedulers in one process are different instances and never take each
other's claims as their own.
_Avoid_: node, worker, replica

**Target**:
What a schedule dispatches at each occurrence: a handler, its input, and
optionally a pool and policy.
_Avoid_: action, payload, command

**Dispatch**:
Handing an occurrence's target to whatever runs work, under the
occurrence's identity as the idempotency key.
_Avoid_: enqueue, submit, fire

**Open**:
Dispatched work that has not ended yet, including work suspended in the queue.
_Avoid_: running, active, in flight

**Overlap**:
What a schedule does when an occurrence comes due while its previous work is
still open: skip the occurrence, allow both, or cancel the previous work
first.
_Avoid_: concurrency policy

**Misfire**:
Several occurrences coming due at once because the scheduler was paused or
down. Run-once dispatches only the latest of them; skip dispatches none and
waits for the next due time. A fixed delay never misfires: at most one
occurrence is due at a time.
_Avoid_: catch-up, backfill, missed run

**Retention**:
How many terminal (settled or skipped) occurrences a schedule keeps
(`maxOccurrencesPerSchedule`); older ones are pruned. Claimed and dispatched
occurrences are always kept.
_Avoid_: history limit, cleanup

**Trigger now**:
Dispatching a schedule's target immediately, outside its cadence, even while
it is paused.
_Avoid_: run now, kick
