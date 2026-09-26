# Quirks rebuild: gap map

Maintainer note, excluded from the Blume site. Roadmap step 2.1: what existed
against [`_api-alt.md`](./_api-alt.md) when surveyed on 2026-09-25, what
phase 1 landed the same day, and what phase 2 landed after it. Paths are
under `apps/quirks/src` and `packages/`.

## Phase 1 landed

`apps/quirks/src/lib` is the new authoring lib: `builder.ts` (step,
workflow), `definition.ts` (lock forms), `tree.ts` (bound package Steps
driven from the parent body, `factoryFor`, `registerCatalog`),
`run-scope.ts` (run, frame, three abort layers, async context for the
frame cwd), `ledger.ts` (replay-safe context calls), `context.ts` (ask,
report, log, stream, signal, run), `catalog.ts`, `triggers.ts`, `schema.ts`
(Standard Schema validation, JSON Schema to launch-form fields), and
`managers/` (agents, workspaces, sandboxes, artifacts, skills). The old
registry, `Primitives`, `feed`, `loopUntil`, `bindAgents`, and `skillsNamed`
are gone. Tests live in `apps/quirks/test/lib/`.

Status of the table below after phase 2: every "Missing" and "Different" row
is done. The residency key is unchanged (folded into the identity decision).

## Phase 2 landed

- **Triggers and identity.** `schedule(target).at(slot) / .every(interval)`
  takes a definition, bare or locked with its input; `monitor(source)
  .every?(interval).do(handler)` takes one string. A handler that returns a
  childless locked node asks the tick to start it, attributed to the
  monitor. Schedules are keyed by target and input, monitors by source; the
  keys are filename- and launchd-safe and a label rides in the schedule
  history for `status`. A nameless step or workflow takes the name of the
  top-level `const` it is assigned to (`lib/identity.ts`: call site via
  `Error.prepareStackTrace`, binding via the project's own `typescript`, an
  optional peer). Definitions made inside functions or inline stay internal.
  ws monitors, `select`, object monitor forms, and live file watching are
  gone; globs are polled.
- **Approval note.** `ask.approval` resolves to `{ approved, note? }`; the
  dashboard takes the note after the choice.
- **Recovery.** A run parked on an ask is written to its run file as it
  parks, with its ledger and session id. The next askable process adopts
  it, restores the scope, and keeps the question open; the answer replays
  the body against the recorded sessions. A clean quit of the dashboard
  keeps parked runs too: `stop({ cancel })` cancels only queued and running
  runs when a state dir is set, everything without one (`--dry`).
- **Steer, pause, resume, cancel.** `engine.steer/pause/resume/cancel`, on
  the frame table's live sessions and a pause suspension kind of its own;
  the dashboard's `s`, `p`, `k` and a Stream tab. Verified against
  claude-code and codex: both commit an aborted turn with its partial text
  and continue the session.
- **Sandboxes.** `--dry` runs sandboxes over the fake runtime and echoes
  commands; `sandbox({ files, image? })` seeds a scratch sandbox under
  `/workspace`; `microsandbox` is an optional peer.

## Quirks surface today

The authoring API is `step(name, (primitives, input) => …, options?)`,
`workflow(name, graph => void)`, `agent(name, spec)`,
`schedule(name, { at, input, workflow })`, `monitor(name, handler, options)`,
and `loopUntil`. Names are required and are the registry key
(`lib/index.ts`, `lib/registry.ts`). The context is `Primitives`
(`lib/registry.ts:66`), built in `runtime.ts:65` and overridden per step in
`registry.ts:142`. Runs go through the workflows `Orchestrator`
(`engine.ts:75`) with queue concurrency 1.

