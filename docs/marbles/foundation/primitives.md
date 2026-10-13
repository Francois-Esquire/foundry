---
title: Foundry primitives
description: The libraries Marbles combines into one local automation runtime.
---

Marbles brings Foundry's libraries together behind one CLI and TypeScript
authoring API. A workflow can open a coding session, work in a Git checkout,
run a command in a sandbox, and publish a versioned result because those
capabilities share contracts and a run that owns their lifetime.

The standalone package bundles these libraries. Keep importing
`@foundry/marbles` in automation modules; the package links below explain
the underlying primitives and their broader APIs, not extra installation
requirements.

## How a run uses the primitives

A launch enters Workflows as a tree of steps. Marbles gives each step a
context through which it can open sessions, use files, execute commands,
and publish results. That context connects the libraries below to the
run's replay, cancellation, output, and cleanup.

| Library | Primitive | Where you use it in Marbles |
| --- | --- | --- |
| [Workflows](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md) (`@foundry/workflows`) | Steps, execution snapshots, retries, suspensions, queues, and orchestration. | `step`, `workflow`, `.config`, and the run behind each launch. Start with [Durability](/marbles/foundation/durability). |
| [Agents](https://github.com/Francois-Esquire/foundry/blob/main/packages/agents/README.md) (`@foundry/agents`) | Agent harnesses, sessions, messages, skills, and tool authorization. | `agent`, `agents.session`, and `skills`. See [Agents and sessions](/marbles/foundation/agents-and-sessions). |
| [Models](https://github.com/Francois-Esquire/foundry/blob/main/packages/models/README.md) (`@foundry/models`) | Provider and model resolution, capabilities, and catalogs. | An agent's `provider` and `model`, CLI harness selection, or an embedding host's `ModelManager`. |
| [Workspaces](https://github.com/Francois-Esquire/foundry/blob/main/packages/workspaces/README.md) (`@foundry/workspaces`) | Source identity, file inventories, reads and writes, observation, and Git capabilities. | `workspace`, `workspaces.current`, and temporary Git worktrees. |
| [Sandbox](https://github.com/Francois-Esquire/foundry/blob/main/packages/sandbox/README.md) (`@foundry/sandbox`) | Files and commands over isolated backends, container lifecycles, and coding tools. | `sandbox`, `sandboxes.start`, and sandbox agent sessions. See [Workspaces and sandboxes](/marbles/foundation/workspaces-and-sandboxes). |
| [Artifacts](https://github.com/Francois-Esquire/foundry/blob/main/packages/artifacts/README.md) (`@foundry/artifacts`) | Stable artifact identity, content versions, file trees, and stored bytes. | `artifact`, `artifacts`, `report.artifact`, and feed storage. See [Artifacts and results](/marbles/foundation/artifacts-and-results). |
| [Core](https://github.com/Francois-Esquire/foundry/tree/main/packages/core/src) (`@foundry/core`) | Shared storage and pagination contracts without runtime dependencies. | The common file and storage vocabulary beneath workspaces, sandboxes, and artifacts. |
| [Lib](https://github.com/Francois-Esquire/foundry/blob/main/packages/lib/README.md) (`@foundry/lib`) | Shared configuration, authorization, paths, digests, file classification, and other focused helpers. | Runtime configuration, permission decisions, observation identity, and local file coordination. |

## What Marbles adds

The libraries supply reusable capabilities. Marbles supplies module
discovery, the authoring catalog, CLI defaults, a dashboard, trigger loops,
local state placement, and managers that attach operations to a step.

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
bundled `@foundry/marbles/lib` exports for those instances so they match
the engine's copy of the classes.
