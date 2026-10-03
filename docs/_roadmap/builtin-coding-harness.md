# A built-in coding harness

Maintainer note, excluded from the Blume site. Dated 2026-10-03.

## What we need

We need to run a coding agent with no CLI installed, on any model we can
reach through a gateway: Vercel AI Gateway, OpenRouter, or any
OpenAI-compatible endpoint. Its tools (read, write, edit, search, shell) run
inside a sandbox, and every call goes through Foundry's authorization with
no extra wiring.

Done means a workflow step can name a gateway model and get a working
coding agent that edits files and runs tests in a sandbox, with the same
approvals and records as any other agent.

## Opinion: how to build it

- Compose rather than build: the session harness, plus the sandbox toolkit
  (read, write, edit, grep, glob, bash, with guards), plus a gateway model.
  The tools go through the existing tool compilation, so authorization comes
  for free.
- Reach OpenRouter through the existing OpenAI-compatible gateway provider
  first, with its base URL and key. Move to the dedicated OpenRouter AI SDK
  provider, which supports AI SDK 7, only when a feature needs it, such as
  provider routing or reasoning options.
- Set an explicit step limit. The AI SDK tool loop stops after 20 steps
  unless told otherwise, which is too few for coding work.
- Write a coding system prompt for the toolkit's tools, and turn on
  compaction for long sessions.
- Expect it to trail Claude Code for a while. Edit reliability, context
  management, and subagents are what those CLIs have tuned. Measure both on
  the same tasks before relying on it.
