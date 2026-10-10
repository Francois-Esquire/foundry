# Marbles: findings from guides and recipes

Maintainer note, excluded from the Blume site. Writing a guide or recipe
against the real library is how we learn where the API runs out. Each
finding records the page that found it, what the page does instead today,
and a proposal. When a finding lands, update the page that worked around it
and delete the entry here. Where a proposal here and
[`_api-alt.md`](./_api-alt.md) disagree, settle it in `_api-alt.md`, which
wins.

The technical design that turns these into changes, with files, types,
tests, and an order, is [`_next-api.md`](./_next-api.md). Where it corrects
an entry below, it says so; it wins until the entry is updated.

Each entry has the same parts: **Found by**, **Today**, **The page does
instead**, **Proposal**, and **Open**. A finding that came from use rather
than a page says what changed or what the rule is in place of **The page
does instead**.

## 1. Request options for HTTP monitors

**Found by** the Design Sync recipe, 2026-10-09.

**Today.** `monitor(source)` takes one string, and each poll calls
`fetch(spec.url, { signal })` (`apps/marbles/src/lib/monitor.ts:308`). No
header can be set, so no source that needs a token can be a monitor: Figma
(`X-Figma-Token`), GitHub (`Authorization: Bearer`), Linear, most internal
APIs. GraphQL sources also need `POST` and a body.

**The page does instead.** A scheduled step makes the request itself and
compares Figma's `version` with a snapshot committed to the repository. The
shape the recipe wanted is a monitor that gates and a handler that starts
the workflow:

```ts
monitor(`https://api.figma.com/v1/files/${file}/meta`)
  .request(() => ({ headers: { "X-Figma-Token": process.env.FIGMA_TOKEN ?? "" } }))
  .every("1h")
  .do(() => designSync({}, { file }));
