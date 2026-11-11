---
title: Library
description: Use Marbles from your own TypeScript program instead of the CLI.
sidebar:
  label: Overview
---

The `marbles` CLI is one host for your automations. The same package also
lets your own Bun program define work, run it, host a workspace, or talk to
the Marbles process. Use the library when the CLI does not fit: an
application that runs a step on demand, a test, or a service of your own.

## Entries

| Import | Use it to | Page |
| --- | --- | --- |
| `@foundry.sh/marbles` | Write definitions: `step`, `workflow`, `agent`, `workspace`, `sandbox`, `artifact`, `schedule`, `monitor`, and the workspace's `tasks`. Every host reads these. | [API reference](/marbles/reference/api) |
| `@foundry.sh/marbles/prebuilt` | Register ready-made read-only review steps. | [Prebuilt steps](/marbles/reference/project#prebuilt-steps) |
| `@foundry.sh/marbles/lib` | Build an `Engine` from explicit instances, register definitions, and run them in your process. | [Embedding the engine](/marbles/reference/engine) |
| `@foundry.sh/marbles/workspace` | Host one `.foundry/marbles` source the way the CLI's worker does: discovery, environment, modules, triggers. | [Host a workspace](/marbles/library/host-a-workspace) |
| `@foundry.sh/marbles/process` | Start the machine's Marbles process, or join it as a client, as the dashboard and the MCP server do. | [Host a workspace](/marbles/library/host-a-workspace#start-or-join-the-marbles-process) |

The Foundry libraries underneath, such as Workflows, Agents, and Tasks, are
private workspace packages. Marbles bundles them; you cannot install them on
their own. Take their classes from `@foundry.sh/marbles/lib` (see
[package instances](/marbles/reference/engine#package-instances)).

## Release status

These pages describe the source checkout. As checked on 2026-11-10, npm
`latest` is `0.0.3`, which exports all five entries above. The `alpha` tag
still points to `0.0.2`, which lacks `/workspace` and `/process`. If an example
uses newer checkout behavior, [build a package archive](/marbles/contributing#build-a-distributable-package)
and install the same artifact for both the CLI and project types. A release
and a checkout archive can share a version number but expose different APIs.

## Start here

[One workflow, three ways](/marbles/library/one-workflow-three-ways) runs the
same step from the CLI, from your own program, and from an MCP client. Each
example on that page is a file the repository's tests execute.
