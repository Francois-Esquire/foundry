---
title: State
description: Disk layout, hydration, locks, and the limits of continuity.
---

## Persisted state

The default state root is `~/.foundry/quirks`. Each workspace gets a directory
identified by a hash of its canonical filesystem path.

```text
~/.foundry/quirks/<workspace-id>/
  workspace.json          root, config, firstSeen, lastSeen
  runs/<runId>.json       saved run, jobs, frames, queue, owner pid
  schedules/<name>.json   lastStart, lastFinish, lastStatus, nextDue
  monitors/<name>.json    last successfully handled file or HTTP observation
  locks/<schedule>        pid holding a schedule lock
  heartbeat.json         foreground process information while run is active
  sessions/<id>.json      retained agent conversations
```

Quirks-owned JSON records carry `version: 1`. Session files use the underlying
session store's format.

The execution engine loads saved, settled runs when it starts. Schedule history
helps the foreground loop retain cadence across restarts. File and HTTP monitor
snapshots let a later invocation compare its observation with the previous
successfully handled one.

This is disk-backed history and continuity, not automatic recovery of interrupted
computation. Runs are normally saved after they settle. A killed process may
leave no complete record of its active work, and non-terminal saved runs are not
resumed during hydration. Invalid run files are skipped with a warning.

`status` reads the selected state root without requiring a running Quirks
process. It reports recorded workspaces, foreground process state, schedules,
runs, and session counts. It can mark a recorded non-terminal run as orphaned
when its owning process is gone.

## Scheduling and overlap

Foreground interval schedules measure their next interval from completion. They
do not accumulate a queue of missed interval ticks.

Schedule dispatch takes a lock scoped to the workspace and schedule name. If
another live process holds that lock, `once <schedule>` prints a skipped message
and exits successfully. Stale locks belonging to dead processes can be replaced.

Direct `once <step-or-workflow>` execution does not acquire a schedule lock.
Different schedules also have different locks, even if they target the same
workflow.

Live monitor events arriving while that monitor is busy are dropped. File
polling can detect a remaining filesystem difference later. WebSocket messages
have no equivalent polling recovery.

The heartbeat records the foreground PID and start time; it is not a periodic
liveness pulse. Status checks process liveness. Concurrent session access does
not inherit schedule locking when you dispatch a step directly.

For side effects and dry execution, see [safety and limits](/quirks/safety-and-limits).