```

**Proposal.** A builder method, `.request(init)`, before `.do`, for HTTP
sources only. `init` is a `RequestInit` without `signal`, or a function that
returns one (sync or async), called at every poll. A function lets a token be
read when it is used rather than at module load, which matters for
rotation, Keychain reads, and launchd ticks (finding 2).

- The key stays derived from the URL alone. Request options never enter the
  key, the observation state, logs, `list`, the feed, or a launchd plist.
- A `401` or `403` fails the tick with the status and the URL, never the
  header values.
- `--dry-run` still sends the request, as HTTP monitors do today.
- A glob source given `.request` is an error when the module loads.

Rejected: a second argument, `monitor(url, { headers })`. It breaks "takes
one string" and invites values evaluated once at load. A `.headers()`-only
method covers Figma but not GraphQL.

Also found by the pass-through audit (finding 7): a non-2xx response throws
and is swallowed as a failed poll, so a change to `404` or `500` is never
seen and `change.status` is always 2xx (`monitor.ts:309-311`, `229-231`);
the body is read with `.text()`, which mangles binary; and the rebuilt
`Response` loses `statusText`, `url`, and `redirected` (`monitor.ts:332-335`).
`.request` should land with those fixed.

**Open.**

- What the monitor hashes. Today it hashes the whole body. An authenticated
  API often returns fields that change on every request (signed asset URLs,
  timestamps); verify whether Figma's `/meta` `thumbnail_url` is one. If
  recipes keep returning early on noise, reconsider a way to choose what is
  hashed, which `_api-alt.md` currently rules out ("no `select`").
- Whether `change.previous` and `change.current` keep the full body, which
  can be large, or only the hash.

## 2. Environment for launchd ticks

**Found by** the Design Sync recipe, 2026-10-09.

**Today.** The plist's `EnvironmentVariables` holds only `PATH`
(`apps/marbles/src/launchd.ts:102`), and Marbles loads no environment files.
`roll` and the dashboard inherit the shell's environment, so the same module
sees `FIGMA_TOKEN` in a terminal and not under launchd. The difference is
silent until the tick fails.

**The page does instead.** It tells the reader to run the schedule from the
dashboard, or to read the token from the Keychain inside its fetch helper.

**Proposal.** Marbles loads the workspace's environment itself when a
process starts, in every mode, before it imports modules. Use Varlock, which
this repository already standardizes on: a `.env.schema` at the workspace
root declares what the automations need and where each value resolves from.
`roll`, the dashboard, and a launchd tick then see the same environment, and
a secret is resolved at tick time instead of being stored anywhere.

- `launchd install` validates that the schema resolves and refuses to
  install when a required value is missing, naming it.
- `status` reports a schedule whose last tick failed on a missing value.
- Without a schema, behaviour is unchanged.

Rejected: `launchd install <key> --env NAME` copying the value into the
plist. It writes the secret in plain text under `~/Library/LaunchAgents`.

**Open.** Whether a module can declare what it needs (an `env` word, or a
schema export) so `list` can show it, or whether the workspace schema is
enough.

## 3. Invalid input prints a stack trace

**Found by** the Design Sync recipe, 2026-10-09.

**Today.** `marbles roll design-sync` without `--input` throws a
`SchemaError` inside an Effect `FiberFailure`, and the CLI prints the whole
stack.

**The page does instead.** Nothing; the page rolls the schedule key, which
carries the input.

**Proposal.** The CLI maps known failures to one line and a usage exit
code: `design-sync needs input: file (string). Pass --input '{"file":"…"}', or
roll a schedule key that carries it: design-sync-b60490e1.` The same fix
covers the `roll` cancelled-at-an-ask trace recorded in
[`_rebuild-gaps.md`](./_rebuild-gaps.md).

## 4. Git queries on the workspace handle

**Found by** the Design Sync recipe, 2026-10-09.

**Today.** `workspaces.current.git` has `status`, `worktrees`, `worktree`,
and `withWorktree`. `withWorktree({ branch })` runs `git worktree add -b`,
which fails with Git's own error when the branch exists.

**The page does instead.** It shells out to `git rev-parse --verify` through
`node:child_process` to skip a palette whose branch already exists, which
bypasses the handle's dry-run echo and cwd plumbing. Committing, pushing,
and opening the pull request are left to the agent.

**Proposal.** Add read-only queries to the handle, starting with
`hasBranch(name)`. Give `withWorktree` a clear error when the branch exists.
Keep writes (commit, push, pull requests) with the agent until a page needs
them deterministic.

**Open.** Whether `withWorktree` should take an existing branch instead of
always creating one.

## 5. Memory an automation keeps between runs

**Found by** the Persistent Reviewer and Design Sync recipes.

**Today.** Nothing in the context reads back what an earlier run kept.
Artifacts can be written but not read, and session references must be
passed back by hand.

**The page does instead.** The persistent reviewer writes its session
reference to `.marbles/<name>.json` in the workspace. Design Sync commits
its last palette to the repository and reads it back. Both are the step's
own file I/O, so both happen under `--dry-run` too.

**Proposal.** A read for the latest version of a declared artifact,
`artifacts.latest(def)`, which covers both: the reviewer keeps its reference
in an artifact, Design Sync keeps its last proposed palette. Dry runs read
it and do not write.

**Open.** Whether the latest version is per workspace or global to the
artifact store, and whether a session reference belongs in an artifact at
all or in a smaller keyed store.

## 6. Command steps: `step(name).exec(template)`

**Found by** an API proposal, 2026-10-09. The nearest pages are the Software
Factory, whose `test` step starts a sandbox to run one command, and Design
Sync, which shells out to `git rev-parse` from a body.

**Today.** A step's work is always a `.do(fn)` body. Running one command
means a body that starts a sandbox or calls `node:child_process`, then
shapes the result by hand.

**Proposal.** `.exec(template)` as a terminal call beside `.do`. The input
schema names the values; `$name` placeholders in the template take them:

```ts
step("install")
  .input(z.object({ pkg: z.string() }))
  .exec("npm i $pkg");
