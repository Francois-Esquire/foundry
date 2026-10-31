---
title: Roadmap
description: What Marbles is focused on now, what comes next, and where it is heading.
sidebar:
  label: Now, Next, Later
---

Marbles starts with local automation. Browser resources and MCP access come
next, followed by hosted collaboration and remote operation. These are
priorities, not release dates; planned interfaces may change.

<span id="now--standalone-local-automation"></span>

## Now: standalone local automation

Improve the standalone CLI, TypeScript authoring, and the path from a first
automation to a complete workflow. The CLI already supports steps,
workflows, workspaces, agents, sandboxes, artifacts, schedules, and monitors.

[Using Marbles](/marbles/get-started/using-marbles) shows these capabilities;
[Foundation](/marbles/foundation/api) explains how they fit together.

<span id="next--browser-automation-and-mcp"></span>

## Next: browser automation and MCP

### Browser definitions, instances, and profiles

Add a `browser` resource that a step can invoke. Load a saved profile and
reuse it across browser tasks. Its output, cancellation, and lifetime
should follow the step's [execution context](/marbles/foundation/contexts),
using the same [definition and instance model](/marbles/foundation/definitions-and-instances)
as other resources.

### Expose Marbles through an MCP definition

Add a definition for hosting a Model Context Protocol server. Choose which
steps, workflows, and other Marbles capabilities a connected client can
use, with an option to expose the full catalog.

<span id="later--hosted-collaboration-and-remote-operation"></span>

## Later: hosted collaboration and remote operation

### A hosted server and web application

Host a server for multi-agent communication and a web application for
people working with those agents. MCP is one connection option.

Bring the CLI dashboard's definitions, triggers, runs, sessions, outputs,
and human decisions into that web application.

### Server-side execution, remote setups, and event triggers

Support installing and operating Marbles on a server with persistent
state, so work can continue beyond an attended local session.

Extend triggers with incoming webhooks. External events should launch the
same workflows as local commands, schedules, and monitors.

[Deployment targets](/marbles/roadmap/deployment) records the targets,
the current position, and the solutions for running Marbles as a service
and as a library inside a serverless backend.

For what is possible today, see [Remote execution](/marbles/reference/remote)
and [Schedules and monitors](/marbles/foundation/triggers). Those pages
describe the current CLI; hosted services, remote tooling, and webhook
triggers above are planned work.
