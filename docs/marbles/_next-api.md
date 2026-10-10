# Marbles: the next API pass

Maintainer note, excluded from the Blume site. The technical design for
roadmap item 5: every entry in [`_findings.md`](./_findings.md), turned into
changes with files, types, tests, and an order. Surveyed against the code on
2026-10-10. Paths are relative to the repository root; `marbles/` is short
for `apps/marbles/src/`.

This document amends [`_api-alt.md`](./_api-alt.md), which wins where the two
disagree. The edits it needs are listed in
[Amendments to `_api-alt.md`](#amendments-to-_api-altmd); make them once the
decisions below are agreed and before the code changes start.

## Contents

- [Two principles](#two-principles)
- [Decisions needed](#decisions-needed)
- [Part A. Definitions are instances](#part-a-definitions-are-instances)
- [Part B. The agent surface and structured output](#part-b-the-agent-surface-and-structured-output)
- [Part C. Fixes](#part-c-fixes)
- [Part D. Monitors and launchd](#part-d-monitors-and-launchd)
- [Part E. Pass-through for the other keys](#part-e-pass-through-for-the-other-keys)
- [Part F. New API](#part-f-new-api)
- [Sequencing](#sequencing)
- [Docs to update as each part lands](#docs-to-update-as-each-part-lands)
- [Amendments to `_api-alt.md`](#amendments-to-_api-altmd)

## Two principles

**1. Marbles is a pass-through.** Marbles fills in what it owns: the working
directory, cancellation, the step's stream, dry-run echo, replay, and run
identity. Everything else passes through to the package underneath. A
default is an argument filled in, not an option removed. Each wrapper takes
the underlying options type minus the keys Marbles owns, and returns the
underlying result plus Marbles' own fields. (Finding 7.)

**2. A definition is an instance.** Calling a word still builds and
registers the definition under the same id rules, but what it returns is a
usable instance of the thing it names. Its data fields stay on it, so
everything that takes a definition keeps taking it. An instance has the
methods of the handle its context key returns for that definition; the
context key stays the way a body gets the run-scoped version. (Finding 8.)

| Word | The instance adds | The run-scoped way in |
| --- | --- | --- |
| `agent` | `generate(input, options?)`, `stream(input, options?)`. Nothing else. | `agents.session(def)` |
| `step` | `run(input)`. Calling it still locks a node. | A lock in a tree |
| `workflow` | `run(input)`. Calling it still locks a node. | A launch or a trigger |
| `workspace` | The workspace handle: `root`, `files()`, `git`, and what Part E adds. | `workspaces.load(def)` |
| `sandbox` | The sandbox handle: `exec`, `close`, and what Part E adds; started on first use. | `sandboxes.start(def)` |
| `artifact` | `write(files)` and `latest()`. | `artifacts.write(def, files)`, `artifacts.latest(def)` |
| `skills` | Unchanged: a set is already a value. | An agent's `skills` |

`schedule` and `monitor` are triggers, not definitions, and are out of scope
for principle 2.

## Decisions needed

Each has a recommendation; the parts below are written assuming it.

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Where an instance gets its runtime outside a run | Three tiers: the current run, else the host's engine, else a lazy default runtime ([A.1](#a1-where-the-runtime-comes-from)). |
| D2 | Does a direct call inside a run join the run | Yes, through the run scope's async context ([A.2](#a2-inside-a-run)). |
| D3 | Agent instance continuity | Each `generate`/`stream` call is a fresh one-turn session; continuity stays with `agents.session` ([A.3](#a3-agent)). |
| D4 | What the default runtime persists | Artifacts persist to the CLI's artifact store; sessions and state stay in memory ([A.1](#a1-where-the-runtime-comes-from)). |
| D5 | How per-call `output` reaches the AI SDK | Type it ourselves and rely on `prepareCall`'s spread, guarded by a test ([B.1](#b1-the-ai-sdk-surface)). |
| D6 | Error model for structured output | Plain turns resolve as today; a turn with `output` rejects when no valid object comes back, after committing the message ([B.4](#b4-the-marbles-session)). |
| D7 | What `text` means on a reply | Keep Marbles' meaning (every text part, joined); expose the SDK result as `result` ([B.4](#b4-the-marbles-session)). |
| D8 | What a retried step does with recorded calls | A retry starts fresh: ledger entries recorded by the failed attempt are dropped; finished children are not re-driven ([E.4](#e4-steps-and-workflows-75)). |
| D9 | How Varlock is loaded | Run `varlock load` as a subprocess from the workspace root when a `.env.schema` exists; Varlock stays optional ([D.2](#d2-environment-for-launchd-ticks-finding-2)). |
| D10 | Roadmap order | Keep item 5's order; the two bugs and the quick fixes (Part C) are independent and can land at any time. |

## Part A. Definitions are instances

**A.1 to A.4 landed 2026-10-10**, with the `_api-alt.md` amendments 1, 2, 3,
and 6. Where the code differs from the sections below:

- The slot is `apps/marbles/src/lib/runtime.ts` (`setHost`, `clearHost`,
  `instanceRuntime`, `dispose`); the build keeps it in one chunk shared by
  both entries. The default runtime is `createDefaultEngine()` in
  `create.ts`, an unstarted engine with an empty catalog, so `report` in a
  directly run step publishes to the shared feed rather than `print`.
- One-turn calls live on `AgentsManager.turns(args?)`, reached through an
  optional `Bindings.turns`. They claim their own ledger kind,
  `agent.turn`, never `agents.session`, and record the committed message's
  session and id; a replay reads that message back from the session store.
- `step.run` records `{ output }`, so an `undefined` output replays too.

**A.5 to A.7 landed 2026-10-10** over today's handles. A workspace's `git`
is a proxy that loads the handle per call; a sandbox caches its started
handle per step attempt (keyed by the frame's signal) or per runtime, and
keeps its starter under a symbol so `agents.session(def, { sandbox })`
can start it. No sandbox field collides with the spec yet; take the
`specOf` step when E.1 adds a `files` facet. `artifact.latest()` comes
with F.2.

### Today

- `agent({ … })` returns `AgentDefinition`, a plain record
  (`marbles/authoring/resources.ts:28-55`).
- `step(…).do(fn)` and `workflow(…)` return a lockable record: a function
  with `parallel`, `series`, and the record's fields defined on it
  (`marbles/authoring/lock.ts:132-160`). Only `Engine.launch` runs one, by
  name (`marbles/lib/engine.ts:656-682`); a nameless definition cannot be
  launched at all (`marbles/lib/registry.ts:63-66`).
- `workspace`, `sandbox`, `artifact` return `{ id, kind, …spec }`
  (`resources.ts:57-86`).

Before the rebuild (`86684db^`), `step()` and `workflow()` returned
`@foundry/workflows` subclasses whose `create().run(input)` worked through
the package's own definition path. The body found its runtime in a
process-global slot, `registry.primitives()`, that the CLI bound with
`bindRuntime(...)`; an unbound `.run()` rejected with "primitives are not
bound". `agent()` returned a plain `AgentSpec`. There was no per-frame
scoping, ledger, or replay.

### A.1 Where the runtime comes from

An instance method resolves its runtime in three tiers, first match wins:

1. **The current run.** Inside a step body, through the run scope's async
   context (A.2). The instance uses the frame's scoped managers, so the call
   is attributed to the run, cancelled with the step, written to its stream,
   and replayed from the ledger.
2. **The host's engine.** When the CLI or dashboard has built an engine for
   the loaded modules, it registers itself as the host
   (`setHost(engine)` in `hostEngine`, `marbles/host.ts:128-147`). Calls from
   module top level or from outside a run use that engine's manager-level
   methods: the same models, stores, dry-run echo, and `workspaceId`.
3. **A lazy default runtime.** In a plain script with no host, the first
   instance call builds one from the same assembly `createEngine` uses
   (`marbles/create.ts`), without a catalog and without `start()`:
   - `models`: `harnessModels(selectedHarnesses(detectHarnesses(), []))`
     (`marbles/lib/harnesses.ts:41,128`). No CLI harness on `PATH` is an
     error naming `claude` and `codex`.
   - `sessions`: `InMemorySessionStore`.
   - `artifacts`: the CLI's default store, `~/.foundry/artifacts`
     (`marbles/args.ts:179-183`), so a script's write lands where the
     dashboard reads it (D4).
   - `containers`: the lazy thunk from `containersFor`.
   - `root`: `process.cwd()`; `workspaceId`: the id `workspaceState`
     derives, the first 12 hex characters of the SHA-256 of the root's real
     path (`marbles/lib/state/workspace.ts:23-27`). Artifact ids are keyed
     by it (`marbles/lib/managers/artifacts.ts:36-42`), so a script and the
     CLI in the same directory write the same artifact.
   - No `state`: in-memory state store, in-memory agent grants, worktrees
     under `$TMPDIR/marbles/worktrees`.
   - Not askable. A step's `ask` rejects (A.4). A sandboxed agent's
     harness approval or question gets the answer an unattended `roll`
     gives it today: a question is declined and an unresolved approval is
     denied (`marbles/lib/sandbox/interactions.ts:231-250`,
     `marbles/lib/sandbox/session.ts:34-48`), and the turn sees that.

   Construction does no I/O without `state`. Three things it may start hold
   the process open: the Codex app-server child
   (`packages/models/src/codex.ts:53-56,78`), the file watcher a workspace
   opens on first `files()` (`packages/workspaces/src/instance.ts:118-124`),
   and the container runtime on the first sandbox. The default runtime
   therefore registers one `beforeExit` hook that disposes it (models,
   workspaces, sandboxes), and the package exports `dispose()` for scripts
   that want to close it sooner.

**Where it lives.** Tiers 2 and 3 are a module-level slot. It must live in
a module that the Bun plugin in `marbles/host.ts:63-76` shares between the
CLI and config modules ("both entry points must share the same registry
instance"), next to `catalog`. Build the shared assembly as
`createRuntime(options)` in `marbles/create.ts`, called by `createEngine`
and by the default slot, so the two never diverge.

**Rejected.**
- *Engine-only* (an instance works only inside a run): it is the behaviour
  being fixed.
- *An explicit bind, as before the rebuild*: a plain script would have to
  build and bind an engine before calling `designer.generate()`, which is
  what "usable as a variable" is meant to remove.

### A.2 Inside a run

`current` (`marbles/lib/run-scope.ts:57-61,70`) carries `{ cwd, frame,
scope }`; the managers need `{ frame, scope, write }` and the engine's
`bindings` (`marbles/lib/bindings.ts:15-27`). Add `bindings` and `write` to
the store where the body runs (`marbles/lib/tree.ts:143-151`); the worktree
wrapper already re-enters it with a narrower `cwd`
(`marbles/lib/managers/workspaces.ts:73-78`) and keeps working unchanged.

An instance call inside a body then does exactly what the matching context
key does: `bindings.agents({ frame, scope, write })` and so on. Ledger
counters are per kind per frame (`run-scope.ts:212-214,285-289`), so mixing
`designer.generate()` with `agents.session()` in one body keeps call order
deterministic on replay.

Monitors already find host facilities this way
(`marbles/lib/monitor.ts:129-136`), so this is the existing pattern, not a
new one.

### A.3 agent

```ts
interface Agent extends AgentDefinition {
  generate<OUTPUT extends Output = never>(
    input: SessionInput,
    options?: TurnOptions<OUTPUT>
  ): Promise<SessionReply<OUTPUT>>;
  stream<OUTPUT extends Output = never>(
    input: SessionInput,
    options?: TurnOptions<OUTPUT>
  ): SessionStream<OUTPUT>;
}
```

`TurnOptions`, `SessionReply`, and `SessionStream` are Part B's types, so an
instance call and a session turn take and return the same things.

- **One turn, fresh session (D3).** Each call opens a session, runs one
  turn, and closes it. Continuity across turns stays with
  `agents.session(designer)`.
- **Replay returns the recorded reply.** Inside a run the call claims an
  `agent.generate` ledger entry and records the session id and the
  committed message id. On replay it reads that message back from the
  session store, with its `output` from the metadata (B.2), and does not
  run the turn again, the same rule as `step.run` (A.4). A replayed
  `stream` yields the stored message as one finish event.
- **Structurally an `AgentDefinition`.** The data fields stay own,
  enumerable properties; `generate` and `stream` are non-enumerable. Tests
  pass plain literals and spreads to `agents.session`
  (`apps/marbles/test/lib/agents.test.ts:56-60,142,161`); a spread of an
  instance is a plain definition, which is correct.
- **Identity.** `agent()` must keep calling `callSite()` at the same stack
  depth (`resources.ts:48-52`), so the instance is built after the id is
  claimed, in the same function.
- **Under `--dry-run`** the host's echo models answer (tier 2).

### A.4 step and workflow

`run(input)` is defined on the function next to `parallel` and `series` in
`lockable()` (`lock.ts:141-149`), non-enumerable like them. No record field
is named `run`. `isLockedNode`, `isStep`, `isWorkflow`, `launchTarget`, and
`Registry.entries()` read only `kind`, `name`, `description`, and `input`,
so none of them is affected.

```ts
interface Runnable<R, O> {
  run(...input: Record<string, never> extends R ? [input?: R] : [input: R]): Promise<O>;
}
```

**Outside a run** (tiers 2 and 3), `run` executes in-process, the way
`apps/marbles/test/helpers/launch.ts:30-50` already does: `factoryFor(def,
bindings, scopes)(input)`, then `Workflow.attach(root, input).run()`,
settling every scope in `finally`. It does **not** go through
`Engine.launch`:

- The engine's queue runs one run at a time (`engine.ts:439`); awaiting a
  nested launch from a body would deadlock.
- `launch` is by name, and an unnamed definition should still run. Give
  `factoryFor` a synthetic root key for one (`tree.ts:222-248`).

Input is validated at the root as today (`tree.ts:230-234`).

**Inside a run** (tier 1), the call claims a `step.run` ledger entry and
records the output. On replay the recorded output is returned without
running the definition again. The nested run gets its own `RunScope`
whose cancellation follows the calling frame's signal.

**`ask` without a host.** Outside an askable engine, a suspension rejects
with the package's `SuspendSignal` (`packages/workflows/src/workflow.ts:654-665`).
Map it to `Error("<name> asked a person; run it with marbles to answer")`.
`report` writes to the runtime's feed; with the default runtime it is
dropped to `print`.

### A.5 workspace

The instance is the workspace handle on `spec.path` resolved against the
runtime's root: today `{ root, files(), git }`
(`marbles/lib/managers/workspaces.ts:90-112`), and the package `Workspace`
once E.2 lands. It keeps `path`, `id`, and `kind`, so it still works as a
sandbox `mount` (only `mount.path` is read). Opening is lazy: no watcher
starts until `files()`.

### A.6 sandbox

The instance is the sandbox handle, started on the first call that needs a
container, and closed by `close()`, by the run's settle when started inside
a run, or by the default runtime's dispose.

**Hazard.** Three places tell a files sandbox from an image sandbox with
`"files" in spec` (`resources.ts:72`, `marbles/lib/managers/sandboxes.ts:89,177`),
and the container's `files` facet (E.1) would make every instance look like
a files sandbox. Store the spec captured at definition time under a
non-enumerable symbol, and have the managers read `specOf(def)`, which
returns that spec for an instance and the value itself for a plain spec.

A sandbox instance used from two runtimes is still refused: the
`containerOf` check (`sandboxes.ts:141-147`) stays.

### A.7 artifact

`write(files)` and `latest()`, the same operations as
`artifacts.write(def, …)` and `artifacts.latest(def)` (F.2). Under a dry
host, `latest()` reads the real store and `write` is echoed (see F.2).

### A.8 Tests

- `apps/marbles/test/lib/instances.test.ts` (new):
  - an instance outside any engine uses the default runtime (mock models
    through an injected default);
  - with a host engine set, the host's models answer;
  - inside a body, the call is in the ledger and replays;
  - `run` on a nameless step;
  - a nested `run` inside a body does not deadlock;
  - `ask` without a host rejects with the mapped message;
  - a spread of an agent instance is accepted by `agents.session`;
  - a sandbox instance is not mistaken for a files sandbox.
- Extend `apps/marbles/test/lib/agents.test.ts` and `direct.test.ts` to
  call `designer.generate` beside `agents.session(designer)`.
- The default runtime's dispose: a script that calls a Codex-backed
  instance exits (integration, kept out of the default test command).

## Part B. The agent surface and structured output

**Landed 2026-10-10.** Where the code differs from the sections below:

- `LoopAgent` is generic per call (`stream<OUTPUT>`, `generate<OUTPUT>`),
  not per class. An agent's `settings` (B.5) are applied by the Marbles
  turn wrapper as each turn's defaults, not through `AgentSpec.settings`,
  so they reach sandboxed CLI sessions too.
- A turn with `output` skips `LoopAgent`'s line smoothing, which would hold
  a one-line JSON answer back until it ended and leave no partials.
- `SessionStream` carries `result` as a promise, `undefined` for drivers.
- Structured output parses the final step's text: `transformStream` resets
  it on each `start-step` part.
- `@foundry/marbles` re-exports the AI SDK's `Output`, and exports
  `TurnOptions` and `AgentSettings`.

The AI SDK is `ai@7.0.58` in `packages/agents`, `packages/models`, and
`apps/marbles`. Structured output is `output: Output.object({ schema })`
(also `array`, `choice`, `json`, `text`), giving `result.output` on
`generate` and `partialOutputStream` and `output` on `stream`. Both CLI
providers honour it: `ai-sdk-provider-claude-code@4.0.1` maps a JSON-schema
`responseFormat` to Claude Code's `outputFormat`, and
`ai-sdk-provider-codex-cli@2.1.2` to the app server's `outputSchema`.

Five layers stop it today; each section below is one.

### B.1 The AI SDK surface

`ToolLoopAgent<CALL_OPTIONS, TOOLS, RUNTIME_CONTEXT, OUTPUT = never>`
(`node_modules/ai/dist/index.d.ts:5143-5170`). In the types, `output` and
the model settings (`temperature`, `maxOutputTokens`, `stopWhen`,
`toolChoice`, `activeTools`, `providerOptions`, …) are constructor settings
only (`ToolLoopAgentSettings`, `:4932-5130`). `AgentCallParameters` allows
the prompt or messages, `abortSignal`, `timeout`, and callbacks
(`:4479-4585`).

At runtime, `prepareCall` builds `{ ...settings, stopWhen, ...options }`
from the call's remaining parameters, so any extra key, `output` included,
overrides the constructor and reaches `streamText`. `LoopAgent` already
relies on this for `providerOptions` (`packages/agents/src/agents/loop-agent.ts:29-42`).

**D5.** Type the per-call settings ourselves and keep relying on the
spread, with a test in `packages/agents` that asserts a per-call `output`
and `temperature` reach the model, so an SDK upgrade that closes the path
fails loudly. Rejected: building a `ToolLoopAgent` per call with a
different `output`, which repeats tool and model setup on every turn.

Two runtime facts shape the wrapper:

- `GenerateTextResult` is a class with prototype getters
  (`DefaultGenerateTextResult`); `{ ...result }` copies nothing, and
  `result.output` throws when the last step did not stop. Wrap with
  explicit fields, not a spread.
- `generateText` parses eagerly and throws `NoObjectGeneratedError`;
  `streamText` parses lazily, so only `result.output` rejects and the
  stream carries no error part.

### B.2 packages/agents

- **`LoopAgent`** (`loop-agent.ts:134`) extends
  `ToolLoopAgent<never, ToolSet>`. Make it generic over `OUTPUT extends
  Output = never`, and widen the call types:

  ```ts
  type CallSettings = Pick<
    ToolLoopAgentSettings<never, ToolSet>,
    | "providerOptions" | "temperature" | "maxOutputTokens" | "topP" | "topK"
    | "seed" | "stopSequences" | "stopWhen" | "toolChoice" | "activeTools"
  >;
  export type LoopAgentCallParameters<OUTPUT extends Output = never> =
    AgentCallParameters<never, ToolSet> & Partial<CallSettings> & { output?: OUTPUT };
  ```

  `stream` and `generate` (`:147-183`) return
  `StreamTextResult<ToolSet, Record<string, unknown>, OUTPUT>` and
  `GenerateTextResult<…, OUTPUT>`. `AgentHarnessStream`
  (`packages/agents/src/harness/agent-harness.ts:82-85`) follows.
- **`SessionHarness`** (`packages/agents/src/harness/session-harness.ts`).
  Replace `SessionStreamOptions = { signal } & StreamHandlers` (`:70-72`)
  with:

  ```ts
  export type TurnOptions<OUTPUT extends Output = never> =
    Partial<CallSettings> & StreamHandlers & {
      readonly output?: OUTPUT;
      readonly signal?: AbortSignal;
    };
  ```

  At the call (`:164-170`), spread each present key conditionally, as the
  comment at `:167-168` already requires for `providerOptions`. Keep
  `result` instead of discarding it.
- **`SessionStream`** (`packages/agents/src/session/events.ts:143-148`)
  gains `output: Promise<InferGenerateOutput<OUTPUT>>` and
  `partialOutputStream: AsyncIterable<InferStreamOutput<OUTPUT>>` (the AI
  SDK's exported names for its complete and partial output types), and
  `transformStream` (`packages/agents/src/harness/stream-transform.ts`)
  fills them on every path. When `output` is set, it accumulates the text
  deltas and calls `output.parsePartialOutput({ text })` per delta and
  `output.parseCompleteOutput({ text }, context)` at finish. Doing it here,
  not by reading the SDK's `result.output`, gives local and driver sessions
  the same behaviour. The context argument is used only to build the thrown
  error, so a driver path can pass its own usage and finish reason.
- **The structured value is stored.** Add `output?: JSONValue` to
  `MessageMetadata` (`packages/agents/src/session/types.ts:141-162`) so a
  replayed or reloaded session returns it without parsing again.
- **The dead seam.** `GenerationConfig` and `StreamOptions`
  (`events.ts:116-136`) are exported but used only by
  `packages/agents/src/test/transport/turn.test.ts`. Delete them;
  `TurnOptions` replaces them.
- **`AgentSpec.settings`** already flows through `createAgentPreset`
  (`packages/agents/src/agents/resolve.ts:183-210`). With `LoopAgent`
  generic, a spec can carry a default `output`.

### B.3 packages/models: the sandbox drivers

CLI sessions in a sandbox bypass the AI SDK loop. `HarnessTurnDriver.run`
(`packages/agents/src/harness/turn-driver.ts:101-113`) gains
`responseFormat?: { type: "json"; schema: JSONSchema7 }`, filled by
`createDriverSession` (`packages/agents/src/harness/driver-session.ts:108`)
from `await output.responseFormat`.

- **Claude Code** (`packages/models/src/harness/claude-code.ts:129-138`):
  pass `responseFormat` to `model.doStream`. The provider turns it into
  `outputFormat`. `sdkOptions` stays `undefined` (`:113-114`), so authority
  cannot be overlaid, and the provider blocklists `outputFormat` in
  `sdkOptions` anyway.
- **Codex** (`packages/models/src/harness/codex.ts:298-313`): add
  `outputSchema` (the schema sanitized as the provider's
  `buildTurnStartParams` does) to `turn/start`.

Both return the JSON as the final text. `transformStream` parses it (B.2).
Driver sessions have no AI SDK result; `SessionReply.result` is `undefined`
there (B.4).

### B.4 The Marbles session

`wrapAgentSession` (`marbles/lib/managers/agent-turns.ts:30-145`) and the
types in `marbles/lib/types.ts:140-158`.

```ts
export type SessionReply<OUTPUT extends Output = never> = SessionMessage & {
  /** Every text part of the final turn, joined with newlines. */
  readonly text: string;
  /** The parsed structured value; present when the turn passed `output`. */
  readonly output: InferGenerateOutput<OUTPUT>;
  readonly usage: SessionUsage;
  /**
   * The AI SDK stream result of the final turn, settled; `SessionHarness`
   * keeps it (B.2). Absent for CLI driver sessions and on replay.
   */
  readonly result?: StreamTextResult<ToolSet, Record<string, unknown>, OUTPUT>;
};

export interface Session {
  generate<OUTPUT extends Output = never>(input: SessionInput, options?: TurnOptions<OUTPUT>): Promise<SessionReply<OUTPUT>>;
  stream<OUTPUT extends Output = never>(input: SessionInput, options?: TurnOptions<OUTPUT>): SessionStream<OUTPUT>;
  readonly harness: SessionHarness | HarnessSession;
  readonly ref: SessionRef;
}
```

- **Marbles owns** `signal` (merged with the step's, `agent-turns.ts:75-79`)
  and `onText` (teed to the step stream, `:71-74`). Everything else in
  `TurnOptions` passes through unchanged.
- **`text` (D7).** Keep today's meaning, every text part of the final turn
  joined with newlines (`agent-turns.ts:23-27`). Prebuilt steps and tests
  rely on it, and driver sessions have no SDK `text`. The SDK's final-step
  text is `result.text` where there is a result.
- **Errors (D6).** A plain turn resolves with `status: "error"` as today. A
  turn with `output` that does not produce a valid object rejects with the
  SDK's `NoObjectGeneratedError` after the message is committed, so the
  transcript keeps what the model said.
- **Steering.** A steered turn re-issues the prompt (`:100-105`). `output`
  and the other options carry into the re-issued turn, and the reply
  describes the final turn, as today.
- **Callers to update.** `SessionReply` is public
  (`marbles/authoring/index.ts:37`). Fields read today, all kept: `.text` in
  `marbles/authoring/prebuilt.ts:47-55,173-174`; `.status`, `.parts`, `.id`
  in `apps/marbles/test/sandbox/interactive.integration.test.ts`,
  `provider.integration.test.ts:146-149`, and `apps/marbles/test/sessions.test.ts:286`.
  `marbles/lib/sandbox/delegate.ts:97-103` uses the package's
  `HarnessSession.generate`, which stays a `SessionMessage`.

### B.5 agent() settings

`agent({ … })` gains `settings`, typed as the AI SDK's call settings plus
`output`, passed to `AgentSpec.settings` in `openLocalSession`
(`marbles/lib/managers/agents.ts:362-387`). Per-call options override them.
The spec's `tools` and `mcp` stay out of this pass. They are the
`AgentSpec` fields `_api-alt.md` lists as unwired, and wiring them is a
permission question, not a pass-through one.

### B.6 Dry runs

The echo model (`marbles/lib/models/echo.ts:99-152`) ignores
`responseFormat`, so `Output.object` under `--dry-run` would throw. When
`responseFormat.type === "json"` has a schema, emit the smallest value the
schema accepts: `{}` with required keys filled by type (`""`, `0`, `false`,
`[]`, the first enum member), recursively. Print the schema's top-level keys
in the echo line so the dry run shows what was asked for.

### B.7 Tests

- `packages/agents`:
  - per-call `output` and `temperature` reach the model through
    `LoopAgent` (the D5 guard);
  - `SessionHarness` with `Output.object` resolves `output` and streams
    partials;
  - `output` is stored on the message metadata;
  - an invalid object rejects `output`.
- `packages/models`: driver tests assert `responseFormat` on Claude Code's
  `doStream` and `outputSchema` on Codex's `turn/start`.
- `apps/marbles/test/lib/agents.test.ts`: `session.generate(…, { output })`
  returns a typed value, with mock models; the echo model returns a
  schema-shaped value under dry.
- Integration (separate command): one structured turn per CLI provider,
  local and in a sandbox.

## Part C. Fixes

Independent of everything else. Each is small.

### C.1 Worktree defaults apply only in withWorktree (7.3)

`wrapGit` (`marbles/lib/managers/workspaces.ts:61-88`) special-cases only
the `withWorktree` property. `git.worktree()` falls back to `tmpdir()`,
outside the sandbox mount roots (`marbles/create.ts:166-169`), and every
`Worktree` returned by `worktree()`, `worktrees()`, or the callback is the
raw object.

Fix: apply `home ?? worktreeHome` (with `mkdirSync`) to `worktree()` as
well, and wrap returned `Worktree` objects so a nested call gets the same
defaults. The cwd narrowing stays specific to `withWorktree`, since only a
callback has a body to narrow.

Tests: extend `apps/marbles/test/lib/managers.test.ts:140` to cover
`worktree()` and a nested `withWorktree` on a returned worktree.

### C.2 A scoped artifact create is not replayed (7.4)

The scoped `create` (`marbles/lib/managers/artifacts.ts:122`) bypasses the
ledger while `write` (`:123-132`) uses it, so a replayed body creates a
second artifact. Claim `artifacts.create` and record the version, as
`write` does.

Tests: in `managers.test.ts:176-221`, a replayed `create` returns the same
version (today `:214-220` asserts a new id after replay, which is the bug).

### C.3 Invalid input prints a stack trace (finding 3)

The `SchemaError` from `factoryFor` (`marbles/lib/tree.ts:230-233`) becomes
a defect under `Effect.promise` (`packages/workflows/src/orchestrator.ts:137-139`),
then a `FiberFailure` from `Effect.runPromise` (`:436-438`), whose
`instanceof SchemaError` is false. Only `UsageError` is caught by the CLI
(`marbles/cli.ts:287-296`).

- Use `runEffectPromise` (`packages/workflows/src/helpers/index.ts:25-50`),
  which unwraps the failure to the original error, at `orchestrator.ts:436`,
  `:545`, and `:771`.
- `--input` is parsed with a bare `JSON.parse` (`cli.ts:186-187`); throw a
  `UsageError` naming the flag on a `SyntaxError`.
- In `main`, map a `SchemaError` on a launch's input to one line and exit
  code 1, as `UsageError` does (`cli.ts:287-296`), with the hint built from `engine.definitions()` (input fields) and
  `engine.schedules()` (keys that carry input): `design-sync needs input:
  file (string). Pass --input '{"file":"…"}', or roll a schedule key that
  carries it: design-sync-b60490e1.`
- Roll at an ask: `feedRouter.ask` cancels with no reason
  (`marbles/lib/feed/route.ts:89`). Pass `"waiting for an answer; open the
  dashboard with marbles"` and print it as one line, not a trace.

Tests: none cover a CLI `roll` with bad input or at an ask. Add both to
`apps/marbles/test/cli-terminal.test.ts`, spawning the CLI as `:320-345`
does.

### C.4 Git queries (finding 4)

`Git` is `packages/workspaces/src/node/git.ts`. `worktree()` (`:179-195`)
runs `mkdtemp`, then `git worktree add -b` through `run`, and fails with
Git's error when the branch exists, leaving the directory behind.

- `hasBranch(name)`: read through `simpleGit`, as `status()` does
  (`:119-159`), **not** through `run`, which is the mutation path and
  echoes `""` under `--dry-run` (`marbles/create.ts:219-224`). Use
  `branchLocal()` or `revparse(["--verify", "--quiet", "refs/heads/" + name])`.
- `worktree()` checks the branch before `mkdtemp` and throws
  `branch "<name>" already exists; pass a new branch, or check it out with
  worktree({ base: "<name>" })`.

Tests: `packages/workspaces/src/test/git.test.ts` around `:500`, with an
existing branch; and the Marbles proxy passes `hasBranch` through under dry
without echoing.

Then Design Sync drops its `execFile` and uses
`workspaces.current.git.hasBranch(branch)`.

## Part D. Monitors and launchd

### D.1 Request options for HTTP monitors (finding 1)

```ts
monitor(`https://api.figma.com/v1/files/${file}/meta`)
  .request(() => ({ headers: { "X-Figma-Token": process.env.FIGMA_TOKEN ?? "" } }))
  .every("1h")
  .do(() => designSync({}, { file }));
```

- **Builder.** `MonitorBuilder` (`marbles/authoring/triggers.ts:73-78`)
  gains `request(init: RequestInit | (() => RequestInit | Promise<RequestInit>))`,
  carried through the `build` closure that already threads `every`. It
  throws on a files source.
- **Where it is stored.** On `MonitorRecord` (`marbles/lib/registry.ts:20-31`),
  never on `MonitorSpec`. The spec is shown in the dashboard's
  configuration JSON (`marbles/dashboard/snapshot.ts:306,312`), printed by
  `list` (`cli.ts:140`), and persisted through `monitorSpecSchema` for
  agent-created automations (`marbles/lib/automation/service.ts:37`).
- **Flow.** `Registry.monitor` (`registry.ts:99`) passes
  `detector(key, source, handler, { request })`. `DetectorOptions`
  (`monitor.ts:108-113`) gains `request`, threaded through `observer`
  (`:177-199`) to `observeHttp`. Each poll resolves it and calls
  `fetch(url, { ...init, signal })`.
- **The key** is unchanged; it derives from the source string alone
  (`triggers.ts:95-97`).
- **Fixes that land with it** (`monitor.ts`):
  - A non-2xx is a change like any other, not a failed poll
    (`:309-311`, `:227-231`). Hash and compare the status with the body, and
    give `change.status` its real value. A network error still fails the
    poll.
  - Read the body as bytes and decode as text only for a textual
    `content-type`; hash the bytes.
  - Keep `statusText`, `url`, and `redirected` on the rebuilt `Response`
    (`:332-335`).
  - A `401` or `403` names the status and the URL in the log, never header
    values.
- **Agent-created monitors** (`service.ts:68-69,121-126`) do not get
  `.request`; their `fetch` stays `noRedirects`.

Tests: `apps/marbles/test/monitor.test.ts` `describe("http detector")`
(`:428`). Its `stub` already records `RequestInit`; assert the headers and
that a function is called per poll. Change `:484`, which locks in a 500 as
a failed poll. In `describe("monitor factory")` (`:510`), assert that
`.request` on a glob throws and that the key does not change.

Open, carried from finding 1:

- What the monitor hashes. Hashing bytes and status does not answer it: an
  authenticated API often returns fields that change on every request
  (signed asset URLs, timestamps). Check whether Figma's `/meta`
  `thumbnail_url` is one before Design Sync becomes a monitor. If recipes
  keep returning early on noise, reconsider choosing what is hashed, which
  `_api-alt.md` rules out today ("no `select`").
- Whether `change.previous` and `change.current` keep the full body or only
  the hash.

### D.2 Environment for launchd ticks (finding 2)

Today the plist's `EnvironmentVariables` holds only `PATH`
(`marbles/launchd.ts:102-106`), and `WorkingDirectory` is the cwd at
install (`cli.ts:168`), not the workspace root. Modules load in exactly one
place, `loadSource` (`marbles/host.ts:77-79`), reached through
`openWorkspace` by the CLI and the dashboard.

- **Load before modules (D9).** At the top of `openWorkspace`, if
  `sourceRoot(configPath)` (`marbles/source.ts:57-73`) has a `.env.schema`,
  run `varlock load --format json --path <root>`, and merge the resolved
  values into `process.env` (keeping values already set). Use the CLI, not
  the library: the public `load()` discovers from `process.cwd()`, the only
  path-taking library call is the `internal` export
  (`loadVarlockEnvGraph`), and the CLI takes `--path`.
- **Varlock stays optional.** The published package does not require it
  (`CONTRIBUTING.md:72-73`). With a schema and no `varlock` binary, fail
  naming the schema and the install command. Without a schema, nothing
  changes.
- **launchd.** Set `WorkingDirectory` to the workspace root. `launchd
  install` runs the same load and refuses to install when a required value
  is missing, naming it. Values are never written to the plist.
- **`status`** reports a schedule whose last tick failed on a missing
  value.

Open, carried from finding 2: whether a module can declare what it needs
(an `env` word, or a schema export) so `list` can show it, or whether the
workspace schema is enough.

Tests: `apps/marbles/test/launchd.test.ts:213` runs `launchd install …
--dry-run` end to end with an `env` override, which is the template for a
schema present, absent, and missing a value. `source.test.ts:35,72` for the
load order.

Update `CONTRIBUTING.md:72-73` to say Marbles loads a workspace
`.env.schema` when there is one.

## Part E. Pass-through for the other keys

Each follows principle 1. The instance (Part A) follows the handle.

### E.1 Sandboxes (7.2)

`wrap` (`marbles/lib/managers/sandboxes.ts:107-125`) returns `{ close,
exec(argv), id }` over a `Container` with `commands`, `files`, `processes`,
`shell`, `ports`, `services`, and `volumes`
(`packages/sandbox/src/container/facets.ts:42-50`).

- Return the container with Marbles' defaults applied: every call carries
  the step's signal; `commands.exec` and `processes` write to the step's
  stream; dry runs echo.
- `exec(command, options?)` takes `SandboxCommand = string | readonly
  string[]` and `SandboxExecOptions = { cwd, environment, user }`
  (`packages/sandbox/src/types.ts:7,26-31`), with `signal` owned. Keep
  `exec` as a top-level shortcut for `commands.exec`.
- The spec is the package's constraints
  (`packages/sandbox/src/container/constraints.ts:44-124`), with
  `/workspace`, the mount source, and `workdir` as defaults rather than
  constants (`sandboxes.ts:72-104`). The allowed mount roots stay as a
  boundary.
- Rename Marbles' `Sandbox` type, which reuses the package's name for a
  smaller shape (`marbles/lib/types.ts:181-185`).
- Registry operations (`list`, `remove`, `restart`, `sweep`) are not on the
  context; they are host operations and stay on the engine.

Tests: `apps/marbles/test/lib/managers.test.ts:223-390`.

### E.2 Workspaces (7.3)

Return the package's `Workspace` with `git` decorated (C.1 and C.4), instead
of `{ root, files(), git }` (`workspaces.ts:90-112`). `files()` keeps kind,
extension, and metadata; `read`, `save`, `createFile`, `entries`, `refresh`,
`summary`, `scan`, `id`, and `source` become reachable. The workspace
system's `on("change")`, `list`, `open`, and `close` stay host operations.

Breaking: `files()` returning entries rather than paths changes the
Start Here `count` example and the Software Factory's `inspect`. Keep a
`paths()` shortcut, or update both pages in the same change.

### E.3 Artifacts (7.4)

Widen the manager's `Pick<ArtifactOperations, "create" | "get" | "revise">`
(`artifacts.ts:26`) to the read operations (`getContent`, `listContents`,
`readFile`, `readRoot`) and pass them through with the workspace identity
and replay applied.

- `ArtifactVersion` returns the package's `Content` fields (digest, state,
  tag, metadata, timestamps), not `{ artifactId, contentId, id }`
  (`types.ts:194-199`).
- `create` keeps `metadata` and `freeze`; `write` takes `{ replace?: false }`
  for a partial change; files accept the package's sources.
- Provenance by default: `ContentMetadata.runId` and `sessionId`
  (`packages/artifacts/src/content.ts:21-31`) from the run scope.

### E.4 Steps and workflows (7.5)

- **`.config({ retry, timeout })`.** A builder call before `.do`, threaded
  through `StepBuilder` (`marbles/authoring/builder.ts:66-137`) into
  `StepRecord` (`marbles/lib/definition.ts:55-61`) and passed as `config`
  to `Step.create` (`tree.ts:201-208`). Only `retry` and `timeout`:
  `maxAttempts` and `blocking` exist on `ExecutableConfig` but are never
  read when a step runs (`packages/workflows/src/executable.ts:44-53,586-660`).
- **Timeout must stop the body.** The package's timeout fails the step
  without aborting it (`packages/workflows/src/test/step.timeout.test.ts:298-313`),
  and a Marbles body watches `frame.signal`. On timeout, abort the frame's
  controller with a timeout reason.
- **Retry starts fresh (D8).** `scope.enter(frame)` resets the counters
  (`run-scope.ts:212-213`), so a retry would replay the failed attempt's
  recorded agent turns, sandbox starts, and artifact writes. Drop the
  ledger entries under the frame's path before a retry. Children that
  finished keep their results and are not re-driven
  (`tree.ts:129-132`).
- **`bail`.** Export `bail` from `@foundry/marbles`
  (`packages/workflows/src/types.ts:61-100`), and check `isBail` before
  output validation (`tree.ts:176-178`).
- **Log fields.** `log(level, message, fields?)` passes `fields` to
  `ctx.step.log` (`marbles/lib/context.ts:223-226`;
  `packages/workflows/src/step.ts:909-926`), and the host line formats them
  after the message.
- **Out of this pass.** `withStepHooks` builds hooks as child steps, which
  collides with Marbles driving children itself; `skip` and `waitIfPaused`
  overlap Marbles' own pause. Each needs its own design.

Tests: `apps/marbles/test/lib/tree.test.ts`, with timeout (the body sees
the abort), retry (a recorded write is redone), bail with an output schema,
and log fields.

### E.5 Skills (7.6)

- Read bundle files as bytes (`marbles/lib/managers/skills.ts:43`). The
  registry's `load_skill` decodes as UTF-8
  (`packages/agents/src/skills/registry.ts:177-181`); keep that for text
  and return binary files as references.
- `skills.add(skill)` accepts a `Skill` from `defineSkill`
  (`packages/agents/src/skills/define.ts:27`), as a new `SkillOp` kind. The
  resolver caches by `JSON.stringify(set.ops)` (`skills.ts:179`); key a
  defined skill by its name plus a digest of its files.
- Add `skills.none()` as an empty starting set; today `load()` is the only
  start.
- Sandbox sessions get the registry's tools as local sessions do, instead
  of instructions pasted into the prompt (`agents.ts:343-348`).

## Part F. New API

### F.1 Command steps (finding 6)

```ts
step("install")
  .input(z.object({ pkg: z.string() }))
  .exec("npm i $pkg");
```

- `.exec(template, options?)` is terminal, like `.do`, and comes after
  `.input` so the placeholders are checked against the schema at load.
- **Parsing.** No argv splitter exists in the repository. Add one to
  `packages/lib` (`packages/lib/src/argv.ts`): split on whitespace with
  single and double quotes and backslash escapes, no expansion. Each `$name`
  fills exactly one argument; an array fills one per element. The program,
  the first word, must be literal.
- **Running.** On the host, `execFile` in the step's cwd
  (`workingDirectory()`), with the frame's signal and output teed to the
  step stream. `{ sandbox }` runs it with `sandbox.exec(argv)` instead.
  Both reuse the patterns in `marbles/lib/sandbox/prepare.ts:17,69`.
- **Dry run.** Echo `[exec] <cwd>: <argv>` with each argument shell-quoted;
  `echoExec` (`marbles/create.ts:205-217`) joins without quoting and should
  quote too. Return exit 0 with empty output.
- **Result.** `{ exitCode, stdout, stderr }`. A non-zero exit fails the step
  unless `{ check: false }`.
- **Function form.** `.exec(({ input }) => argv)`.
- **A context-level `exec`** for bodies, under the same rules, so Design
  Sync's `git rev-parse` stops bypassing the dry run.

Open: whether children can fill placeholders by key, as they fill a body's
`input`. Recommend yes, since the node's input is the merged result
already.

### F.2 Memory between runs (finding 5)

`artifacts.latest(def)` returns the active content's version and a reader,
or `undefined`. The id is `artifactIdFor(workspaceId, def.name)`
(`artifacts.ts:36-42`), so "latest" is per workspace by construction. The
read is `get(id)?.content` then `readFile(content.id, path)`
(`packages/artifacts/src/substrate.ts:151-243`); there is no `latest` in the
package.

**Correction to finding 5.** Under `--dry-run` the artifact store is in
memory (`marbles/create.ts:116-123,185`), so `latest()` would read nothing.
Open the real store read-only under dry: reads go to the JSON store,
writes are echoed.

Session references: keep them in an artifact for now (the persistent
reviewer writes one JSON file). A smaller keyed store is a separate
proposal if artifacts prove heavy for it.

## Sequencing

```text
C  fixes ─────────────────────────────── independent; any time
B.2 packages/agents ─► B.3 drivers ─► B.4 Marbles session ─► B.5, B.6
A.1 runtime slot + createRuntime ─► A.2 async context ─► A.3–A.7 instances
                                         (A.3 needs B.4)
D.1 monitors ─── D.2 launchd             independent of A and B
E.1–E.5 ─► A.5–A.7 widen with them
F.2 needs E.3 reads; F.1's sandbox option is richer after E.1
```

In roadmap order:

1. **The agent surface.** B.1–B.6, then A.1–A.4. Structured output first,
   then instances, since `Agent.generate` returns B.4's types.
2. **Bugs.** C.1, C.2.
3. **Quick fixes.** C.3, C.4.
4. **Monitors and launchd.** D.1, D.2. Then Design Sync becomes a monitor.
5. **Pass-through for the other keys.** E.1–E.5, with A.5–A.7 following
   each.
6. **New API.** F.2, then F.1.

Each step runs `bun run validate` and the package tests before it lands.

## Docs to update as each part lands

| Lands | Pages |
| --- | --- |
| B | `concepts/agents-and-sessions.md` (structured output, settings), `reference/api.md` (`generate`'s reply, `TurnOptions`) |
| A | `reference/api.md` (each word's instance), `concepts/agents-and-sessions.md`, `concepts/composition.md` (`run` beside locking), `start-here.md` if the agent example gets simpler |
| C.3 | `reference/cli.md` (the usage error) |
| C.4 | `recipes/design-sync.md` (`hasBranch` replaces `execFile`) |
| D.1 | `concepts/schedules-and-monitors.md`, `reference/api.md`, `recipes/design-sync.md` (becomes a monitor; drop its Limits paragraph) |
| D.2 | `reference/launchd.md`, `reference/configuration.md`, `CONTRIBUTING.md` |
| E | `reference/api.md` per key; Start Here and the Software Factory if `files()` changes |
| F.1 | `reference/api.md`, `concepts/composition.md`, the Software Factory's `test` step |
| F.2 | `recipes/persistent-reviewer.md`, `recipes/design-sync.md` |

When a part lands, delete its finding from `_findings.md` and update the
roadmap.

## Amendments to `_api-alt.md`

1. **Top-level words** (`:170`, `:245`): replace "Definitions are presets.
   They are optional" with principle 2 and the instance table. Definitions
   stay optional: the context still creates the same things on the spot.
2. **Context keys backed by packages** (`:221-251`): add principle 1 as the
   rule for every key, and the three-tier runtime resolution.
3. **agents** (`:252`): add `designer.generate(…)` beside
   `agents.session(designer)`, and `TurnOptions` with `output`.
4. **The builder** (`:358`): `.config({ retry, timeout })` and `.exec`.
5. **monitor** (`:497`): `.request(init)`.
6. **Open → Shortcuts** (`:701`): remove "calling an agent directly with
   its presets", which this pass delivers.
