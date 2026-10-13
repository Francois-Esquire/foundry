---
title: Marbles
description: A harness becomes something you build with.
sidebar:
  label: Introduction
---

**Marbles turns recurring automations into inspectable TypeScript.**

A modern coding-agent harness combines model turns, tools, instructions, and
conversation history. Marbles gives those ingredients a place in ordinary code,
alongside workflows, observation, scheduling, and disk-backed state. A harness
becomes something you build with. You decide where its agentic loop belongs
within a larger automation.

Define what should happen, what should be watched, when it should run, and where
an agent may participate. Run it once or keep Marbles running in a terminal
for schedules and monitors.

```text
Code + Workflows + Agents + Schedules + Monitors + Persistent State
```

Each piece of work is a step. Steps lock into a tree, and a named tree is a
workflow. This one, from the [Software Factory](/marbles/guides/software-factory),
implements a task on a branch, reviews the branch, and waits for a person to
approve it:

```ts
const ship = workflow("ship")
  .input(z.object({ task: z.string() }))
  .do(({ input: { task } }) =>
    approve({ review: review({ branch: implement({}, { task }) }) })
  );
```

`implement` and `review` each open an agent session. `approve` asks a person.
A monitor on an issue feed can start `ship` whenever a new task appears.

## What could you build?

- [A software factory](/marbles/guides/software-factory) that implements,
  tests, reviews, and reports on a schedule.
- [A repository caretaker](/marbles/recipes/repository-caretaker) that notices
  instruction changes and investigates meaningful drift.
- [A persistent reviewer](/marbles/recipes/persistent-reviewer) that compares
  revisions with its earlier findings.
- [A release watcher](/marbles/recipes/release-watcher) that asks whether a new
  release matters to this workspace.

Small automations can stay small: a single deterministic step is a complete
module. [Start Here](/marbles/start-here) builds one.

[Build your first automation](/marbles/start-here) · [Learn the concepts](/marbles/concepts) · [Build the Software Factory](/marbles/guides/software-factory)
