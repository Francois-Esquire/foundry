# Visible tool calls and refusals

Maintainer note, excluded from the Blume site. Dated 2026-10-03.

## What we need

A CLI harness runs its own tools inside its own loop. Foundry sees the text
it streams back, but not reliably what it did: which commands it ran, which
files it changed, which calls were refused. When an agent stalls because a
call was refused, the run should say so.

Every tool call a harness makes, and every refusal with its reason, should
be recorded in the run's session and logs, attributed to the run and the
agent.

Done means reading a finished run answers "what did the agent execute, and
what was it stopped from doing?" without opening the CLI's own transcripts.

## Opinion: how to build it

- Claude Code: a `PreToolUse` hook runs before the permission check on every
  call, so it is the one place guaranteed to see all of them. Record from
  there. Refusals arrive during the turn as `permission_denied` system
  messages and again as a list on the final step's provider metadata. Turn
  both into session events.
- Codex: record from the app-server's item events for command executions
  and file changes.
- Use one session event shape for both harnesses: tool, a summary of the
  input, outcome (ran, refused, failed), and reason.
- Log through the same wide events as turns. Summarize inputs rather than
  storing them whole, since commands can carry secrets.
