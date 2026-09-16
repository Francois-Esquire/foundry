---
title: Quirks
description: A harness becomes something you build with.
sidebar:
  label: Introduction
---

**Quirks turns recurring behaviors into inspectable TypeScript.**

A modern coding-agent harness combines model turns, tools, instructions, and
conversation history. Quirks gives those ingredients a place in ordinary code,
alongside workflows, observation, scheduling, and disk-backed state. A harness
becomes something you build with. You decide where its agentic loop belongs
within a larger behavior.

Define what should happen, what should be watched, when it should run, and where
an agent may participate. Run it once, keep it active in a terminal, or let
launchd invoke it on a schedule.

```text
Code + Workflows + Agents + Schedules + Monitors + Persistent State
```

## What could you build?

- [A repository caretaker](/quirks/use-cases/repository-caretaker) that notices
  instruction changes and investigates meaningful drift.
- [A persistent reviewer](/quirks/use-cases/persistent-reviewer) that compares
  revisions with its earlier findings.
- [A correspondent](/quirks/use-cases/pen-pal) with conversation history and a
  deliberate cadence. This is an application blueprint, with transport supplied
  by your code.

Small behaviors can stay small. Start with one deterministic step:

```ts
import { step } from "@foundry/quirks";

step("inspect", async ({ workspaces, workspace }) => {
  const directory = await workspaces.add({ path: workspace.root });
  const { files } = await directory.refresh();
  return { files: files.length };
});
```

The step does not need model judgment. Other behaviors can combine deterministic
operations with a coding agent, retain a conversation across runs, or react when
a source changes.

Save it as `quirks.config.ts` and use `quirks once inspect`. The
[five factories](/quirks/concepts) let that function grow into something that
composes work, observes change, remembers, and returns.

[Build your first behavior](/quirks/start-here) · [Explore use cases](/quirks/use-cases)