```

```sh
marbles roll install --input '{"pkg":"zod"}'
```

The template is a plain string with `$name`, not `${name}`: a template
literal would be evaluated when the module loads, before any input exists.

- **No shell.** The template is split into arguments when the module loads,
  honouring quotes. Each placeholder fills exactly one argument and is never
  split again or read by a shell, so `{"pkg":"zod; rm -rf ~"}` is one odd
  package name, not a second command. An array value fills one argument per
  element: `.input(z.object({ pkgs: z.array(z.string()) })).exec("npm i $pkgs")`.
  A pipe or redirect has to be written as an explicit `sh -c '…'`.
- **Checked when the module loads.** Every placeholder must name a key of
  the input schema, and the program, the first word, must be literal.
- **Wired like everything else.** The command runs in the step's working
  directory, writes to the step's stream, and is killed by its `signal`.
  `--dry-run` echoes it and returns exit 0 with empty output, as sandbox
  commands do. `{ sandbox: box }` runs it in a sandbox instead.
- **A typed result.** The output is `{ exitCode, stdout, stderr }`. A
  non-zero exit fails the step; `{ check: false }` returns the exit code
  instead, which is what the factory's `test` wants:
  `step().exec("bun test", { sandbox: box, check: false })`.
- **A function for computed arguments.** `.exec(({ input }) => ["npm", "i", ...input.pkgs])`
  returns argv directly when a template is not enough.

**Open.**

- Builder order. The first sketch was `step(name).exec(template).input(schema)`.
  Today `.do` is terminal and `.input` comes before it; `.exec` should
  probably follow the same rule, so the schema is known when the
  placeholders are checked.
- Whether a step built with `.exec` can take children, and whether their
  results can fill placeholders by key, as they fill a body's `input`.
- A context-level `exec` for bodies, under the same rules, so Design Sync's
  `git rev-parse` stops bypassing dry runs and cwd plumbing.

## 7. Pass-through to the packages underneath

**Found by** using Marbles for real, 2026-10-09: structured output from an
agent turn was not possible, and the investigation that followed.

**The rule.** Marbles fills in what it owns: the working directory,
cancellation, the step's stream, dry-run echo, replay, and run identity.
Everything else passes through to the package underneath. A default is an
argument filled in, not an option removed. Concretely, each wrapper takes
the underlying options type minus the keys Marbles owns, and returns the
underlying result plus Marbles' own fields. Today most wrappers do the
opposite: they declare a small shape of their own and copy a few fields
across.

Structured output comes first; the other sections are the same problem in
the other context keys. Paths are relative to the repository root.

### 7.1 Agents: structured output and model settings

The AI SDK (v7) has structured output on both calls, and both CLI providers
honour it: `ai-sdk-provider-claude-code` maps a JSON-schema `responseFormat`
to Claude Code's `structured_output`, and `ai-sdk-provider-codex-cli` to an
output schema. Four layers of ours stop it before it gets there:

1. **`LoopAgent`** extends `ToolLoopAgent<never, ToolSet>`
   (`packages/agents/src/agents/loop-agent.ts:134`). `ToolLoopAgent`'s fourth
   type parameter, `OUTPUT`, defaults to `never`, so `output` can only be
   `undefined`, and every result is typed
   `StreamTextResult<ToolSet, Record<string, unknown>, never>`. A call may
   override only `providerOptions` (`loop-agent.ts:34-43`).
2. **`SessionHarness.stream`** accepts `SessionStreamOptions = { signal } &
   StreamHandlers` (`packages/agents/src/harness/session-harness.ts:70`) and
   reaches the model with `abortSignal`, `messages`, and `providerOptions`
   only (`session-harness.ts:164-170`). No `output`, `temperature`,
   `maxOutputTokens`, `stopWhen`, `toolChoice`, or `activeTools` per turn.
3. **Marbles' `AgentDefinition`** is `prompt`, `model`, `provider`, `skills`
   (`apps/marbles/src/lib/types.ts:38-47`). `@foundry/agents` takes
   `AgentSpec.settings` (most of `ToolLoopAgentSettings`), `tools`, and `mcp`,
   but `openLocalSession` builds the spec from four fields
   (`apps/marbles/src/lib/managers/agents.ts:370-376`), and
   `models.model(…)` gets only `workingDirectory` (`agents.ts:367-369`).
4. **`session.generate`** returns the committed message plus `text`
   (`apps/marbles/src/lib/managers/agent-turns.ts:137-140`). The AI SDK
   result is gone: `output`, `steps`, tool calls and results, `finishReason`,
   `response`, and provider metadata. `stream` keeps `usage` and the events
   but not `partialOutputStream`.

In a sandbox, the Claude Code driver sends the prompt text alone and sets
`sdkOptions: undefined` so no overlay can replace the run's authority
(`packages/models/src/harness/claude-code.ts:113-137`); the Codex driver's
`turn/start` sends no output schema (`packages/models/src/harness/codex.ts:299`).

**Proposal.**

```ts
import { Output } from "ai";

