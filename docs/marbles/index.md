---
title: Marbles
description: Write local automations in TypeScript and run them with a standalone CLI.
sidebar:
  label: Introduction
---

Marbles is a standalone CLI for automations you write in TypeScript. Use it
to inspect a project, run commands, connect steps into workflows, and repeat
work on a schedule or when files change. Add a coding agent where the task
needs judgment.

Each launch runs through [Workflows](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md),
which gives the work recorded results, configurable retries, and waiting
points. Marbles connects agent sessions and resources to that run. This
[durability](/marbles/foundation/durability) is part of the execution model
from your first step, with local state supplied by the CLI.

Your automations live in your project, under `.foundry/marbles/`. This is a
complete automation:

```ts
import { step } from "@foundry/marbles";

step("inventory").do(async ({ workspaces, log }) => {
  const files = await workspaces.current.files();
  log(`Found ${files.length} files`);
  return { files: files.length };
});
```

Run it with `marbles roll inventory`. The CLI prints the result and keeps
the run history locally. Open `marbles` for the dashboard, or keep it running
to execute schedules and monitors.

## Start with one result

[Install Marbles](/marbles/get-started/installation), then
[write your first automation](/marbles/get-started/quickstart). The first
example needs no agent account, Git repository, or sandbox runtime.

Afterward, [Using Marbles](/marbles/get-started/using-marbles) introduces the
capabilities you can add: inputs, workflows, workspaces, agents, sandboxes,
artifacts, human decisions, and triggers.

## Understand how it works

[Foundation](/marbles/foundation/durability) starts with durability and the
[Foundry primitives](/marbles/foundation/primitives) behind Marbles. It then
explains what a definition creates, which context a callback receives, and
how workflows, sessions, and versioned outputs fit together.

## Build something useful

| Use case | Outcome |
| --- | --- |
| [Software Factory](/marbles/use-cases/software-factory) | Implement a task on a branch, test and review its commit, then ask for a decision. |
| [Repository Caretaker](/marbles/use-cases/repository-caretaker) | Investigate changes to repository instructions. |
| [Persistent Reviewer](/marbles/use-cases/persistent-reviewer) | Revisit findings in a conversation that continues across runs. |
| [Release Watcher](/marbles/use-cases/release-watcher) | Assess a release's relevance to your project. |
| [Design Sync](/marbles/use-cases/design-sync) | Propose code changes from a Figma color palette. |

The [reference](/marbles/reference/cli) covers commands, API details, project
setup, and troubleshooting. Marbles primarily runs on your own machine;
[remote execution](/marbles/reference/remote) describes the current boundary.
