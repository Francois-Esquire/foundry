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
weekdays in a timezone, on a cron expression in a timezone, or once at an
instant.
_Avoid_: frequency, recurrence, period

**Occurrence**:
A schedule's record of one moment its cadence made due (its scheduled-for
time): claimed, dispatched, skipped, or settled once its dispatched work
ended. Its identity is the schedule and that time, so no due time is
dispatched twice.
_Avoid_: run, execution, firing, slot, tick

**Claim**:
The first process to record an occurrence wins it; any other process sees it
as already claimed.
_Avoid_: lock, lease

**Cursor**:
A schedule's durable watermark: the next due time, the last one handled,
when dispatched work last settled, and which dispatched work is still open.
_Avoid_: state, checkpoint, offset

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
waits for the next due time.
_Avoid_: catch-up, backfill, missed run

**Trigger now**:
Dispatching a schedule's target immediately, outside its cadence, even while
it is paused.
_Avoid_: run now, kick
