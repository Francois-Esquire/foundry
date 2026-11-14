---
title: One workflow, three ways
description: Run the same step from the CLI, from your own program, and from an MCP client.
---

A definition does not depend on what launches it. This page runs one step,
`count`, three ways: through the CLI, an embedded engine, and an MCP server.
The example needs no agent.

## The step

`count` counts the files in the workspace that end with an extension. It
needs `zod` installed beside it.

<include>./_example/count.ts</include>

Calling `step(...)` registers the definition with whichever host loads the
module; the `export` lets your own program take it too.

## 1. From the CLI

Save the module as `.foundry/marbles/count.ts` and roll it from the project
root:

```sh
marbles roll count --input '{"extension":".ts"}'
```

`roll` attaches the workspace to the Marbles process, starting it when none
runs, runs `count` in the workspace's worker, prints the step's status lines
and its result as JSON, and exits. The workspace stays hosted;
`marbles stop` ends the process. See the [CLI reference](/marbles/reference/cli).

## 2. From your own program

`@foundry.sh/marbles/lib` builds an `Engine` from explicit instances. This
one keeps everything in memory, uses no agent, and has no sandbox runtime:

<include>./_example/standalone.ts</include>

Nothing here starts the Marbles process, reads `.foundry/marbles`, or writes
state. `engine.run` waits for the result; `engine.launch` returns a run ID
first, and `engine.execute(count, input)` runs a definition you have not
registered. [Embedding the engine](/marbles/reference/engine) covers
persistence, agents, and shutdown.

To load a whole `.foundry/marbles` folder and run its triggers in your
process instead, use [`hostWorkspace`](/marbles/library/host-a-workspace),
using the package’s `/workspace` entry.

## 3. From an MCP client

An MCP client, usually an agent, starts the Marbles MCP server with
`marbles mcp` over STDIO and names the source. The server starts nothing,
so the workspace must already be hosted: run `marbles attach` first. This
program plays that client:

<include>./_example/mcp-client.ts</include>

`dispatch_workflow` returns a `runId` straight away; it is an
acknowledgement, not the result. `get_run` reads the run's status and, once
it settles, its `output`. A run waiting on a person reports `suspended`, so
the loop stops there too. From a terminal, `marbles watch <runId>` follows
the same run's output until it ends.

The run belongs to the Marbles process, not to the MCP connection. Closing
the client leaves the workspace hosted, its schedules and monitors running,
and any dispatched run going. Without a process that hosts the workspace,
`dispatch_workflow` returns an error that names `marbles attach`. The [MCP reference](/marbles/reference/mcp)
lists every tool, including the task tools.

## What changes between them

| | CLI | Embedded engine | MCP |
| --- | --- | --- | --- |
| Where the step runs | The workspace's worker in the Marbles process | Your process | The workspace's worker in the Marbles process |
| Run history on disk | Yes, under the state root | Only if you pass `state` | Yes, under the state root |
| Schedules and monitors | Run in the worker | Only if you drive them | Run in the worker |
| Who answers questions | The dashboard's Feed | Your program, with `askable: true` | The dashboard's Feed |
| Waits for the result | Yes | `run` yes, `launch` no | No; poll `get_run` |
