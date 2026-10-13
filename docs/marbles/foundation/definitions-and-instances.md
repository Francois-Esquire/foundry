---
title: Definitions and instances
description: What factories return, when operations start, and how a definition becomes a run.
---

Calling an authoring factory creates a definition. Some returned objects
also expose operations you can invoke later. Creating the object and
invoking those operations are separate events.

The returned objects adapt the [Foundry primitives](/marbles/foundation/primitives)
to Marbles' authoring API. For example,
[Agents](https://github.com/Francois-Esquire/foundry/blob/main/packages/agents/README.md)
supplies the session machinery, while Marbles binds a turn to its owning
step when the operation runs.

## Declare first, execute on use

```ts
import { agent, step } from "@foundry/marbles";

const reviewer = agent({ prompt: "Review without editing." });

step("review-readme").do(async () => {
  const reply = await reviewer.generate("Review README.md for clarity.");
  return reply.text;
});
```

Loading this module registers the step and declares the agent. It does not
send a model request. `marbles roll review-readme` enters the callback;
`reviewer.generate(...)` then starts a turn attached to that step.

That turn uses a fresh session. For multiple turns in one conversation,
open a session through the [execution context](/marbles/foundation/contexts#step-execution).

## What each factory returns

| Factory | Returned type | Operations |
| --- | --- | --- |
| `agent(...)` | `Agent` | `generate`, `stream`; each call uses a fresh session. |
| `workspace(...)` | `WorkspaceInstance` | `root`, file operations, and `git`; loads on use. |
| `sandbox(...)` | `SandboxInstance` | `exec`, container facets, and `close`; starts on use. |
| `artifact(...)` | `ArtifactInstance` | `write`, `latest`; writes create content versions. |
| `skills.load()` / `skills.none()` | `SkillSet` | Immutable `.add()` and `.pick()` operations, resolved when a session opens. |
| `step(...).do(...)` | `StepDefinition` | Call to make a node; `.series`/`.parallel` connect children; `.run` executes directly. |
| `workflow(...).do(...)` | `WorkflowDefinition` | Call to make a launch node; `.run` executes the workflow directly. |

The definition types, such as `AgentDefinition` and `SandboxDefinition`,
describe the declared data. Instance types add usable methods. You can pass
an instance anywhere its definition is accepted: `agents.session(reviewer)`
or `sandboxes.start(box)`.

## A definition, a node, and a run

For a step named `count`:

| Expression | What happens |
| --- | --- |
| `step("count").do(fn)` | Defines the work and registers it with the module catalog. |
| `count({})` | Creates a node with no children, ready to place in a workflow. |
| `count({}, input)` | Creates a node carrying literal input. |
| `await count.run(input)` | Executes now and returns its result. |
| `marbles roll count` | Launches the registered definition through the CLI. |

Creating a node is called **locking** a definition. It fixes the children
and literal input for that position in a tree. It is unrelated to the
process lock that prevents overlapping schedule ticks.

Prefer workflow children when each operation should appear as its own step
in the dashboard. `.run()` inside a body is recorded with that body, but its
nested run is not independently visible or controllable in the dashboard.
Stable tree positions also identify completed results and recorded calls
during [durable replay](/marbles/foundation/durability#replay-is-different-from-retry).

## Names and identity

Use explicit step and workflow names in shared examples. Named definitions
are launchable, and names must be unique within the catalog. Without a name,
Marbles can infer a top-level `const` name when TypeScript is available in
the project; otherwise the definition stays internal.

Give long-lived agents an explicit `name` when grants and agent-created
triggers should retain their identity as prompts change. An unnamed
agent's inferred name or definition digest determines its identity.

An artifact declaration identifies the same output across runs in a
workspace; writes add versions. Keep declarations stable as you evolve a
module. See [identity and state](/marbles/reference/state).

## Inside and outside a step

Inside a step, instance operations use the active run: its working
directory, output stream, cancellation, and recorded operations. Outside a
step, direct operations use the host runtime or a default runtime in a plain
script. That script must call `dispose()` when finished to release resources.

Keep module top level to declarations in CLI automations. `list` imports
modules too, so a top-level `await reviewer.generate(...)` would perform
work merely by listing them.
