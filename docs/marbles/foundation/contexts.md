---
title: Execution contexts
description: Understand what each callback receives and how resources become part of a run.
sidebar:
  label: Contexts and bindings
---

A context is the argument Marbles passes to a callback. Workflow setup
receives what it needs to build the tree. A step receives what it needs to
execute its work. The two contexts have different interfaces.

## Definition time

At module scope, factories such as `step` and `workspace` create
[definitions and instances](/marbles/foundation/definitions-and-instances).
Module evaluation has no callback context or public `DefinitionContext` type.

## Workflow setup

In the [composition example](/marbles/foundation/composition),
`workflow(...).do(setup)` uses launch input to return a tree of locked steps.
Its setup context contains:

| Property | Meaning |
| --- | --- |
| `input` | The workflow's validated launch input. |
| `log` | A logger. |
| `run.id` | The identifier of this run. |

There are no `agents`, `exec`, `ask`, or resource managers in this callback.
Setup chooses the structure of the work. Its underlying type is
`SetupContext<I>`; TypeScript infers it from the authoring callback.
Keep operational work in the steps that setup connects.

## Step execution

`step(...).do(body)` receives `Context<I>`. Its `input` combines literal
input with the completed child results declared by the step's input schema.
The rest of the context connects the body to its run:

```ts
import { step } from "@foundry/marbles";

step("inspect-runtime").do(({ workspaces, run, log }) => {
  log("Working in", workspaces.current.root);
  return { workspace: workspaces.current.root, runId: run.id };
});
```

| Group | Properties | What the step can do |
| --- | --- | --- |
| Data | `input` | Read validated input and child results. |
| Resources | `workspaces`, `agents`, `sandboxes`, `artifacts` | Work with directories, conversations, environments, and outputs. |
| Commands | `exec` | Run an argument list with streamed output and cancellation. |
| People and results | `ask`, `report` | Wait for a person's answer or publish an outcome. |
| Execution | `log`, `stream`, `signal`, `run` | Write output, observe cancellation, and identify the run. |

Destructure only what the step uses. The following pages cover the resource
operations in detail.

## Binding resources to a run

A resource definition says what you want to use. **Binding** connects an
operation on that resource to this execution: its workspace, output stream,
cancellation signal, and lifetime.

For example, `agents.session(reviewer)` returns a `Session` attached to the
current step. Its turns use that step's working directory, write to its
stream, and stop when the step is cancelled or paused. The same connection
applies when you call an agent instance's methods from inside the step.

The returned session is an object the body uses, not a new callback context.
Likewise, `workspaces.load` returns a `LoadedWorkspace`, `sandboxes.start`
a `SandboxHandle`, and an artifact write an `ArtifactVersion`.

Marbles adds these bindings around the
[Workflows runtime](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md)
and the resource libraries. Ordinary TypeScript still needs its own wiring:
pass the context's `signal` to a raw `fetch` if it should stop with the step.
A separately constructed client does not automatically gain Marbles' bindings.

## Waiting for a person

`ask.approval(...)` waits for a decision, and `ask.question(...)` waits for
input. The dashboard presents these requests and returns the person's answer
to the callback. A waiting step is **parked** until it can continue.

Use the dashboard for work that asks questions. `roll` and headless `run`
cannot answer and cancel at a workflow ask. How a parked body continues,
including after a restart, is explained later in
[Durability](/marbles/foundation/durability).

## Other callback contexts

A monitor handler receives `MonitorContext`: the step context plus `change`
and file- or HTTP-specific data. Its input is empty because it handles an
observation rather than schema-defined launch input.
[Schedules and monitors](/marbles/foundation/triggers) introduces those
callbacks when you are ready to start runs automatically.

The [API reference](/marbles/reference/api#context) lists the exact methods
and options. Next: [Workspaces and sandboxes](/marbles/foundation/workspaces-and-sandboxes)
explains where these bound operations take place.
