---
title: Scheduling with launchd
description: Let macOS start a fresh Quirks process for each scheduled tick.
---

On macOS, launchd owns the clock and Quirks exits after each tick.

From the directory containing the [getting-started configuration](/quirks/start-here):

```sh
quirks launchd install inspect-hourly
quirks status
quirks launchd uninstall inspect-hourly
```

Installation writes:

```text
~/Library/LaunchAgents/com.foundry.quirks.inspect-hourly.plist
```

The plist records the runtime and CLI paths used during installation, an absolute
configuration path, the state root, working directory, and an explicit `PATH`.
Output goes under:

```text
~/Library/Logs/quirks/
```

Installation uses `launchctl bootstrap`. Reinstallation unloads the previous
registration before loading the new one. If loading or unloading fails, Quirks
prints the error and the corresponding manual command.

Each tick imports the configuration again. Changes to behavior code therefore
take effect on the next invocation. Reinstall when changing the cadence or
captured paths and environment.

Intervals use launchd's `StartInterval`; calendar schedules use
`StartCalendarInterval`. Foreground completion-relative timing should not be
assumed for launchd. The generated agent does not run immediately on installation.

WebSocket monitors require `run` and cannot be installed as launchd schedules.

LaunchAgent labels currently contain only the schedule name. Use distinct
schedule names across projects to avoid collisions. In this release, `--dry`
does not prevent launchd installation or removal.

## Inspect and operate

`quirks list` inspects the loaded definitions. `quirks status` reads recorded
workspaces, foreground process information, schedules, runs, and session counts.
`quirks sessions` lists conversations in the current workspace.

In a terminal, status opens a TUI; press `q` or Ctrl+C to exit. Pipe it to another
command for plain text. A recorded non-terminal run whose PID is gone can appear
as orphaned. A killed process may leave no record of its active run.

Schedule locks skip overlapping ticks held by a live process. Different
schedules have separate locks; direct workflow dispatch does not take one.
See [state](/quirks/reference/state) for the precise persistence boundaries.
