# Quirks rebuild: gap map

Maintainer note, excluded from the Blume site. Roadmap step 2.1: what exists
today against [`_api-alt.md`](./_api-alt.md). Surveyed 2026-09-25. Paths are
under `apps/quirks/src` and `packages/`.

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
`container.exec`. `{ files }` exists only on the in-memory virtual system.

**artifacts.** `write({ artifactId, changes })` mutates the active version in
place and throws if frozen; `revise()` freezes and adds a new one. Entries are
`{ path: { bytes, mime? } }`. "Each run adds a version" means Quirks calls
`revise`, and maps a definition to a stable `ArtifactId`.

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
