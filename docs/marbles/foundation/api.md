---
title: The Marbles model
description: Understand the relationship between an automation, its steps, and each run.
---

An automation describes work you want to repeat. In Marbles, you write that
description in TypeScript and launch it with the CLI. Each launch creates a
**run**: one execution of the work, with its own input, progress, and result.

Start here after the [quickstart](/marbles/get-started/quickstart). Foundation
builds from the shape of an automation to the resources it uses, then to
what happens when it waits, fails, or runs again.

## Start with a step and a run

The quickstart's inventory is one **step**: a callback that does a piece of
work and returns a value.

```ts
import { step } from "@foundry/marbles";

const inventory = step("inventory").do(async ({ workspaces }) => {
  const files = await workspaces.current.files();
  return { files: files.length };
});
```

Loading this module defines `inventory`. Running `marbles roll inventory`
executes its callback and records the result. Running the command again
creates another run; the definition stays the same, but the files and the
result may have changed.

The callback receives a **context**. Here, `workspaces` is the part of that
context that gives the step access to the project. Other properties let a
step run commands, open an agent conversation, or report an outcome.

## Connect work with a workflow

A **workflow** connects steps through their inputs and results. For example,
a code review can collect changed files, ask an agent to review them, and
save the findings. Each stage has a result the next stage can use.

| Concept | What it describes | In a review automation |
| --- | --- | --- |
| Step | One piece of work. | Collect changes, perform a review, or write a report. |
| Workflow | How steps depend on one another. | The review receives the collected changes; the report receives the findings. |
| Run | One execution of a step or workflow. | This review of this project's current changes. |

A single step is already launchable. Add a workflow when there are stages
you want to connect and inspect separately. Both use the
[Workflows runtime](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md);
an agent is optional work inside a step.

## Give the work resources and a way to start

The authoring API has three groups:

| Group | API | Question it answers |
| --- | --- | --- |
| Work | `step`, `workflow` | What should happen, and which results does it need? |
| Resources | `workspace`, `agent`, `sandbox`, `artifact`, `skills` | Where does the work happen, what can it use, and what does it produce? |
| Triggers | `schedule`, `monitor` | When should a new run start? |

Named steps and workflows appear in `marbles list` and the dashboard's
Marbles panel. Resource declarations support that work. Schedules and
monitors appear in the Triggers panel. A trigger chooses when to launch
work; it does not replace the step or workflow it launches.

Use `@foundry/marbles` for these declarations. Marbles bundles the libraries
behind them, so the automation stays independent of the Foundry repository.

## How the ideas build

First, separate **declaring work** from **executing it**, then connect steps
through their results. With that structure in place, execution contexts
explain how Marbles binds workspaces, agents, and outputs to a run.

Once those pieces are familiar, **durability** explains what the run can
remember and repeat. Triggers and local execution then explain how to
operate it over time. The final package map ties these concepts back to
the Foundry libraries that implement them.

Next: [Definitions and instances](/marbles/foundation/definitions-and-instances)
explains what the objects in an automation represent before anything runs.
