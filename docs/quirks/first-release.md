---
title: Introducing Quirks
description: Programmable local behavior with five TypeScript factories.
sidebar:
  hidden: true
---

Quirks turns recurring behaviors into inspectable TypeScript. This first release
introduces a local package and CLI for defining what should happen, what should
be watched, when it should run, and where an agent may participate. Five
factories, `step`, `workflow`, `agent`, `schedule`, and `monitor`, let a small
deterministic task grow into a composed behavior without leaving ordinary code.

Behaviors run once, remain active in a foreground process, or execute through
fresh processes scheduled by launchd. Claude Code and Codex provide the current
execution harnesses for model turns. Disk-backed run history, schedule records,
monitor snapshots, and agent sessions carry context between invocations. Step
bodies retain direct access to TypeScript and the underlying Foundry libraries.

- **Composition:** reusable steps, executable workflow graphs, and bounded repetition with `loopUntil`.
- **Observation:** file and HTTP change detection, plus live WebSocket messages during foreground operation.
- **Continuity:** named agent sessions, retained monitor observations, and recorded schedule outcomes.
- **Local operation:** one-shot execution, foreground schedules, dry-run model and Git substitutions, status inspection, and macOS launchd integration.
- **Working examples:** implementation and review steps, a bounded implement-review loop, parallel reviews in a temporary worktree, and a reviewer that retains its conversation across runs.
