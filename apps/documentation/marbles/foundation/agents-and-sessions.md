---
title: Agents and sessions
description: Add model work to a step, understand its bindings, and keep a conversation when needed.
---

An agent supplies instructions for model work. A session is a conversation
with that agent. A turn is one request and reply within the conversation.

The workflow still decides when the step runs and what happens to its result.
The agent supplies judgment inside that step, just as a command supplies a
calculation or test result.

## Open a session in a step

This complete module asks for one review. It requires an installed and
authenticated Claude Code or Codex CLI; see [agent setup](/marbles/get-started/installation#add-optional-capabilities-when-needed).

```ts
import { agent, step } from "@foundry.sh/marbles";

const reviewer = agent({
  name: "readme-reviewer",
  prompt:
    "Review README.md for clarity. Report findings without editing files.",
});

step("review-readme").do(async ({ agents }) => {
  const session = await agents.session(reviewer);
  const reply = await session.generate(
    "Which instructions need clarification?"
  );
  return reply.text;
});
```

`agent(...)` declares instructions. `agents.session(...)` opens the
conversation. `session.generate(...)` performs a turn, and the step returns
its text as the result. Run it with `marbles roll review-readme`.

[Agents](https://github.com/Francois-Esquire/foundry/blob/main/packages/agents/README.md)
provides the session and harness contracts.
[Models](https://github.com/Francois-Esquire/foundry/blob/main/packages/models/README.md)
resolves the provider and model that perform the turn.

## How the session joins the workflow

The [execution context](/marbles/foundation/contexts) binds this session to
its step. Its turns inherit the step's working directory, write to its output
stream, and stop when the step is cancelled or paused. Inside a Git worktree
callback, a newly opened session uses that checkout. Pass `{ cwd }` only
when the host session should use another directory.

That binding is the connection between agent execution and the surrounding
workflow. The session handles conversation; the step handles its input,
result, progress, and execution policy. Return the findings so another step
can use them instead of asking the model to infer which stage comes next.

A prompt asking the agent not to edit is an instruction, not a filesystem
permission. See [safety and limits](/marbles/reference/safety) for host and
sandbox authority.

## Write one prompt for several harnesses

Set the agent's `prompt` to a `prompts.portable` template. After resolving the
session's model and provider, Marbles renders the template for the harness
that will run it.

```ts
import { agent, prompts, ref } from "@foundry.sh/marbles";

const reviewer = agent({
  prompt: prompts.portable`Use ${ref.skill("inspect")} to review ${ref.file("AGENTS.md")}.`,
});

const claudeReviewer = reviewer.extend({ model: "claude-code/sonnet" });
const codexReviewer = reviewer.extend({ provider: "codex" });
```

Claude Code sees `/inspect` and Codex sees `$inspect`. Marbles renders the
interpolated references and keeps the authored text as written. A provider
without a prompt dialect receives the names and paths as plain text.
The same template works as the prompt returned by a deferred agent.

## Session lifetime and provider

A fresh `agents.session(reviewer)` opens a fresh conversation during normal
execution. Use the same returned session for follow-up turns. A session
runs one turn at a time, so await one reply before sending the next request.

For a single turn, an agent instance also has `generate` and `stream`
methods. Inside a step, `await reviewer.generate("Review README.md.")` opens
its own fresh session and uses the same run bindings. Use an explicit session
when you want several turns to share a conversation.

`provider` names one of the configured providers, and `model` names a model
in a provider's catalog. A model named alone goes to the first configured
provider that lists it. A name that no catalog lists fails rather than
reaching a provider. `"codex/gpt-5.6-sol"` is an example that names both.
A workspace has Claude Code and Codex; Pi, Vercel AI Gateway and an
OpenAI-compatible gateway are available only to a workspace whose source
defines them with [`defineProvider`](/marbles/reference/api#providers).
Providers are configured once per machine, and per workspace where needed,
in the Marbles database under the state root. The first interactive run
offers Claude Code and Codex when it finds them on `PATH`. Dry runs keep provider edits in
memory. A session stays on the provider, model, and configured instance
it started with. It fails rather than
resume after the entry moves to another scope or changes its settings or
the environment that chooses its account, or when another entry with the
same id takes its place. Authentication belongs to the providers' own CLIs. A
sandbox guest uses the login the instance's own CLI reads on the host: Codex
reads `auth.json` under the instance's `CODEX_HOME` (else `~/.codex`);
Claude Code reads `CLAUDE_CODE_OAUTH_TOKEN` from the instance's environment,
else the login for its `CLAUDE_CONFIG_DIR` (else `~/.claude`); Pi runs the
configured `pi auth`.

Marbles loads Claude Code, Codex, and, in a workspace that defines it,
Vercel AI Gateway catalogs at engine startup and when provider configuration refreshes. Claude Code and Codex
list models with the configured CLI and account environment. Vercel uses
the configured base URL and credential. A configured default must appear
in the list. Without one, Claude Code uses its offered `default` alias,
and Codex uses its reported default when present. Otherwise Marbles uses
the first listed model of the requested kind. An empty list leaves no
routes for that provider. If a refresh fails, Marbles keeps any last
successful list for the same configuration and environment.

Claude Code lists models without sending a prompt. Its catalog includes
offered aliases and the canonical IDs reported by the SDK. The SDK's
listing leaves context limits and prices unspecified.

Use `codex/sol` to select the newest stable Sol version in the configured
Codex listing. Version components compare numerically, so `6.10` comes
after `6.2`. Qualified variants such as `-fast` and `-preview` keep their
exact IDs. Codex adds a family name only when it can select a unique
highest version and the name is free. Claude Code resolves
`claude-code/sonnet` through its own offered alias.

A refresh affects new resolutions. An open Codex session keeps the model
it already resolved. When a saved session is reopened or a replay opens
it again, a recorded family name resolves against the current catalog.
Use an exact model ID if a session must keep the same version across
reopens.

## Choose the route when the step runs

`reviewer.extend({ model?, provider?, settings? })` returns the same agent
on another route or with other settings. It keeps the agent's ID, prompt,
and skills, so grants approved for future runs and triggers the agent
created still apply. `settings` merge over the agent's own: nested plain
objects such as `providerOptions` merge, and any value `extend` sets
replaces the one before. Arrays and `output` are replaced whole. An
extended agent can be extended again.

[Usage](/marbles/foundation/usage) shows a step that picks the route from
what each Claude Code and Codex login has left.

### Check model availability

Import `models` from `@foundry.sh/marbles` to check the current engine's
catalog before choosing a model.

```ts
import { agent, models, step } from "@foundry.sh/marbles";

const reviewer = agent({ prompt: "Review README.md for clarity." });

step("review").do(async () => {
  const preferred = "codex/gpt-5.6-sol";
  const selected = models.available(preferred)
    ? reviewer.extend({ model: preferred })
    : reviewer;
  return (await selected.generate("What should change?")).text;
});
```

`models.available(selection)` returns a boolean synchronously. It accepts
bare model IDs, provider-qualified IDs, and explicit `{ provider, model }`
selections. It returns `true` when the selection resolves for any model kind
using the configured catalog, current provider availability, and policy
such as Airplane Mode. If a string is ambiguous for a kind, use the
explicit object form to choose its meaning.

Use the check during a step or inside a deferred `agent(() => …)`
configuration. It returns `false` if no engine is bound before the source
has finished loading. The check uses local state only and leaves model
opening and inference to the session. Account access can still fail when
you use the model.

## Define the agent with a function

`agent(async (route, input) => definition)` declares an agent whose
definition is built when each session opens. The function returns what `agent({ ... })`
takes, except `name`: `prompt`, `model`, `provider`, `settings`, `skills`,
and `mcp`. The result is an ordinary agent. `generate`, `stream`,
`agents.session`, and `extend` work as they do on any other agent.

- **When it runs.** Never when the module loads, and never on `extend`.
  It runs once for every session that opens: once per `generate` or
  `stream` call, and once per `agents.session(agent)`. The turns of one
  session share the definition it opened with. A one-turn reply that a
  replayed step reuses does not run it again.
- **The route it is given.** `route` holds the `model` and `provider` the
  session has to keep. `extend` sets them, an MCP agent dispatch that names a route
  sets them, and a step that replays a recorded session sets `provider` to
  the one that session was opened on. A field the function leaves out is
  filled in from `route`. A field it sets to a different value fails the
  opening, so a session never runs with skills or servers chosen for a
  different route. Continuing a conversation with `{ session: ref }` does
  not set the route: if the function picks another provider than the one
  the conversation was opened on, a new session starts, with a warning, as
  it does for any agent.
- **The input it is given.** `extend({ input })` sets a value the function
  receives as its second parameter, so one agent can vary its prompt or
  skills per call. Without one, `input` is `undefined`. It is not the
  prompt of a turn, which `generate` and `stream` take. The input must be
  JSON, and `null` is an input too. `extend` keeps a frozen copy of it, and
  a later `extend` with an `input` replaces it. The session keeps it, or
  that it had none: a replayed step, and `{ session: ref }` with that ref,
  give the function the same input again, and an agent with a different
  input fails the opening. A definition object that continues the session
  keeps that input in its ref too. A ref with only an `id` keeps no input,
  and one with both `input` and `noInput` fails. An MCP agent dispatch
  cannot set an input, but one that continues a session gives the function
  the input that session kept.
- **What `extend` changes.** Each `extend` adds to the route the function
  is given, and its `settings` merge over the settings the function
  returns, in order, as they merge for a plain agent.
- **Its id.** Like any agent, it is named after the `const` it is assigned
  to. Without one, the id is a digest of the function's source. The id is
  fixed when `agent()` is called, so the function cannot rename it. An id
  belongs to one function: a second function claiming it is an error, even
  with the same source, because the values a function closes over are not
  part of its id. A helper that makes one agent per call therefore declares
  only one; declare each such agent as its own top-level `const`.
- **Failures.** When the function throws or returns no prompt, the call
  that opened the session rejects with that error, and no session is
  recorded. Marbles does not retry it or fall back to another route.
  Catch errors inside the function if you want a fallback. A step
  cancelled while the function runs opens no session.

Until a session opens, the agent's data holds only its id and the route
`extend` set; `prompt` is absent. Its type is `DeferredAgent`, which
`agents.session` accepts but code expecting a complete `AgentDefinition`
does not. An agent declared with an object is still an `AgentDefinition`,
before and after `extend`.

### MCP servers

`mcp` lists MCP servers whose tools the agent's sessions get, named
`<id>__<tool>`:

```ts
const reviewer = agent({
  prompt: "Review the change.",
  mcp: [
    {
      id: "issues",
      transport: { kind: "stdio", command: "issues-mcp", args: ["--read-only"] },
    },
  ],
});
```

Each session connects to the servers when it opens and closes them when the
session closes. If a server cannot be reached, the session does not open.
Only host sessions support MCP servers for now: a sandbox session with
servers listed is refused. A dry run does not start them.

## Continue the conversation across runs

A session object is useful inside one body. Its small, serializable
`session.ref` identifies the conversation for another step or a later run.
This separate module accepts an optional reference and returns the one it used.
Install `zod@4.4.3` in the automation project for its input schema.

```ts
import { agent, step } from "@foundry.sh/marbles";
import { z } from "zod";

const reviewer = agent({
  prompt:
    "Review this repository without editing. Compare with earlier findings.",
});

const sessionRef = z.object({
  id: z.string(),
  implementation: z.string().optional(),
  instance: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
});

step("review-project")
  .input(z.object({ request: z.string(), session: sessionRef.optional() }))
  .do(async ({ input, agents }) => {
    const session = await agents.session(
      reviewer,
      input.session ? { session: input.session } : {}
    );
    const reply = await session.generate(input.request);
    return { text: reply.text, session: session.ref };
  });
```

```sh
marbles roll review-project --input '{"request":"Review the repository and remember unresolved findings."}'
marbles roll review-project --input '{"request":"Compare this revision with your earlier findings.","session":<session from the first result>}'
marbles sessions
```

Copy the whole returned session reference into the second command: its
`id`, `provider`, `model`, `implementation`, and `instance`. The `instance`
field pins the conversation to the configured instance that opened it, so a
reference without it, or one moved to another provider or instance, fails
with `SESSION_ROUTE_UNRECOVERABLE` or `SESSION_ROUTE_CONFLICT` rather than
continuing. `marbles sessions` lists saved conversations with their message
counts.

Continuing a conversation does not resume the earlier workflow run. This is
a new run using retained messages. The [factory reviewer](/marbles/use-cases/software-factory/development/verify#keep-review-history)
saves a reference per issue so later revisions continue its review history.

## Structured output

Pass an AI SDK `Output` to a turn and the reply carries the parsed value:

```ts
import { agent, Output, step } from "@foundry.sh/marbles";
import { z } from "zod";

const triage = agent({ prompt: "Triage issues for this repository." });
const verdict = Output.object({
  schema: z.object({
    labels: z.array(z.string()),
    severity: z.enum(["low", "medium", "high"]),
  }),
});

step("triage")
  .input(z.object({ issue: z.string() }))
  .do(async ({ input, agents }) => {
    const session = await agents.session(triage);
    const { output } = await session.generate(input.issue, { output: verdict });
    return output; // { labels: string[]; severity: "low" | "medium" | "high" }
  });
```

Claude Code and Codex receive the schema, and Marbles validates their reply.
A mismatch rejects with `NoObjectGeneratedError`; the reply still remains in
the transcript. A valid parsed value is stored with the reply.

`Output.array`, `Output.choice`, and `Output.json` work the same way.
`@foundry.sh/marbles` re-exports `Output` from the AI SDK. For streaming, turn
settings, and compaction, see [Agent sessions](/marbles/reference/agent-sessions).

## Skills and sandbox sessions

Skills supply reusable instructions and files to an agent. `skills.load()`
collects them from `.agents/skills`, `.claude/skills`, and `skills/` in the
project, and from the same three folders in the home directory, with
`.foundry/skills` in place of `skills/`. A project skill wins over a home
skill with the same name. `.add(glob)` adds directories, such as
`.add(".claude/skills/*")`, and `.pick(...names)` narrows the set. Pass that
set as the agent's `skills`.

Host sessions work in a local directory. `agents.session(def, { sandbox: box })`
opens the conversation in the sandbox introduced on the previous page;
its mounts determine the working directory, so do not also supply `cwd`.

The [session reference](/marbles/reference/agent-sessions) covers permission
profiles, compaction, child agents, and additional session settings. The
[prebuilt steps](/marbles/reference/project#prebuilt-steps) provide reviewers
with those sessions already wired.

A conversation records messages; a completed step records the result used
by its workflow. [Durability](/marbles/foundation/durability) later explains
how replay and retry affect both, including when a turn can execute again.

Next: [Artifacts and results](/marbles/foundation/artifacts-and-results)
explains how to pass findings to another step or keep them as a versioned report.
