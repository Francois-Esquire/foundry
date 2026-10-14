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

Marbles is **alpha**, starting at `0.0.1`. Any `0.0.x` release may introduce
breaking changes. `0.1.0` will mark the first supported API baseline.

Your automations live in your project, under `.foundry/marbles/`. This is a
complete automation:

```ts
import { step } from "@foundry.sh/marbles";

step("inventory").do(async ({ workspaces, log }) => {
  const files = await workspaces.current.files();
  log(`Found ${files.length} files`);
  return { files: files.length };
});
```

Run it with `marbles roll inventory`. The CLI prints the result and keeps
the run history locally. Open `marbles` for the dashboard, or keep it running
to execute schedules and monitors.

[Workflows](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md)
records the step results and provides optional retries and waiting points.
Marbles binds commands, agent sessions, and resources to each run. See
[Durability](/marbles/foundation/durability) for what it can retain and resume.

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
| [Evaluations](/marbles/use-cases/evaluations) | Compare models, harnesses, and skills against recorded cases. |
| [Design](/marbles/use-cases/design) | Develop a brief into wireframes, a reviewed product, and ongoing design updates. |
| [Productivity](/marbles/use-cases/productivity) | Start the morning with GitHub, Slack, and document updates since you left work. |

The [reference](/marbles/reference/cli) covers commands, API details, project
setup, and troubleshooting. Marbles primarily runs on your own machine;
[remote execution](/marbles/reference/remote) describes the setup and limits.

## See what's next

The [roadmap](/marbles/roadmap) follows the next additions: browser resources
with reusable profiles, MCP access to your definitions, a hosted web
application for people and agents, and deeper remote and event support.
