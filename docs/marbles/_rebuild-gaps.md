# Marbles rebuild: gap map

Maintainer note, excluded from the Blume site. Roadmap step 2.1: what existed
against [`_api-alt.md`](./_api-alt.md) when surveyed on 2026-09-25, what
phase 1 landed the same day, and what phase 2 landed after it. Paths are
under `apps/marbles/src` and `packages/`.

## Phase 1 landed

`apps/marbles/src/lib` is the new authoring lib: `builder.ts` (step,
workflow), `definition.ts` (lock forms), `tree.ts` (bound package Steps
driven from the parent body, `factoryFor`, `registerCatalog`),
`run-scope.ts` (run, frame, three abort layers, async context for the
frame cwd), `ledger.ts` (replay-safe context calls), `context.ts` (ask,
report, log, stream, signal, run), `catalog.ts`, `triggers.ts`, `schema.ts`
(Standard Schema validation, JSON Schema to launch-form fields), and
`managers/` (agents, workspaces, sandboxes, artifacts, skills). The old
registry, `Primitives`, `feed`, `loopUntil`, `bindAgents`, and `skillsNamed`
are gone. Tests live in `apps/marbles/test/lib/`.

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
  runs when a state dir is set, everything without one (`--dry-run`).
- **Steer, pause, resume, cancel.** `engine.steer/pause/resume/cancel`, on
  the frame table's live sessions and a pause suspension kind of its own;
  the dashboard's `s`, `p`, `k` and a Stream tab. Verified against
  claude-code and codex: both commit an aborted turn with its partial text
  and continue the session.
- **Sandboxes.** `--dry-run` runs sandboxes over the fake runtime and echoes
  commands; `sandbox({ files, image? })` seeds a scratch sandbox under
  `/workspace`; `microsandbox` is an optional peer.

## Engine split landed

Landed 2026-10-04. Paths in the sections above predate it.

- **`src/lib` is the engine, `src/authoring` is the sugar.** The builders,
  resource words, trigger builders, lock forms, const-name inference, and
  prebuilt steps moved to `src/authoring`. `engine.ts`, `feed/`, `state/`,
  `automation/`, `sandbox/`, `sessions/`, `schedule.ts`, `monitor.ts`,
  `observe.ts`, `harnesses.ts`, and `models/echo.ts` moved into `src/lib`,
  which now imports nothing outside itself.
- **`Engine` is a class that is handed its parts.** The four managers are
  classes (`AgentsManager`, `WorkspacesManager`, `SandboxesManager`,
  `ArtifactsManager`) with `scoped(frame)` for the view a body gets. The
  engine takes them, the catalog, the feed, automations, activities, and
  interactions through its constructor, already instanced. It replaces
  `startEngine` and the object `bindRuntime` returned.
- **`createEngine` is the Marbles assembly** (`lib/create.ts`, the old
  `bindRuntime` body). The CLI, the dashboard, and the tests call it.
- **The catalog is no longer a lib global.** `Catalog` is a class without
  bindings. `lib/catalog.ts` exports a default instance the authoring words
  fill, no lib module reads it, and the host hands it to the engine. A detector reads its host from the run scope, and
  `AutomationService` takes the catalog it registers into.
- **`@foundry/marbles/lib`** is a third public entry over `lib/index.ts`.
  `@foundry/marbles` and `@foundry/marbles/prebuilt` export exactly what they
  did before.

That was a milestone. The next one landed 2026-10-05:

## Engine over the package instances

- **The constructor takes the packages' own instances**, all required:
  `models` (`ModelManager`), `sessions` (a session store), `workspaces`
  (`WorkspaceSystem` with the directory and git layers), `containers` (or a
  function called at the first sandbox), and `artifacts` (`ArtifactManager`),
  plus `root`, `workspaceId`, `state?`, and `askable?`. The engine builds the
  four managers, the feed publisher and reader, interactions, activities,
  automations, and the orchestrator, and hands the instances back. Nothing
  is optional any more, so the refusing stand-in for a missing manager is
  gone.
- **Four optional settings carry what the instances cannot.** `print` and
  `home` are environment. `git` and `dry` are where `--dry-run` still reaches
  past the five instances: `workspaces.current.git` is built with `Git.at`
  and cannot read the runner the system's `git()` layer was given (the
  extension list is private to `WorkspaceSystem`, and loading the root to
  reach it scans the tree), and a sandboxed agent session has to be told to
  run in-process when the models are echoes. Both would go away with a small
  change in `@foundry/workspaces` and a marker on echo providers.
