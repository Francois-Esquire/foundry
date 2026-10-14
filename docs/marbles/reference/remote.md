---
title: Remote execution
description: Run the CLI on another host and understand the current deployment boundary.
---

Marbles can run on another machine as a CLI process with its own project,
dependencies, credentials, and persistent storage. The execution model is
the same as local operation. There is no built-in deploy command, hosted
control plane, remote dashboard connection, or distributed worker pool.

The [roadmap](/marbles/roadmap#later-hosted-collaboration-and-remote-operation)
describes the planned hosted service, server-side support, and event triggers.

## One remote host

Prepare the target host with:

1. Bun and the [standalone package](/marbles/get-started/installation).
2. The project and `.foundry/marbles/` modules at a stable path.
3. The project's dependencies and tools used by its steps.
4. Credentials available to that host. For agents, authenticate the
   installed CLI there; a login on your laptop is not a remote login.
5. Persistent directories for state and artifacts, writable by the
   account running Marbles.

After connecting to that host, run from its project root. These paths are
examples; create and choose directories appropriate for the account:

```sh
cd /srv/my-project
marbles list
marbles roll inventory --state /srv/marbles-state --artifacts /srv/marbles-artifacts
marbles run --state /srv/marbles-state --artifacts /srv/marbles-artifacts </dev/null
```

`inventory` must be a definition in that project. Use an attended terminal
and `marbles` for the dashboard if the work asks questions. Headless `run`
starts triggers immediately and cannot answer workflow asks.

## What deployment must supply

Your environment must keep the process alive, restart it when appropriate,
capture logs, provision credentials, and update the project and package.
Marbles does not provision those facilities. Reloading edited modules
requires a process restart.

Process supervision and [workflow durability](/marbles/foundation/durability)
serve different purposes. Restarting the CLI brings its loops back, but it
does not resume an interrupted running step. A scheduler that launches
`roll` again creates a new run. Account for earlier external effects before
relaunching.

State is scoped to the canonical workspace path. Changing that path changes
the workspace ID, even with the same `--state` directory. Artifacts live in
a separate store. Preserve both stores when continuity matters, and stop
active processes before moving state. The run snapshots from
[Workflows](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md),
[Agents](https://github.com/Francois-Esquire/foundry/blob/main/packages/agents/README.md) transcripts,
and [Artifacts](https://github.com/Francois-Esquire/foundry/blob/main/packages/artifacts/README.md) content
are distinct records; keeping only one store does not preserve the whole
automation's context.

Process locks contain local PIDs. They coordinate processes on one host;
they are not distributed locks. Do not share one writable state store
between independent machines as a worker-coordination mechanism.

## Limits to plan around

- A parked run can be adopted by a later dashboard on the same setup. A
  run interrupted mid-body is not automatically resumed.
- An ephemeral host loses local history unless its storage is preserved.
- Host CLI authentication, sandbox guest lifetime, mounts, and networking
  must work on the target host. Containerizing the CLI does not itself
  provide a working MicroSandbox environment.
- A remote scheduler invoking `roll` must choose work that needs no
  interactive answer and account for its own retry policy.

This page describes the supported process and state model, not a tested
deployment recipe for a particular cloud. Start by validating one complete
local automation, then verify its actual tools and credentials on the target
host. See [state and recovery](/marbles/reference/state).