const verdict = z.object({ passed: z.boolean(), findings: z.array(z.string()) });

const session = await agents.session(reviewer);
const { output } = await session.generate("Review the branch.", {
  output: Output.object({ schema: verdict }),
});
```

- `LoopAgent`, `SessionHarness`, and the Marbles `Session` become generic
  over `OUTPUT`. Per-turn options are the AI SDK's call settings minus what
  Marbles owns (`abortSignal`, `messages`), including `output`,
  `temperature`, `maxOutputTokens`, `stopWhen`, `toolChoice`,
  `activeTools`, and `providerOptions`.
- `generate` returns the AI SDK result with the committed message and `text`
  added; `stream` adds `partialOutputStream` and the result's promises.
- `agent({ … })` takes `settings` and passes them to `AgentSpec.settings`,
  so an agent can carry a default `output`, temperature, or step limit.
- The sandbox drivers translate `output` into the CLI's own form (Claude
  Code's JSON-schema output format, Codex's turn output schema) without
  opening `sdkOptions` to arbitrary overlays.

**Open.** What a dry run returns for a turn with `output`: the echo model
has no object to give. Whether the structured value is stored on the
session message so a replay returns it. Whether `tools` and `mcp` on
`agent()` land here or with the `AgentSpec` fields `_api-alt.md` already
lists as unwired.

### 7.2 Sandboxes

`sandboxes.start` returns `{ exec(argv), close, id }`
(`apps/marbles/src/lib/types.ts:181-185`) over a `Container` that has much
more (`packages/sandbox/src/container/facets.ts:42-50`).

- **Facets hidden.** `files`, `processes` (spawn with stdin and streams),
  `shell`, `ports`, `services`, `volumes` are unreachable
  (`apps/marbles/src/lib/managers/sandboxes.ts:107-125`).
- **Exec options dropped.** No options argument: `cwd`, `environment`, and
  `user` are lost, and the string (shell) command form is refused. Output is
  not written to the step's stream either, which is a default Marbles owns
  and does not fill.
- **Spec narrowed.** `labels`, `ports`, `publicEnvironment`, `detached`, and
  `resources.pids` are dropped (`sandboxes.ts:72-104`). One mount, always
  read-write at `/workspace` with id `workspace`, and `workdir` fixed there
  (`sandboxes.ts:88-102`). Files are strings only and cannot be combined with
  a mount (`types.ts:62-83`).
- **Registry missing.** `list`, `remove`, `restart`, `sweep`.
- Marbles' `Sandbox` reuses the package's type name for a smaller shape.

**Proposal.** Return the container with Marbles' defaults applied (signal,
stream, dry-run echo), take the package's exec options, and take the
package's spec with `/workspace` and the mount source as defaults rather
than constants. The allowed mount roots stay: they are a boundary, not a
narrowing.

### 7.3 Workspaces

`git` is passed through whole by a proxy; the workspace itself is not.

- `files()` returns paths and drops kind, extension, and metadata
  (`apps/marbles/src/lib/managers/workspaces.ts:97-100`).
- `read`, `save`, `createFile`, `entries`, `refresh`, `summary`, `scan`,
  `id`, and `source` are hidden (`workspaces.ts:90-112`), and the workspace
  system's `on("change")`, `list`, `open`, and `close` are unreachable from a
  step (`workspaces.ts:163-165`).
- **Bug.** Only `withWorktree` gets the worktree home and the cwd narrowing
  (`workspaces.ts:64-82`). `git.worktree()` falls back to the system
  temporary directory, which a sandbox may not mount, and worktrees returned
  by `worktree()` or `worktrees()` lose both defaults.

**Proposal.** Return the package's `Workspace` with `git` decorated, and
apply the worktree defaults to every path that creates one.

### 7.4 Artifacts

The context has `create` and `write` only; the manager underneath is held
as `Pick<ArtifactOperations, "create" | "get" | "revise">`
(`apps/marbles/src/lib/managers/artifacts.ts:26`).

- **No reads.** `get`, `list`, versions, `readFile`, `readRoot`: nothing
  written can be read back. This is finding 5's root cause.
- **Results stripped.** `ArtifactVersion` is `{ artifactId, contentId, id }`
  (`types.ts:194-199`): digest, state, tag, metadata, and timestamps are
  dropped.
- **Inputs narrowed.** Files are `string | Uint8Array` (no streaming
  source, blob reuse, or explicit MIME); `write` always replaces the whole
  tree (`artifacts.ts:112`); `create` drops `metadata` and `freeze`;
  `tag`, `freeze`, `fork`, `archive`, and transactions are unreachable.
- **No provenance.** Content metadata has `runId` and `sessionId`; neither
  is set, though the run id is at hand.
- **Bug.** The scoped `create` is not counted for replay (`artifacts.ts:122`)
  while `write` is, so a replayed body creates a second artifact.

**Proposal.** Pass the manager's operations through with the workspace
identity and replay applied, and record run and session provenance by
default.

### 7.5 Steps and workflows

`@foundry/workflows` has per-step configuration, `bail`, hooks, pause and
skip, and a context with `race`, `branch`, `emit`, and structured log
fields. Marbles reaches none of it.

- `Step.create` is called without `config`
  (`apps/marbles/src/lib/tree.ts:201-208`), so `retry`, `timeout`,
  `maxAttempts`, and `blocking` are unreachable, and the builder has no slot
  for them (`apps/marbles/src/authoring/builder.ts`).
- `bail` is not exported, and a returned bail fails any step with an output
  schema, because the output is validated before the package checks for a
  bail (`tree.ts:176-178`).
- Hooks, `skip`, and an author-side `waitIfPaused` are unwired.
- `log` drops structured `fields` and flattens to a string
  (`apps/marbles/src/lib/context.ts:224`).

**Proposal.** A `.config({ retry, timeout, maxAttempts })` builder call that
passes to `Step.create`; export `bail` and check for it before output
validation; pass log fields through. Race and branch stay with the
combinators in `_api-alt.md`.

### 7.6 Skills

- Bundle files are read as UTF-8, so binary files in a skill are corrupted
  (`apps/marbles/src/lib/managers/skills.ts:43`).
- A skill defined in code cannot be added; `SkillOp` is only `load`, `add`,
  `pick` (`types.ts:24-28`).
- In a sandbox session, skill instructions are pasted into the system
  prompt and the skill's files, description, and registry tools are dropped
  (`apps/marbles/src/lib/managers/agents.ts:343-348`). Local sessions use the
  registry.

**Proposal.** Read bundle files as bytes, accept `Skill` objects in a set,
and give sandbox sessions the same registry tools local sessions get.

## 8. Definitions you can use

**Found by** using Marbles for real, 2026-10-10: an agent declared at the top
of a module could not be used as an agent.

**Today.** Every word returns a definition: data the engine reads, with
nothing behind it until a body hands it to a context key.

- `agent({ … })` returns `AgentDefinition`, a record of `id`, `kind`,
  `prompt`, `model`, `provider`, and `skills`
  (`apps/marbles/src/authoring/resources.ts:28-55`). It does nothing until a
  body passes it to `agents.session(def)`.
- `step(…).do(fn)` and `workflow(…)` return a lockable record: calling it
  builds a node for a tree (`apps/marbles/src/authoring/lock.ts:132-160`).
  Only an engine launch runs it.
- `workspace`, `sandbox`, and `artifact` return `{ id, kind, …spec }`
  (`resources.ts:57-86`).

This was the design: `_api-alt.md` says "Definitions are presets" and that
the context creates the same things on the spot. In use, it reads as a
regression.

**Before the rebuild.** `step(name, body)` and `workflow(name, body)`
returned `@foundry/workflows` `Step` and `Workflow` instances, which have
`run(input)`. `agent(name, spec)` returned the package's own `AgentSpec`:
still a record, but one `@foundry/agents` takes directly (`86684db^`,
`apps/quirks/src/lib/index.ts`).

**Proposal.** Calling a word still builds and registers the definition,
under the same id rules, but what it returns is an instance of the thing it
names. The definition's fields stay on it, so everything that takes a
definition today keeps taking it. One rule decides each instance: it has the
methods of the handle its context key returns for that definition. The
context key stays the way a body gets the run-scoped version.

```ts
const designer = agent({ prompt: "You keep the design tokens in step with Figma." });

