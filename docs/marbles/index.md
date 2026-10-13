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

[Foundation](/marbles/foundation/api) starts with the Marbles model:
definitions describe work, workflows connect it, and runs execute it.
Contexts then connect that work to environments, agents, and outputs.
Durability and triggers build on those ideas, followed by local state and
the Foundry libraries underneath.

## Build something useful

| Use case | Outcome |
| --- | --- |
| [Software Factory](/marbles/use-cases/software-factory) | Take an issue through implementation, review, delivery, and on-call follow-up. |
| [Design Sync](/marbles/use-cases/design-sync) | Propose code changes from a Figma color palette. |

The [reference](/marbles/reference/cli) covers commands, API details, project
setup, and troubleshooting. Marbles primarily runs on your own machine;
[remote execution](/marbles/reference/remote) describes the current boundary.

## See what's next

The [roadmap](/marbles/roadmap) follows the next additions: browser resources
with reusable profiles, MCP access to your definitions, a hosted web
application for people and agents, and deeper remote and event support.
