---
title: Introducing Marbles
description: A standalone CLI for local TypeScript automations.
sidebar:
  hidden: true
---

The planned first release is **0.0.1 (alpha)**. Any `0.0.x` release may
introduce breaking changes. `0.1.0` will mark the first supported API baseline.
GitHub Releases and npm publication are separate steps; a GitHub Release
does not mean the package has been published to npm.

Marbles is a standalone CLI for local TypeScript automations. Define work
with `step` and `workflow`, supply resources with `agent`, `workspace`,
`sandbox`, `artifact`, and `skills`, then add `schedule` or `monitor` when
it should run automatically.

Automations run once or stay active in a foreground dashboard or headless loop.
Claude Code and Codex perform model turns. Disk-backed run files, schedule records, monitor
observations, and agent sessions carry context between invocations. Step
bodies stay ordinary TypeScript.

- **Composition.** steps with typed input and output, locked into trees that
  run in series or in parallel, named as workflows.
- **Observation.** file and HTTP change detection on a cadence, with handlers
  that can start a workflow.
- **Continuity.** a run parked on a question survives a quit or a crash and is
  answered from the next dashboard; sessions continue by reference; declared
  artifacts gain a version per write.
- **Local operation.** one-shot execution, a dashboard that can answer, steer,
  pause, and cancel, dry runs that echo agent turns, git, and sandbox
  commands, and status inspection.
- **Working examples.** a development loop of implementation and review steps,
  and prebuilt read-only steps for review, prototyping, and orientation.
