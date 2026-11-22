---
title: Concepts
description: The Marbles vocabulary, what each word declares, and how definitions become runs.
sidebar:
  label: Overview
---

A Marbles module is a list of declarations. Each declaration is one part of
an agent harness: a piece of work, an agent, a place to run, a record to
keep, or a reason to start. The CLI loads the module, and nothing executes
until something launches a run.

## The vocabulary

| Group | Words | Chapter |
| --- | --- | --- |
| Work | `step`, `workflow`, `.exec`, `.run()`, `.launch()` | [Steps and workflows](/marbles/concepts/steps-and-workflows) |
| Judgment | `agent`, `skills`, MCP servers, sessions, `models`, `usage`, `prompts` | [Agents, skills, MCP, and sessions](/marbles/concepts/agents-and-sessions) |
| Coordination | `tasks`, `observe`, `runs` | [Tasks and observability](/marbles/concepts/tasks-and-observability) |
| Reasons to start | `monitor`, `schedule` | [Monitoring and scheduling](/marbles/concepts/monitoring-and-scheduling) |
| Places and records | `workspace`, `sandbox`, `artifact`, `report` | [Workspaces, sandboxes, and artifacts](/marbles/concepts/workspaces-and-artifacts) |
| People and recovery | `ask`, `bail`, retries, parked runs | [Durability, approvals, and local state](/marbles/concepts/durability) |

Import every word from `@foundry.sh/marbles`. Marbles bundles the
libraries behind them, so an automation does not depend on the Foundry
repository. [Foundry primitives](/marbles/concepts/primitives) maps each
word to its library.

## Definitions, nodes, and runs

A definition describes work. A run is one execution of it, with its own
input, progress, and result:

```ts
import { step } from "@foundry.sh/marbles";

const count = step("count-files").do(async ({ workspaces }) => {
  const files = await workspaces.current.files();
  return files.length;
});
```

`step("count-files")` creates a builder, and `.do(...)` returns a
`StepDefinition`. Loading the module registers the name. The callback has
not run.

The same definition can be used in several ways:

| Expression | What happens |
| --- | --- |
| `count()` or `count({})` | Creates a node to place in a workflow. No work executes. |
| `count({}, input)` | Creates a node carrying literal input. |
| `await count.run(input?)` | Executes the definition in this process and returns its result. |
| `await count.launch(input?)` | Starts a separate run on the engine and returns `{ id, result }` at once. |
| `marbles roll count-files` | Launches the registered definition from the CLI. |

A **node** is one placement of a definition in a workflow tree. Creating one
is called **locking**: it fixes the node's children and literal input.
Calling `count()` with no arguments locks a definition that needs no input,
using the current source checkout; the published `0.0.4` package needs
`count({})`. [Steps and workflows](/marbles/concepts/steps-and-workflows#run-launch-or-lock)
compares `.run()` and `.launch()`.

Use explicit, unique names for launchable steps and workflows. Shared helper
definitions can live in modules whose names start with `_`; see the
[catalog rules](/marbles/reference/project#names-and-the-catalog) for name
inference and discovery.

## Resource instances

A resource declaration returns an instance that also has methods:

```ts
import { step, workspace } from "@foundry.sh/marbles";

const project = workspace({ path: "." });

step("read-project").do(async () => {
  const files = await project.files();
  return { files: files.length };
});
```

`project` is a `WorkspaceInstance`. Its definition names a directory, and
`files()` reads it when called. An agent instance has `generate` and
`stream`; a sandbox starts on its first operation; an artifact has `write`
and `latest`. Inside a step, those methods use the step's working
directory, output, and cancellation. The [API
reference](/marbles/reference/api#using-a-definition) lists them.

## Keep module scope to declarations

Marbles imports your modules even for `marbles list`. Declarations
describe what exists. Operations such as `project.files()`, an agent turn,
or `tasks.create()` do work. Put operations in step bodies, observer
handlers, and monitor handlers, so they happen when something runs. `tasks`
and `runs` refuse calls while a source loads.

## Keep the identities separate

Different records answer different questions:

| Identity | Names |
| --- | --- |
| Definition name | What can run: `pre-push`, `check-task`. |
| Run id | One execution: `rn-…`. `runs.get(id)` reads it. |
| Task id | One piece of work in the backlog: `tk-…`. It can take many runs. |
| Session ref | One agent conversation, which can continue across runs. |
| Artifact version | The exact files an output held at one write. |

A task outlives its runs, a conversation outlives its step, and an
artifact version outlives the worktree that produced it. Pass ids and
versions between stages, not temporary paths or live handles.

Next: [Steps and workflows](/marbles/concepts/steps-and-workflows).