| Target | Today | Status |
| --- | --- | --- |
| Nameless definitions | Name required, used as registry key | Missing |
| `.input` / `.output` schemas | Hand-written `DefinitionOptions.input.fields`, no validation | Missing |
| Builder with one context argument | `(primitives, input)` two-argument body | Different |
| `def(children, input?)` with merge and lock-time checks | `graph.step(key, def, mapper)` closures | Missing |
| `.parallel` / `.series` on definitions | Graph-builder methods only (`definitions.ts:72`) | Different |
| `workflow(name?, tree)`, non-durable setup | `workflow(name, graph => void)`; setup is part of the definition | Different |
| `feed.post` / `feed.ask` | Exists; `post` has no `artifact` field (`feed/entry.ts:31`) | Nearly |
| `stream.write` / `.pipe` | Exists (`registry.ts:160`) | As-is |
| `run { id, session }` | Nothing | Missing |
| `artifact()`, `artifacts` key | Only used inside the feed store | Missing |
| `workspace()`, `workspaces.current` / `.load(def)` | `workspace.root`, `workspaces.load(ref)`, `workspaces.git(root)` | Different |
| `sandbox()`, `sandboxes.start` | No `@foundry/sandbox` import in Quirks | Missing |
| `agents.session(def, { session })` | `sessionId` string, `executor` per call, no harness key | Different |
| `schedule(def).at/.every` | Target resolved by name string; state in `schedules/<name>.json` | Different |
| `monitor(source).every?.do` with `files` / `response` | `(primitives, change)`; `HttpChange { current, previous }`, `select`, ws | Different |
| HTTP change hashing | SHA-256 of stable JSON or text (`monitor.ts:279`) | Nearly |
| Removed keys (`models`, `executors`, `sessions`, `state`, `workspace`) | Still on `Primitives` | To remove |
| Residency keyed by config location | Keyed by hash of the workspace root (`state/workspace.ts:23`) | Decide |

## Package mechanics that shape the internals

**workflows.** Children drain one after another, after the body, unless the
body calls `ctx.next()`; the post-body drain swallows failures
(`executable.ts:437`, `:709`). The body never receives children as values; it
reads `ctx.resultOf(name)`. So the Quirks wrapper must: name each child Step
after its key, call `ctx.next()` (series) or `ctx.parallel({ key: { step,
input } })` (parallel), collect results by key, merge literal input, then call
the author's `fn`. `Composer.sequence` is a pipeline, not keyed children, so
`.series` is built on `ctx.next()`, not on it. Composer is not a public
export. Config (retry, timeout) is not inherited by children. There is no
default retry and no default timeout. `ctx.pipe` is absent on Composer
frames. Suspension replay and `(stepPath, name, occurrence)` keys match the
doc. Uncommitted in the tree: `channel-log.ts`, `step.subscribe()`,
path-scoped chunks.

**agents.** Entry point is `createAgentPreset(spec).createSession()`, which
returns a `SessionHarness`. A session is a string id, created lazily on the
first turn. `SessionRecord` has no harness key; Quirks adds one. `generate`
returns `parts`, no `.text`. No manager class.

**workspaces.** `directory()` and `git()` are extension factories passed to
`WorkspaceSystem.extend()`, not methods. `git` is optional on a loaded
workspace (only when the path is a repo), so `workspaces.current.git` needs a
guarantee from Quirks. `withWorktree` always removes the worktree. Git is on
the `@foundry/workspaces/git` subpath only.

**sandbox.** `createContainers(...)` returns `{ start, open, restart, remove,
list, shutdown, sweep }`. Specs need `format: "foundry.sandbox.container/1"`
and `mounts: [{ id, source, target, access }]` checked against
`allowedMountRoots`. Exec is `container.commands.exec(argv)`, not
`container.exec`. A `{ files }` sandbox is an image sandbox without a
workspace mount, seeded through `container.files.copyIn`.

**artifacts.** `write({ artifactId, changes })` mutates the active version in
place and throws if frozen; `revise()` freezes and adds a new one. Entries are
`{ path: { bytes, mime? } }`. "Each run adds a version" means Quirks calls
`revise`, and maps a definition to a stable `ArtifactId`.

## Open after phase 2

- **Built-in provider.** The default is still the first available CLI
  harness; no provider backs the built-in `@foundry/agents` harness.
- **Prebuilt steps lost the Codex read-only sandbox policy** they passed
  through `generateText`; the read-only instruction remains in the prompt.
- **Aborted turns read as complete.** `MessageStatus` has no "aborted"; a
  steered or paused turn is committed with its partial text as a complete
  assistant message. Cosmetic until the providers expose more.
- **Recovery of running runs.** Only suspended runs are adopted after a
  restart; a run that was mid-body when the process died is skipped with a
  warning. Replaying it from the top with the ledger is the same mechanism
  and a later step.
- **`stream()` on a session is not steered.** A steer aborts a streamed turn
  but the wrapper only re-issues the prompt for `generate()`.
- **Identity for helper-made definitions.** A definition created inside a
  helper function is nameless by design; the AST pass could follow the
  caller's binding later if that proves common.