- **The catalog left the engine.** `lib/registry.ts` is the engine's own
  registry, written through `engine.define`, `engine.schedule`, and
  `engine.monitor` and read through `definitions()`, `schedules()`,
  `monitors()`, and `has()`. `Catalog` is `authoring/catalog.ts`, private to
  Marbles; it extends the registry with the declared workspace paths and
  resource ids. Declared workspace paths never reach the engine: they are a
  mount policy, and the host builds the containers.
- **`createEngine` is Marbles policy and lives in `src/create.ts`.** It
  detects harnesses, applies `--dry-run` (echo models, echoed git, a fake
  container runtime), builds the five instances, and copies the catalog in
  with `declareCatalog`. `readTriggers` reads the triggers from disk for
  `list` and `launchd` without building an engine, because a JSON session
  store parses every transcript when it is constructed.
- **The dashboard asks the engine**, not the catalog, for definitions,
  schedules, monitors, and the feed.

- **The managers work on the engine directly.** `engine.agents.session`,
  `engine.workspaces.current` / `.load`, `engine.sandboxes.start` / `.open`,
  and `engine.artifacts.write` / `.create` are the plain operations, usable
  without a run and before `start()`. `scoped(frame)` is the step's view over
  the same code and adds the ledger claim, the frame's signal, and cleanup
  when the run settles. A session opened directly is attributed to the run id
  `direct` on the feed and in activity, is never replayed, and is closed by
  `dispose()`.
- **A monitor is one record.** `engine.monitor({ key, source, trigger,
  handler, label? })` builds the detector step and its schedule; the
  authoring `monitor()` word collects the same record.
- **`/lib` exports the engine, types, and package classes only**: 16 runtime
  names, down from 41. Managers, automations, activities, and interactions
  are exported as types. `createEngine`, the harness helpers, `detector`,
  `tick`, `runSchedules`, `workspaceState`, and `openFeed` are no longer
  exported.

Open after this:

- **Nothing in `/lib` fires triggers.** `tick` and `runSchedules` take the
  engine and live in `lib/schedule.ts`, but they are loose functions and the
  loop that drives them is `src/run-loop.ts`. They belong on the engine.
- **The MicroSandbox runtime is not exported from `/lib`.** It is an optional
  peer whose declarations name `microsandbox` types, so how to expose it
  needs deciding.
- **`engine.bindings` and `engine.register`** are still public: the first is
  what the tests' `launch` helper runs against, the second is how the
  onboarding step registers a raw factory.

"One owner for the run lifecycle" below is still open: the engine class is
where a single lifecycle hook would live, but pause, persistence, and feed
state still react to transitions separately.

## Marbles surface today

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
| `sandbox()`, `sandboxes.start` | No `@foundry/sandbox` import in Marbles | Missing |
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
reads `ctx.resultOf(name)`. So the Marbles wrapper must: name each child Step
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
first turn. `SessionRecord` has no harness key; Marbles adds one. `generate`
returns `parts`, no `.text`. No manager class.

**workspaces.** `directory()` and `git()` are extension factories passed to
`WorkspaceSystem.extend()`, not methods. `git` is optional on a loaded
workspace (only when the path is a repo), so `workspaces.current.git` needs a
guarantee from Marbles. `withWorktree` always removes the worktree. Git is on
the `@foundry/workspaces/git` subpath only.

**sandbox.** `createContainers(...)` returns `{ start, open, restart, remove,
list, shutdown, sweep }`. Specs need `format: "foundry.sandbox.container/1"`
and `mounts: [{ id, source, target, access }]` checked against
`allowedMountRoots`. Exec is `container.commands.exec(argv)`, not
`container.exec`. A `{ files }` sandbox is an image sandbox without a
workspace mount, seeded through `container.files.copyIn`.

**artifacts.** `write({ artifactId, changes })` mutates the active version in
place and throws if frozen; `revise()` freezes and adds a new one. Entries are
`{ path: { bytes, mime? } }`. "Each run adds a version" means Marbles calls
`revise`, and maps a definition to a stable `ArtifactId`.

## Review fixes after phase 2

An external review of the migration found eight issues; seven held against
the code, one (`as never` closables in the agents manager) predated the
phase 2 frame table. Landed, one commit each:

