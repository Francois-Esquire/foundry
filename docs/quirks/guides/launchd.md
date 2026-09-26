---
title: Scheduling with launchd
description: Let macOS start a fresh Quirks process for each scheduled tick.
---

On macOS, launchd owns the clock and Quirks exits after each tick.

From the directory containing the [Start Here configuration](/quirks/start-here),
whose schedule `list` prints with the key `inspect`:

```sh
quirks launchd install inspect
quirks status
quirks launchd uninstall inspect
```

The argument is a schedule or monitor key as `list` prints it. Installation
writes:

```text
~/Library/LaunchAgents/com.foundry.quirks.inspect.plist
```

The plist records the Bun and CLI paths in use at installation, the absolute
configuration path, the state root, the working directory, and an explicit
`PATH`. Each tick runs `quirks once <key> --config … --state …`. Output goes
to:

```text
~/Library/Logs/quirks/<key>.log
```

Installation uses `launchctl bootstrap`. Reinstallation unloads the previous
registration before loading the new one. If loading or unloading fails,
Quirks prints the error and the corresponding manual command.

Each tick imports the configuration again, so changes to behavior code take
effect on the next invocation. Reinstall when changing the cadence or the
captured paths and environment.

Intervals use launchd's `StartInterval`; calendar schedules use
`StartCalendarInterval`. Foreground completion-relative timing does not apply
under launchd. The generated agent does not run at load.

A launchd tick has nobody to answer a question. A run that reaches
`ask.approval` or `ask.question` under a tick is cancelled at the ask, and its
outcome is recorded as failed for that tick. Behaviors that ask belong on the
dashboard, or on a schedule that fires while the dashboard is open.

LaunchAgent labels contain only the key. Two projects whose configs produce
the same key collide; name the targets differently. `--dry` does not prevent
launchd installation or removal.

## Inspect and operate

`quirks list` inspects the loaded definitions. `quirks status` reads recorded
workspaces, foreground process information, schedules, recent runs, and
session counts without loading an engine. `quirks sessions` lists
conversations in the current workspace.

In a terminal, `status` opens a view; press `q` or Ctrl+C to exit. Pipe it to
another command for plain text. A run that was running when its process died
appears as orphaned; a run parked on a question is kept and adopted by the
next dashboard.

Schedule locks skip overlapping ticks held by a live process. Different keys
have separate locks; direct step dispatch does not take one. See
[state](/quirks/reference/state) for the precise persistence boundaries.
