---
title: Using Marbles
description: Explore the capabilities you can combine in a local automation.
---

Once you have [run one step](/marbles/get-started/quickstart), you can add
capabilities independently. These examples introduce each one; Foundation
explains how their definitions, instances, and contexts fit together.

## Run once or keep running

Use `marbles roll <name>` for one result. Use `marbles` and press Enter to
open the dashboard and start schedules and monitors. The dashboard also
lets you launch work and answer questions. A schedule declared in a file
needs a running Marbles process to execute.

For a local unattended loop, `marbles run </dev/null` starts immediately
with plain output. It cannot answer questions. See [CLI modes](/marbles/reference/cli).

## Give work input

Install the schema library in your project:

```sh
bun add zod@4.4.3
```

Save this as `.foundry/marbles/count.ts`:

```ts
import { step } from "@foundry/marbles";
import { z } from "zod";

step("count")
  .input(z.object({ extension: z.string() }))
  .do(async ({ input, workspaces }) => {
    const files = await workspaces.current.files();
    return {
      extension: input.extension,
      files: files.filter((file) => file.path.endsWith(input.extension)).length,
    };
  });
```

Run `marbles roll count --input '{"extension":".ts"}'`. The schema validates
input and supplies its TypeScript type. Schemas exposing Standard JSON
Schema also describe the dashboard's input form; other schemas use a JSON
field. [Input and output](/marbles/reference/api#the-builder).

## Run commands

A step can be one command:

```ts
import { step } from "@foundry/marbles";

step("test-project").exec("bun test");
```

Use this in a project with Bun tests. Run `marbles roll test-project` and
inspect its exit code and output. A nonzero exit fails the step. Commands
also work inside `.do()` through `exec`. [Execution context](/marbles/foundation/contexts#step-execution).

## Connect steps into workflows

A workflow connects steps through their inputs and results. Run dependent
work in order and independent work in parallel. For example, collect test
results and review findings before producing a report.

[Composition](/marbles/foundation/composition) builds a small working tree.
[Software Factory](/marbles/use-cases/software-factory) applies the same
model to implementation, verification, and approval.

The [Workflows runtime](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md)
records results for both commands and agent work.
[Durability](/marbles/foundation/durability) covers waiting, retries, and restarts.

## Work with projects and sandboxes

`workspaces.current` reads your project. `workspace({ path: "../other-project" })`
declares another directory. Git worktree callbacks give a task its own
checkout; commands and agent sessions opened inside inherit that location.
These operations come from [Workspaces](https://github.com/Francois-Esquire/foundry/blob/main/packages/workspaces/README.md).

`sandbox(...)` declares an isolated execution environment, which starts on
use. Choose its mounts, network access, and resources explicitly. The sandbox
runtime is optional. [Workspaces and sandboxes](/marbles/foundation/workspaces-and-sandboxes).
The [Sandbox library](https://github.com/Francois-Esquire/foundry/blob/main/packages/sandbox/README.md)
supplies the underlying file, command, and container interfaces.

## Add an agent and keep its conversation

With an installed, authenticated Claude Code or Codex CLI, save this as
`.foundry/marbles/explain.ts`:

```ts
import { agent, step } from "@foundry/marbles";

const guide = agent({ prompt: "Explain this project without editing files." });

step("explain").do(async ({ agents }) => {
  const session = await agents.session(guide);
  return (await session.generate("What are the main parts of this project?"))
    .text;
});
```

Run `marbles roll explain`. Use a session for multiple turns; keep its
`session.ref` to continue it in a later run. Skills add reusable instructions
and files. [Agents and sessions](/marbles/foundation/agents-and-sessions).

[Agents](https://github.com/Francois-Esquire/foundry/blob/main/packages/agents/README.md)
keeps the conversation; [Models](https://github.com/Francois-Esquire/foundry/blob/main/packages/models/README.md)
resolves the provider and model. Marbles gives their execution the owning
step's stream, cancellation, and retry policy.

For a ready-made starting point, `marbles init developer` creates a review
module. `init` without a choice creates a project summary. These are optional
starters; [project setup](/marbles/reference/project#prebuilt-steps) lists them.

## Ask a person and publish results

`ask.approval(...)` and `ask.question(...)` pause a step for a dashboard
answer. `report.result(...)` posts a readable result to the feed.
`report.artifact(...)` saves a versioned output and posts it to the feed.

Use the dashboard for work that asks questions. A one-shot `roll` or an
unattended loop cancels at an ask. [Contexts](/marbles/foundation/contexts)
explains these operations; [human approval](/marbles/use-cases/software-factory/approve)
puts them together.

Versioned outputs use [Artifacts](https://github.com/Francois-Esquire/foundry/blob/main/packages/artifacts/README.md).
[Artifacts and results](/marbles/foundation/artifacts-and-results) explains
when to return a value, post a message, or save files for a later run.

## Schedule work and react to changes

Save this complete module as `.foundry/marbles/heartbeat.ts`:

```ts
import { monitor, schedule, step } from "@foundry/marbles";

const heartbeat = step("heartbeat").do(({ log }) => {
  log("Marbles is running");
  return { alive: true };
});
schedule(heartbeat).every("30s");

monitor("**/*.md")
  .every("30s")
  .do(({ files, log }) => log(files));
```

Open `marbles`, press Enter, and wait for a tick. The step logs every 30
seconds while the loop is active. The monitor reports existing Markdown
files on its first poll, then changes on later polls. HTTP monitors use the
same pattern for a URL. [Schedules and monitors](/marbles/foundation/triggers).

## Choose a use case

| Build | Combine |
| --- | --- |
| [Software Factory](/marbles/use-cases/software-factory) | Issues, work logs, implementation, review, delivery, and on-call reports. |
| [Design Sync](/marbles/use-cases/design-sync) | External data, workflow gates, and proposed code changes. |

Continue with [Foundation](/marbles/foundation/api) to understand the model
behind these capabilities. See [safety and limits](/marbles/reference/safety)
when running agent work or unfamiliar modules.