- **A failing parallel sibling stops the run.** `driveParallel` aborts the
  run scope on the first failure and awaits every sibling before the error
  travels up; nothing executes after a run is reported failed.
- **A rejected launch registers no scope.** Input is parsed before the
  `RunScope` exists; a throwing setup removes it from the run table.
- **Launch input is parsed once.** The root node carries `parsed: true`;
  the dashboard validates for the form but hands the raw value to the engine.
- **A sandbox mounts the step's working directory.** `"."` is the worktree
  inside a worktree callback. Worktrees are cut under a marbles-owned home
  (`<state>/worktrees`, or `<tmp>/marbles/worktrees` under `--dry-run`) and the
  trusted mount roots are computed at first use from the config's directory,
  that home, and every declared workspace. This settled the declared
  workspace mount question in the API doc's favour.
- **A schema without JSON Schema keeps its launch form** as one JSON field.
- **Skill globs walk only beneath their static prefix**, so `../x/*` and
  absolute patterns resolve and nothing enumerates the filesystem.
- **Agent sessions are children of the run's session.** The run's record is
  created on the first agent a run opens; fresh agent sessions carry it as
  `parentSessionId`.
- **Lock literals are typed from the schema's input**, and a child's output
  is checked against the parent's key at the type level.

## Second review after phase 2

A second external review of phase 2 (through `1d81282`) found nine more;
all nine held. Verifying them also surfaced a regression from the first
round's parallel fix. Landed, one commit each:

- **A parallel child that parks no longer aborts its siblings.** The
  parallel driver treated a child's `SuspendSignal` as a failure and aborted
  the run scope; suspensions now pass through, the sibling finishes, and the
  parent parks with the child. Regression from `68d7431`.
- **A pause parks the subtree and waits for the attempt to stop.** Pausing a
  step aborts every live frame at or under it, a step entering under a
  paused ancestor parks at once, and resume releases every pause under the
  step. The step parks only after its attempt has settled: agent turns the
  harness committed after the abort now reject in the wrapper (`generate`,
  `stream`, and the stream's promises), so authored code cannot run on after
  the run reads as suspended. Failure and cancellation wait for the attempt
  the same way (third pass), so a slow sibling cannot act after the run
  reads as failed. A body that ignores its signal delays the report.
  Re-entry consumes the pause flag.
- **An answer is written before the run goes on.** The run file is written
  on the Orchestrator's `resumed` event as well as `suspended`, so a crash
  after an answer finds a mid-flight run (skipped with the existing warning)
  rather than a stale question asked again over work already done.
- **Adoption claims the run.** The run file is rewritten with the adopting
  pid at once, and `locks/run-<id>` (created `wx`) is held until the run
  settles or the process stops.
- **A recovered step runs with the input it was locked with.** The scope
  records every node's literal by step path when the tree is first built
  and writes it with the run; a recovered scope hands those back.
- **A monitor holds its launch until the tick has started it.** The launch
  rides in the monitor's state as `pending` and goes out again each tick
  until a start succeeds; a target that is no longer registered is
  acknowledged and fails one tick (third pass). Started is the delivery
  contract: a started run that fails, or is cancelled at an approval under
  a launchd tick, is not started again (acknowledging after success would
  relaunch it every tick).
- **A definition passed to another does not take its const's name.** The
  AST pass follows callee positions only from the call up to the
  initializer; `workflow(step().do(…)({}))` names the workflow alone.
- **A run that ends unanswered closes its question.** The router closes a
  run's open entries when it settles as anything but complete.
- **The skill no longer calls `--dry-run roll` safe anywhere.** `list` loads
  without running bodies; `roll` runs them, and `--dry-run` substitutes only
  what Marbles owns.
- **The factory is the one parser** (third pass). The dashboard launcher no
  longer validates before launching; a bad value rejects the launch at
  dispatch and the form shows that, and a transform runs once.

The reviewer's structural point stands and is listed under open items:
pause, persistence, and feed state each own a piece of the run lifecycle.

## Open after phase 2

- **One owner for the run lifecycle.** Pause (frame table), persistence
  (engine save on `suspended`/`resumed`/settle), and feed state (router
  `open` map) each react to run transitions separately. The fixes above keep
  them consistent case by case; a single lifecycle hook in the engine that
  every transition passes through would make the next case free.

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
- **`roll` at an ask prints a stack trace.** A non-askable process cancels
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
   explore.** Treat `marbles.config.ts` as source: preprocess it with a light
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
