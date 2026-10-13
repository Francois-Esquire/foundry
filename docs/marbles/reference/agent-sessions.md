---
title: Agent sessions
description: Host and sandbox options, permissions, questions, child agents, and managed triggers.
---

For the authoring model, start with [Agents and sessions](/marbles/foundation/agents-and-sessions).
This page covers the advanced options of `agents.session(definition, options)`.

The contracts come from [Agents](https://github.com/Francois-Esquire/foundry/blob/main/packages/agents/README.md),
with provider resolution from [Models](https://github.com/Francois-Esquire/foundry/blob/main/packages/models/README.md)
and guest commands and tools from [Sandbox](https://github.com/Francois-Esquire/foundry/blob/main/packages/sandbox/README.md).
Marbles binds their lifetime to the owning step. Read
[Durability](/marbles/foundation/durability#replay-is-different-from-retry)
for the difference between continuing a conversation, replaying a step,
and retrying a failed attempt.

| Session kind | Options |
| --- | --- |
| Host | `cwd`, `session`; credentials and tool configuration belong to the installed CLI. |
| Sandbox | `sandbox`, `session`, `profile`, `authority`, `question`, `apiKey`, `oauthToken`. A sandbox selects its working directory through its mounts; `cwd` is not accepted. |

`session` is an existing `Session` or its serializable `SessionRef`.
Native CLI sessions manage their own compaction and reject an explicit
`compaction` setting. Network-model sessions support host compaction settings.

## Coding inside MicroSandbox

Configure the [sandbox runtime](/marbles/foundation/workspaces-and-sandboxes#sandboxes)
before running this example. It edits the mounted project and requires a
working `bun test` command. Review the permission profile for your project.


A sandbox session prepares the Linux CLI before its first turn. MicroSandbox
consumes the base image directly. Claude Code uses the host subscription login;
only the current access token enters the guest process. Host login directories
and refresh credentials remain on the host. An explicit `oauthToken` from
`claude setup-token` can select a different subscription credential.

```ts
import { agent, step } from "@foundry/marbles";

const coder = agent({
  provider: "claude-code",
  model: "sonnet",
  prompt: "Make focused fixes in /workspace and verify them with bun test.",
});

step("fix-fixture").do(async ({ agents, sandboxes }) => {
  const box = await sandboxes.start({
    image: "docker.io/oven/bun:1-slim",
    executable: true,
    network: {
      mode: "allowlist",
      destinations: [{ host: "api.anthropic.com", ports: [443] }],
    },
  });
  const session = await agents.session(coder, {
    sandbox: box,
    profile: {
      mode: "scheduled",
      allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash(bun test:*)"],
      disallowedTools: [],
      unresolved: "deny",
      maxSteps: 20,
    },
  });
  return (await session.generate("Fix the failing test without changing the test.")).text;
});
```

Network access defaults to disabled, and executable workspace mounts are opt-in.
Native session history currently resumes only while the same guest remains
alive; reopening against a replacement guest fails explicitly. Scheduled
approval requests are recorded and denied for that invocation.

For interactive work in the dashboard, use `mode: "attended"` and
`unresolved: "ask"`. Tool approvals appear in the Feed. Choose approval for
one invocation, a grant for the current session, or denial with an optional
reason. The run and step show "Waiting for approval" while the same agent
turn remains alive. Pause, steer and cancel remain available.

Model questions appear in the same Feed with "Waiting for answer" on the run.
Claude's native `AskUserQuestion` and the shared `ask_user` tool return the
person's actual answers. Codex uses `ask_user` in ordinary coding mode; its
native app-server question requests use the same callback. A declined question
is never treated as a permission grant or an invented answer. Multiple-choice
questions accept a listed choice or a custom answer; multiple selections use
semicolon-separated text.

Sessions using a scheduled permission profile never wait for someone. Refused permission requests appear as
"Future permission" entries. Approving one persists a tool grant for that agent
in the workspace, so a later run can proceed; it does not replay the refused
action. Deferred entries and grants survive a host restart. Live unanswered
requests are cancelled when their turn stops. Model questions in unattended
runs produce a feed notice and return an explicit decline.

Grants and the triggers an agent creates are filed under the agent's id, so
the id must stay the same when the module around it changes. It is
`agent({ name })` when given, else the top-level `const` the call is assigned
to, else `agent-` and a digest of its prompt, provider, and model. Two
different agents with one id fail at import; rename one or name it. A
trigger also belongs to the session that created it: `list_automations`
shows only the calling session's own.

The CLI/dashboard bind this automatically. An embedding host gets the same
from the `Engine`, which builds the interactions over the artifact system and
session store it is handed; `askable` says whether someone can answer. A host
can override `authority` or `question` on a session.
Custom callbacks must remain abortable and must not call the workflow `ask`
suspension API. Custom authority stores retain responsibility for their own
restart recovery; the default runtime persists its grants locally.

Embedding hosts register network providers on the `ModelManager` they hand the
engine.
These use the built-in coding loop with scoped guest tools, a step limit, and
compaction. The existing OpenAI-compatible gateway provider also supports
OpenRouter configuration. Legacy sessions without `sandbox` retain their prior
execution path; new profiles and credential options require a sandbox.

## Child agents and automation

Sandbox sessions expose a `delegate` tool that opens a child session with the
same harness, model, MicroSandbox, and permission profile. It waits for the
child's result. Each open parent session permits eight launches, two active
children across its delegation tree, and at most three nested levels. Child
questions and approvals remain live feed requests. Cancelling the parent
cancels its children; selecting a child and pressing `k` stops only that child
when its adapter advertises the control.

The run tree also shows native Claude and Codex subagents and background
activity. Native activity is separate from workflow steps. Its details show
its harness, owning session, state, lifetime, and a redacted summary. Missing
contact displays `unknown`, never an inferred successful completion. Activity
history is recorded in agent sessions; workspace projections retain dashboard
visibility after restart. Reopened projections have no live controls until a
host attaches the corresponding session.

Codex keeps one app-server connection per session and observes subscribed
children between parent turns. A child with a known active native turn can be
stopped without interrupting its parent. Claude exposes task stopping while its
query is active, plus observed Monitor and Cron activity. Its current provider transport
closes after the parent result, so detached Claude activity is not continuously
observed. Claude native `AskUserQuestion` carries child attribution. The
provider's generic MCP bridge does not expose enough correlation to attribute
an arbitrary native child's shared `ask_user` call reliably.

Every sandbox harness receives these authorized host tools:

- `list_automation_targets` lists registered workflows and input schemas.
- `create_automation` accepts a session-local idempotency `key`, `workflow`,
  `input`, and `at`, such as `"1h"` or `{ "hour": 9, "minute": 30 }`.
- Adding `source: { "kind": "files", "glob": "src/**/*.ts" }` or
  `{ "kind": "http", "url": "https://example.com/status" }` creates a change
  monitor at that cadence.
- `list_automations`, `set_automation_enabled`, and `delete_automation` manage
  the calling agent session's records. Delegated children own their own records.

Repeating a creation key returns its existing record. After deletion, reusing
that key creates a fresh automation ID and execution history. An older firing
can finish independently without delivering its pending work to the new trigger.

The usual tool approval policy governs these operations. Marbles stores durable
trigger definitions under workspace state and executes them through its existing
schedule loop. Calendar times use the host's local timezone. Creation time
anchors the first firing across restarts. Resuming an overdue trigger fires it
once, without queueing missed intervals. File globs stay relative to the
configured workspace. HTTP monitors may use origins already
selected by configured HTTP monitors. Redirects are refused. Invalid recovered records remain disabled and display diagnostics.

Managed triggers show their owner and durable lifetime. Select one and press
`p` to pause/resume or `k` to delete it. These actions affect future firings;
an already running workflow retains its own controls. Native CLI schedules
remain owned by that CLI and are not silently copied into Marbles. Monitor
startup failures retain pending delivery for retry; a crash between launch and
acknowledgement can redeliver, so target workflows should tolerate duplicates.

Schedules and monitors execute while the Marbles loop is running. Their
state survives a restart.

Host sessions accept `cwd`; sandbox sessions select their workspace through
mounts and accept permission profiles, question handlers, and credentials.
These option sets are distinct in TypeScript. Network-model sessions accept
`compaction: true` or custom settings, and `false` disables compaction.
Compaction defaults off on the host and on for the built-in sandbox coding
harness. Native CLI sessions manage their own compaction and reject host
compaction settings. Both `generate` and `stream` follow steering prompts;
a steered stream emits one final finish event, and its final promises describe
the last turn.
