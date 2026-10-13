---
title: Contexts
description: What is available during declaration, workflow setup, step execution, and monitoring.
---

A context is the object Marbles passes into a callback. The available
properties reflect what that callback is responsible for. Workflow setup
builds a tree; a step executes work; a monitor handles an observation.

## Definition time

At module scope you import factories such as `step`, `agent`, and `workspace`.
There is no callback argument or public `DefinitionContext` object. This is
the declaration environment: create definitions, give them defaults, and
connect triggers.

The objects returned here may be usable instances. For example,
`workspace(...)` returns a `WorkspaceInstance`, and `agent(...)` returns an
`Agent`. See [Definitions and instances](/marbles/foundation/definitions-and-instances).

## Workflow setup

`workflow(...).do(setup)` receives the setup context:

| Property | Meaning |
| --- | --- |
| `input` | The workflow's validated launch input. |
| `log` | A logger. |
| `run.id` | The run identifier. |

The callback returns a tree of locked steps. It has no `agents`, `exec`,
`ask`, or resource managers. Its underlying type is `SetupContext<I>`;
authoring callbacks infer it without a type annotation.

Setup can execute again when a parked run is recovered. Keep operational
work in steps, and pass the values they need as input.

The setup describes the run's structure for
[Workflows](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md).
Step execution is where Marbles attaches the other libraries to that run.

## Step execution

`step(...).do(body)` receives `Context<I>`. `I` comes from `.input(schema)`.
Destructure only what your step uses:

```ts
import { step } from "@foundry/marbles";

step("inspect-runtime").do(({ workspaces, run, log }) => {
  log("Working in", workspaces.current.root);
  return { workspace: workspaces.current.root, runId: run.id };
});
```

| Group | Properties | Purpose |
| --- | --- | --- |
| Data | `input` | Validated input, including results supplied by child steps. |
| Resources | `agents`, `workspaces`, `sandboxes`, `artifacts` | Open sessions, use directories, start sandboxes, and read or write outputs. |
| Commands | `exec` | Run an argument list with streamed output and cancellation. |
| People and results | `ask`, `report` | Ask for a decision or input; publish progress and results. |
| Execution | `log`, `stream`, `signal`, `run` | Log, stream custom output, observe cancellation, and identify the run. |

Resource managers return different objects: `agents.session` returns a
`Session`, `workspaces.load` a `LoadedWorkspace`, `sandboxes.start` a
`SandboxHandle`, and an artifact write an `ArtifactVersion`. These are the
objects you use inside the callback, not additional callback contexts.

Marbles connects owned operations to the step. For custom work such as
`fetch`, pass `signal` yourself. An ordinary filesystem write or external
request is still ordinary TypeScript and can repeat on replay.

This ownership is part of [durability](/marbles/foundation/durability).
A session opened through the context participates in the run's recorded
operations; a client constructed independently has only the guarantees
that client supplies. See [Foundry primitives](/marbles/foundation/primitives)
for the package behind each resource manager.

## Monitor handlers

`monitor(...).do(handler)` receives `MonitorContext`, which extends the
step context with:

| Property | Available for |
| --- | --- |
| `change` | Every handler; discriminate with `change.kind`. |
| `files` | File sources; added, modified, and removed files. |
| `response` | HTTP sources; the response body and status. |

Its `input` is empty; it has no launch-input schema. Prefer narrowing
`change.kind` before using file or HTTP-specific data. A handler can do
work directly or return one locked target to launch.

## Defaults and lifetime

The project root establishes the workspace. Definitions supply resource
defaults; a step's active scope supplies cancellation and output. An
operation's options can select another supported directory or session.

Inside `git.withWorktree(...)`, commands and newly opened sessions inherit
the temporary checkout. `workspaces.current.root` still identifies the
project; use the callback's `checkout.root` for raw filesystem operations.

Recorded operations such as opening sessions and writing artifact versions
use their call position during replay. Keep their order stable. The
[execution lifecycle](/marbles/foundation/execution-and-state) explains
recovery; the [API reference](/marbles/reference/api#context) lists exact
methods and options.
