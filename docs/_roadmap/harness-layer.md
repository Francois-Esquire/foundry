# Harnesses as their own layer

Maintainer note, excluded from the Blume site. Dated 2026-10-03.

## What we need

Two different kinds of thing run an agent's turn. One is a language model
driven by Foundry's own tool loop. The other is a coding agent such as
Claude Code or Codex, which brings its own loop, tools, permissions, and
session history. Treating the second kind as a language model hides what
makes it useful and causes problems:

- two tool loops stacked on each other;
- approvals that don't connect;
- history kept twice, once in Foundry's messages and once in the CLI's own
  session;
- no way to steer or interrupt mid-turn, change the permission mode, or
  rewind files.

We need one interface for "the thing that runs a turn", covering sessions,
turns, steering, interruption, approvals, and a stream of normalized events,
that both kinds implement. The model registry keeps its own job: which
models exist, where they route, and what they cost.

Done means a workflow step picks a harness and a model, and adding a
harness doesn't require changes to the loop, the session store, or the UI.

## Opinion: how to build it

- Put the interface in the agents package, beside the session harness. The
  models package goes back to being the catalog and the network providers.
  A provider's `harness` field, meaning "who runs the turn", is the routing
  key.
- Start with two implementations: built-in (the AI SDK tool loop over any
  network model, with Foundry's tools) and CLI (Claude Code and Codex).
- For the CLI implementations, keep the community AI SDK providers as the
  transport for now, and use what they expose:
  - the approval callback;
  - the query controller, for interrupting, setting the permission mode,
    and rewinding files;
  - the raw SDK message callbacks, for events.
- If that layer gets in the way, swap to the Claude Agent SDK and the Codex
  app-server directly, behind the same interface. That gives full control,
  but each harness costs much more to build and maintain, so wait for a
  concrete need.
- Fix the naming: the provider's `harness` field and the agents package's
  `harness` module mean different things today.
