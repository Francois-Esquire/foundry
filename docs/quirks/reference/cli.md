---
title: CLI reference
description: Commands and flags for running and inspecting local Quirks behaviors.
---

Use the globally installed command:

```sh
quirks [command]
```

| Command | Behavior |
| --- | --- |
| No command or `run` | Open the splash and live dashboard; Enter starts triggers. |
| `help`, `--help`, `-h` | Print usage without loading configuration. |
| `list` | List registered executable definitions, schedules, and monitors. |
| `once <name>` | Dispatch a step, workflow, schedule, or polling monitor now. Print its result and exit. |
| `status` | Inspect recorded workspaces under the selected state root. |
| `sessions` | List sessions for the current workspace, including message counts, update times, and summary presence. |
| `launchd install <schedule>` | Write and load a macOS LaunchAgent for the named schedule or polling monitor. |
| `launchd uninstall <schedule>` | Unload and remove that LaunchAgent. |

The dashboard shows Triggers, Catalog, and Runs, including live steps and saved
run history. It opens even when no triggers are configured. Click a row or press
Enter for details; click the quirks title or press `h` to return to the dashboard.

Press `q` or Ctrl+C for the quit dialog. A second Ctrl+C confirms, stopping
triggers and cancelling active runs. Completed results and monitor checkpoints
persist unless `--dry` is set. Interrupted runs cannot resume. Custom steps must
honor their context's `signal` to stop external work; cancellation cannot undo
side effects.

When stdin or stdout is not a terminal, `quirks` and `quirks run` start immediately
and emit plain text without a splash or dialog. SIGINT and SIGTERM stop new
triggers and let active runs finish.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--config <path>` | `./quirks.config.ts` | Configuration module. If absent, built-in definitions remain available. |
| `--state <dir>` | `~/.foundry/quirks` | Root directory for workspace state. |
| `--input <json>` | Schedule input, or no input for a direct definition | Input for `once`; overrides a schedule's configured input. |
| `--harness <id>` | All detected harnesses | Restrict execution to `claude-code` or `codex`. Repeatable. |
| `--dry` | Off | Apply the [execution substitutions](/quirks/safety-and-limits). |

When both stdin and stdout are terminals, `status` opens an OpenTUI view. Press
`q` or Ctrl+C to close it. Redirected or piped output is plain text.

Inspection commands still import an existing configuration. Keep module-level
code limited to declarations when inspection should avoid application side
effects.