- **`once` at an ask prints a stack trace.** A non-askable process cancels
  the run at its first `ask` by design, but the CLI surfaces it as
  `run "x" was cancelled: no reason` with a Bun stack trace and exit 1. A
  one-line "cancelled at an approval; open the dashboard" would read as the
  intended outcome. Found by the companion skill's evals.
- **An entry flips while no dashboard is up.** A non-askable process (a
  launchd tick) skips a parked run but still sweeps its feed entry to
  "cancelled" because its pid is dead; the next dashboard reopens it on
  adopt. The entry reads "no longer waiting" in between.
- **Resume prompt across processes.** A prompt given on resume is held on
  the frame; a run adopted after a restart has no frame until its body
  re-enters, so the prompt is dropped there. In-process it works.
- **`k` cancels without confirming**, and a `schedule(x)` or
  `monitor(x).every(…)` without its terminal call registers nothing and
  says nothing. Both are dashboard and load-time polish.

## Decisions

Recorded 2026-09-25.

1. **Sandbox mounts. Decided.** The current workspace, and any workspace the
   config declares, mounts read/write into any sandbox that uses it. Host
   configuration folders (`~/.foundry`, `~/.claude`, `~/.codex`, and the
   like) mount read-only. Nothing else is mounted.
2. **Durable identity for nameless definitions. Direction chosen, to
   explore.** Treat `quirks.config.ts` as source: preprocess it with a light
   AST pass (TypeScript's own parser, possibly TypeScript 7) and hash each
   definition's signature. The residency is part of the hash. This one
   mechanism covers nameless steps, artifacts, schedules, and monitors.
   Trade-off to settle during exploration: a hash of the definition's source
   changes whenever the source changes, which orphans state on every edit. A
   hash of the binding site (`const report = …`: file plus variable name)
   survives edits to the body and is the same AST pass. Likely both: binding
   site for identity, source hash for change detection.
3. **Residency key.** Folded into 2: the residency is an input to the hash,
   so the key stays as it is today (the config's directory).
4. **Artifact identity. Open.** Waits on 2.
5. **Sessions, agents, models, providers. Decided.** No harness concept:
   the provider is the harness. The agent definition carries `model` and
   `provider`, matching `AgentSpec`, and resolves with
   `models.model(model, provider, { workingDirectory })` and no parsing
   (`packages/models/src/manager.ts:177`). Catalog ids are vendor-prefixed
   (`anthropic/claude-sonnet-4.6`), so a combined `provider/model` string is
   not used. One `ModelManager` per config, built at load. A session
   reference is the session object in process; the store record carries the
   id plus the model and provider it opened with. Agents inside sandboxes
   are phase 2. Skills setup is deferred.

## Implementation notes: run scope, steering, replay

Agreed 2026-09-25. Internals for [Wired by default](./_api-alt.md#wired-by-default).

- **Frame table per run.** Path → `{ abort controller, stream writer,
  opened: sessions, sandboxes, occurrence counters }`. Everything a step
  opens through the context registers here. This is what makes a host able
  to find "the agent running in step X" with no authored code.
- **Three abort layers.** Run controller → step controller (one per frame)
  → turn controller (one per agent turn, internal). Each chains to its
  parent. `run.abort(reason)` fails the run through the top one.
- **Steer.** `run.steer(path, prompt)` (host API): find the frame's active
  session, abort the turn controller, append the prompt as a user message,
  let the session take its next turn. Write a `steer` event to the run
  stream and the transcript. Needs a new operation on the agents
  `SessionHarness`: abort the current turn and queue a message. Nothing
  else in the packages.
- **Pause.** `run.pause(path)`: abort the step controller, record a
  suspension `(path, "steer", occurrence)` through the existing package
  suspension. Resume replays; a prompt given on resume is injected at the
  recorded turn. Uses `step.pause()` and the suspension record as they are.
- **Replay-safe context calls.** Each frame counts calls to
  `agents.session`, `sandboxes.start`, `feed.ask`, and `artifacts.*` in
  order. The record for `(path, kind, occurrence)` stores what was created
  (session id, container id, artifact version). On replay the same call
  returns the recorded thing. This is the hook rule: fixed call order per
  body. Sessions are therefore recoverable from the `SessionStore` without
  the author holding an id.
- **Stream scoping.** `stream` on the context is the run stream tagged with
  the frame path (path-scoped chunks are in the uncommitted `channels.ts`
  diff). `run.stream` is the untagged whole.
