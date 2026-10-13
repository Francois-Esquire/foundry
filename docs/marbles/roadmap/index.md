---
title: Roadmap
description: What Marbles is focused on now, what comes next, and where it is heading.
sidebar:
  label: Now, Next, Later
---

Marbles starts with automations you can write, run, and inspect on your own
machine. The next steps extend that same model to browsers, other agents,
and hosted environments.

This roadmap describes priorities, not release dates. **Now** is the current
focus; **Next** and **Later** describe planned capabilities. Their API shapes
and delivery order can change as we build them.

## Now — standalone local automation

The current focus is making the standalone CLI and TypeScript authoring
model clear and useful for everyday work. That includes a small first
automation, a coherent conceptual foundation, and use cases that connect
the primitives into complete workflows.

The CLI already brings together steps, workflows, workspaces, agent sessions,
sandboxes, artifacts, schedules, and file and HTTP monitors. The local
dashboard makes those runs inspectable and lets people participate in them.
Start with [Using Marbles](/marbles/get-started/using-marbles) to see the current
capabilities, then [Foundation](/marbles/foundation/api) to understand how they
fit together.

## Next — browser automation and MCP

These additions give automations another resource to work with and give
other tools a way to invoke the work you have already defined.

### Browser definitions, instances, and profiles

Add `browser` to the definition and instance API. An automation will be able
to declare a browser resource and use its instance from a step, following
the same [definition-to-instance model](/marbles/foundation/definitions-and-instances)
as other Marbles resources.

The planned profile support will let you load a saved browser profile,
reuse it for later browser work, and continue building automations around
that environment. Browser activity should join the step's
[execution context](/marbles/foundation/contexts), with its output,
cancellation, and lifetime connected to the surrounding workflow.

### Expose Marbles through an MCP definition

Add a definition for hosting a Model Context Protocol (MCP) server backed by
Marbles. The goal is to make your authored definitions available to a
connected MCP client, including the ability to invoke steps and workflows.

You will be able to choose what the server exposes, with an option to
include the full definition catalog and the other capabilities available
through Marbles. An agent or application that connects to the server can
then use those automations through MCP.

## Later — hosted collaboration and remote operation

The next layer brings those capabilities into a shared service and expands
how work reaches it.

### A hosted server and web application

Build a server we host that supports multi-agent communication and a web
application for Marbles. MCP will be one way to connect; the service will
also provide a shared place for agents and people to work with automations.

The web application should cover everything the CLI dashboard shows today:
definitions, triggers, runs and their progress, agent sessions, outputs,
and the decisions that need a person. The aim is to carry the same ability
to inspect and control work into the browser.

### Server-side execution, remote setups, and event triggers

Develop server-side support and a supported path for running Marbles in
remote environments, building on the local execution model and its state.
That work includes the setup and operation of the runtime on a server, so
automations can keep working beyond an attended local session.

Extend schedules and monitors into a more integrated trigger system,
including incoming webhooks. External events should be able to launch
the same workflows that you can run locally, with their execution visible
alongside scheduled and monitored work.

For what is possible today, see [Remote execution](/marbles/reference/remote)
and [Schedules and monitors](/marbles/foundation/triggers). Those pages
describe the current CLI; hosted services, remote tooling, and webhook
triggers above are planned work.
