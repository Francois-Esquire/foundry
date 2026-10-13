---
title: Introducing Marbles
description: Programmable local automation in nine TypeScript words.
sidebar:
  hidden: true
---

Marbles turns recurring automations into inspectable TypeScript. This first release
introduces a local package and CLI for defining what should happen, what should
be watched, when it should run, and where an agent may participate. Nine words,
`step`, `workflow`, `agent`, `workspace`, `sandbox`, `artifact`, `skills`,
`schedule`, and `monitor`, let a small deterministic task grow into a composed
automation without leaving ordinary code.

Automations run once or stay active in a foreground dashboard or headless loop.
Claude Code and Codex provide the current
providers for model turns. Disk-backed run files, schedule records, monitor
observations, and agent sessions carry context between invocations. Step
bodies stay ordinary TypeScript.

- **Composition:** steps with typed input and output, locked into trees that
  run in series or in parallel, named as workflows.
- **Observation:** file and HTTP change detection on a cadence, with handlers
  that can start a workflow.
- **Continuity:** a run parked on a question survives a quit or a crash and is
  answered from the next dashboard; sessions continue by reference; declared
  artifacts gain a version per run.
- **Local operation:** one-shot execution, a dashboard that can answer, steer,
  pause, and cancel, dry runs that echo agent turns, git, and sandbox
  commands, and status inspection.
- **Working examples:** a development loop of implementation and review steps,
  and prebuilt read-only steps for review, prototyping, and orientation.
