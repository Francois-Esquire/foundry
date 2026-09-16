---
title: Configuration
description: Registration, module resolution, handles, and built-in definitions.
---

The CLI looks for `./quirks.config.ts`, or the path passed to `--config`. It
imports an existing file before processing commands other than bare usage. If
the file is absent, built-ins remain available. A missing explicit path is also
currently treated as absent rather than rejected.

The workspace root is the canonical configuration directory, or the command's
working directory without a config. Relative paths in your custom code still
follow normal JavaScript and filesystem rules; prefer `workspace.root` when
you mean the config directory.

## Registration and binding

`step` and `workflow` return executable definition handles. `agent` returns an
agent specification. `schedule` and `monitor` register definitions and return
`void`. A schedule accepts either a step/workflow handle or its registered name.
Duplicate names in the same registry are rejected.

The CLI binds runtime resources after importing the configuration. Do not
execute registered step bodies at module scope. Keep imports declarative when
inspection commands should avoid application side effects.

## Package resolution

The CLI resolves config imports of `@foundry/quirks` to its own installed library.
This makes a global installation usable without local `node_modules`, and keeps
the configuration and CLI on one registry instance. Other libraries imported by
the config must be available through normal module resolution.

For editor types, you can additionally install the same version of
`@foundry/quirks` in the project. Keep it aligned with the global CLI; execution
uses the CLI's version. Directly importing Quirks outside the CLI only registers
definitions and does not bind a runtime.

## Built-ins

Built-ins register before the user's configuration. Choose distinct names.

| Name | Input and behavior |
| --- | --- |
| `implement` | `{ cwd, prompt }`; one turn through the first executor. |
| `review` | `{ cwd, prompt }`; second executor, falling back to the first. |
| `develop-round` | `{ task, cwd, round, findings }`; implementation followed by review. |
| `develop` | Same input; up to five implement-review rounds. |
| `review-in-worktree` | `{ repository, base }`; parallel reviews in a temporary checkout. |
| `review-session` | `{ repository, base }`; a temporary checkout reviewed with a retained conversation. |

`review-session` derives the session ID from `base`. Reviewing different
repositories at the same base inside one Quirks workspace currently reuses that
ID. The built-in review parser accepts a standalone `PASS` line, and also treats
an empty response as no findings. It is not a test runner or proof of completion.