// Anywhere: an agent, with its presets.
const { text } = await designer.generate("Which tokens look unused?");

// Inside a body: the same agent, given the run's harness.
const session = await agents.session(designer, { cwd: worktree.root });
```

| Word | The instance adds | The run-scoped way in |
| --- | --- | --- |
| `agent` | `generate(input, options?)` and `stream(input, options?)`, with the call options from 7.1 (`output`, model settings). Nothing else. | `agents.session(def)` |
| `step` | `run(input)`, resolving to the step's output. Calling it still locks a node (`review({ … })`). | A lock in a tree |
| `workflow` | `run(input)`, resolving to the workflow's output. Calling it still locks a node. | A launch or a trigger |
| `workspace` | The workspace handle: `root`, `files()`, `git`. | `workspaces.load(def)` |
| `sandbox` | The sandbox handle: `exec(argv)` and `close()`, started on first use. | `sandboxes.start(def)` |
| `artifact` | `write(files)`, and the read from finding 5. | `artifacts.write(def, files)` |
| `skills` | Unchanged: a set is already a value an agent takes. | An agent's `skills` |

- **step and workflow.** `run` is defined on the function the way
  `lockable()` defines `parallel` and `series` (`lock.ts:146-149`); no record
  field is named `run`.
- **The handles grow with section 7.** What a workspace, sandbox, or
  artifact handle exposes is 7.3, 7.2, and 7.4; the instance follows the
  handle rather than getting a shape of its own.
- `schedule` and `monitor` are triggers, not definitions, and are out of
  scope.

This amends `_api-alt.md`: "Definitions are presets" under Top-level words
and Context keys, and the "Shortcuts" item in its Open section, which asks
for "calling an agent directly with its presets". Settle it there before
building.

**Open.**

- Inside a run, does a direct `designer.generate()` pick up the run scope
  (the `AsyncLocalStorage` in `apps/marbles/src/lib/run-scope.ts` already
  carries the frame's cwd), or run unscoped? This decides whether
  `agents.session` stays the only scoped way in.
- Where the harness comes from with no engine. The default provider is the
  first available CLI harness, and the built-in `@foundry/agents` harness
  has no provider yet (`_rebuild-gaps.md`, "Open after phase 2").
- What dry-run and replay mean for a standalone call, and what
  `step.run(input)` does with `ask`, `report`, and artifacts when no engine
  hosts it.
- Who closes a sandbox an instance started outside a run, and where an
  artifact instance writes with no engine's store.
- An agent's durable id is claimed at call time, from its name or its
  `const`. Returning an instance must not move it.
