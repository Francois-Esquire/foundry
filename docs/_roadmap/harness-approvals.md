# CLI tool calls under Foundry authorization

Maintainer note, excluded from the Blume site. Dated 2026-10-03.

## What we need

Foundry has its own authorization: capabilities, policies that allow, deny,
or ask, and grants that remember a decision. It covers only the tools
Foundry defines itself. The tools that matter most, a CLI harness's shell,
file edits, and web access, never reach it.

Any tool call from a CLI harness that its static rules don't settle should
go through the same authorization, under the same policy and grants, as
Foundry's own tools.

- "Ask" works in attended and unattended runs alike. Attended: a person
  answers while the turn waits. Unattended: the call is refused with a clear
  reason, the request is recorded for a person, and approving it lets the
  next run proceed.
- An approval can be remembered as a grant, so the same request is not
  asked twice.
- A refusal tells the agent why, so it can choose another route.

Done means one policy governs everything an agent can do, whichever harness
runs it.

## Opinion: how to build it

- Add one provider-neutral permission callback to the options used when a
  session's model or harness is created. The type lives in the agents
  package; each harness maps it to its native mechanism.
- Claude Code: `canUseTool`. It receives the tool name, the input, a
  ready-made prompt (`title`, `displayName`), and proposed permanent rules
  (`suggestions`). It returns allow, optionally with edited input, or deny
  with a message the model reads. The provider turns on streaming input by
  itself when the callback is set.
- Codex: answer the app-server's approval requests for command execution
  and file changes through the provider's server-request handlers. Today
  they surface as approval parts in the stream and nothing answers them.
- Map each call to a capability: a new tool source for harness tools, such
  as `harness`, carrying the harness's tool name. Shell calls can also carry
  the command for finer policy matching later.
- Never suspend the workflow from inside the callback. Suspension parks the
  run and replays it later, which would kill the live CLI turn. Attended
  runs wait in-process for the answer, honoring the abort signal the SDK
  passes. Unattended runs deny with "needs approval: ...", record an
  approval request in the feed, and approving it writes a grant.
- Fast path: compile existing grants and policy into the harness's allow
  and deny lists when the session starts. The CLI checks those lists before
  calling back, so most calls never reach the callback.
