---
title: Foundry primitives
description: The libraries Marbles combines into one local automation runtime.
---

Marbles bundles the libraries below. Import `@foundry.sh/marbles` to write an
automation; follow a package link when you need its underlying contract or
implementation.

## How a run uses the primitives

A launch enters Workflows as a tree of steps. Marbles gives each step a
context through which it can open sessions, use files, execute commands,
and publish results. That context connects the libraries below to the
run's replay, cancellation, output, and cleanup.

| Library | Responsibility in Marbles |
| --- | --- |
| [Workflows](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md) | Executes steps and workflows, records results, applies retry policies, and supports waiting. |
| [Agents](https://github.com/Francois-Esquire/foundry/blob/main/packages/agents/README.md) | Keeps conversations, skills, and tool authorization for `agent` and `agents.session`. |
| [Models](https://github.com/Francois-Esquire/foundry/blob/main/packages/models/README.md) | Resolves the agent's `provider` and `model`. |
| [Workspaces](https://github.com/Francois-Esquire/foundry/blob/main/packages/workspaces/README.md) | Provides file operations, observation, and Git worktrees. |
| [Sandbox](https://github.com/Francois-Esquire/foundry/blob/main/packages/sandbox/README.md) | Runs isolated environments and their file, command, and process operations. |
| [Artifacts](https://github.com/Francois-Esquire/foundry/blob/main/packages/artifacts/README.md) | Keeps named outputs, content versions, stored bytes, and Feed entries. |
| [Core](https://github.com/Francois-Esquire/foundry/tree/main/packages/core/src) | Defines shared storage and pagination contracts. |
| [Lib](https://github.com/Francois-Esquire/foundry/blob/main/packages/lib/README.md) | Supplies configuration, authorization, paths, digests, and local file coordination. |

## What Marbles adds

Marbles supplies module discovery, the catalog, CLI defaults, the dashboard,
trigger loops, local state, and the bindings between resources and steps.

For example, Workflows supplies the retry and suspension machinery. Marbles
records the agent sessions and artifact versions opened by a step, and
persists parked runs for later adoption. Agents keeps the conversation;
Artifacts keeps the report. Together they support a workflow that waits
for approval without repeating its completed review.

The package APIs can support host choices the CLI does not expose. Read
Marbles' [durability guarantees](/marbles/foundation/durability) and
[remote limits](/marbles/reference/remote) when deciding what a CLI
deployment can do. A library's recovery API does not by itself enable
automatic recovery of an interrupted Marbles run.

## When to go deeper

Use these docs to author and operate automations. Follow a package link
when you need to understand a resource's underlying contract, investigate
its implementation, or reuse a primitive in another product.

For an embedded Marbles host, the [engine reference](/marbles/reference/engine)
shows how to provide the package instances and persistent stores. Use its
bundled `@foundry.sh/marbles/lib` exports for those instances so they match
the engine's copy of the classes.

## Package entry points

| Import | Intended use |
| --- | --- |
| `@foundry.sh/marbles` | Author automations: builders, resource factories, triggers, helpers, and their types. |
| `@foundry.sh/marbles/prebuilt` | Register a ready-made step with your chosen options. |
| `@foundry.sh/marbles/lib` | Embed an engine in another application with explicit dependencies. |

With this foundation, [Software Factory](/marbles/use-cases/software-factory)
puts the pieces together in a complete local workflow. Use the
[API reference](/marbles/reference/api) when you need exact options and types.
