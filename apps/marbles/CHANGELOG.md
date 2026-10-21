# Changelog

## [0.0.3](https://github.com/Francois-Esquire/foundry/compare/marbles-v0.0.2...marbles-v0.0.3) (2026-10-21)


### Features

* **marbles:** add STDIO MCP dispatch and run watching ([#20](https://github.com/Francois-Esquire/foundry/issues/20)) ([e9d6e69](https://github.com/Francois-Esquire/foundry/commit/e9d6e6928e27ab4a89c9cbbc2ec7d2861af32a0e))
* **prompts/vscode:** Editor and lint tooling for prompts: VS Code extension ([#11](https://github.com/Francois-Esquire/foundry/issues/11)) ([f561598](https://github.com/Francois-Esquire/foundry/commit/f561598fd1bcf318a008ef21154522065720d02c))

## [0.0.2](https://github.com/Francois-Esquire/foundry/compare/marbles-v0.0.1...marbles-v0.0.2) (2026-10-17)


### Features

* **models:** add Pi harness support ([fd1b104](https://github.com/Francois-Esquire/foundry/commit/fd1b104dde8a876d10d449af18f70c5872d59ddf))


### Bug Fixes

* **models:** use the community Pi AI SDK provider ([e11444a](https://github.com/Francois-Esquire/foundry/commit/e11444ac2f2646efcee21fbbbf5505c3c46f4dac))

## 0.0.1 (2026-10-14)


### ⚠ BREAKING CHANGES

* **marbles:** Import @foundry.sh/marbles, @foundry.sh/marbles/lib, and @foundry.sh/marbles/prebuilt instead of the old @foundry/marbles paths. The first alpha remains version 0.0.1.
* **marbles:** artifacts pass versions, reads, and provenance through
* **marbles:** sandbox handles pass the container through
* **marbles:** workspace handles pass the package Workspace through
* **marbles:** An agent's id is its name, else the const it is bound to, else agent-<digest of prompt, provider and model>; it was its registration order (agent#N). Grants approved for future runs under agent#N no longer match: approve again when asked. Triggers an agent created keep firing but leave its list_automations; pause or delete them from the dashboard, or set owner.agentId in the automation record. Two different agents with one id now fail at import. WorkflowRecord.tree is removed; a static tree is a setup that returns it. A workflow is only ever a run root. HarnessInteractions.registerSession takes the authority returned by authority(), and HarnessActivities.attach returns the session to use. createSession with an existing id returns that session unchanged.

### Features

* **prompts:** add harness prompt dialects with live reference checks ([#10](https://github.com/Francois-Esquire/foundry/issues/10)) ([2fcbfa6](https://github.com/Francois-Esquire/foundry/commit/2fcbfa6071cc63b35dea9ffeffde5a6fde345cf6))
* **release:** centralize package assets and linked library versions ([7842d1d](https://github.com/Francois-Esquire/foundry/commit/7842d1dfc79b5ace5ad4fea3aa629abab03deb71))
* **agents,marbles:** pass structured output and model settings through agent turns ([10924f1](https://github.com/Francois-Esquire/foundry/commit/10924f1b907d0693b1b63505456a895ecd9345fb))
* **agents:** export capability schemas and session record builders ([08178cd](https://github.com/Francois-Esquire/foundry/commit/08178cd264c3d381411bade32f88959d9dfe95f2))
* **artifacts:** add JSON artifact store ([ad9bd84](https://github.com/Francois-Esquire/foundry/commit/ad9bd84e3ffcdca3b0737ed2c158d0c09c3ac16b))
* **artifacts:** add versioned artifact storage package ([4e6f196](https://github.com/Francois-Esquire/foundry/commit/4e6f19672622e81ead83f3e111f895c2662b82ee))
* **spyglass:** add spyglass apply ([cba611e](https://github.com/Francois-Esquire/foundry/commit/cba611e3419a572b2e25ed27ae583ee81047e32c))
* **spyglass:** add the library serve and retire the second server ([630af14](https://github.com/Francois-Esquire/foundry/commit/630af140ddc6642f504958272f4a27fdf1929303))
* **spyglass:** harden the mutator and preview an authorized plan ([4aa6b2a](https://github.com/Francois-Esquire/foundry/commit/4aa6b2a337f5a5ffc0fab52e61efd329b83f1b51))
* **spyglass:** lock the state directory and keep a workspace record ([9408044](https://github.com/Francois-Esquire/foundry/commit/94080446cf2367207af2d495ea81dbf6da253401))
* **harness:** run coding agents in MicroSandbox ([1ef0f4f](https://github.com/Francois-Esquire/foundry/commit/1ef0f4f0e4be5bd819438513a6681687c440ec60))
* **lib:** file-backed grant repository on the reference transitions ([a99b276](https://github.com/Francois-Esquire/foundry/commit/a99b27654c4a517ebb943640b5c2925e5d28c46f))
* **marbles,agents:** skill files as bytes, skills defined in code, skills.none() ([858dd3a](https://github.com/Francois-Esquire/foundry/commit/858dd3a3eec046c4057d60591f7a89736f4162c2))
* **marbles,lib:** command steps and a body's exec ([aa34e6d](https://github.com/Francois-Esquire/foundry/commit/aa34e6d97ebb16e88eb716653456b48da1132c1c))
* **marbles:** artifacts pass versions, reads, and provenance through ([e736b5d](https://github.com/Francois-Esquire/foundry/commit/e736b5d9244cc5ab723a4b6a313593af25021df2))
* **marbles:** artifacts.latest, memory between runs ([e74400d](https://github.com/Francois-Esquire/foundry/commit/e74400d71259af9b2730f31d987010396bc8269f))
* **marbles:** discover workspace modules and initialize starters ([a9fd994](https://github.com/Francois-Esquire/foundry/commit/a9fd994f7720cf67a6d9aad1ca8533152f91df2e))
* **marbles:** load a workspace .env.schema before modules, ticks run in the root ([a98afc2](https://github.com/Francois-Esquire/foundry/commit/a98afc243f0ecc85ea198b62538064b8b8a24468))
* **marbles:** make agent, step, and workflow definitions usable ([a6ab8a4](https://github.com/Francois-Esquire/foundry/commit/a6ab8a480c78c750498c75595a47ccc5b8ce1e1d))
* **marbles:** make workspace, sandbox, and artifact definitions usable ([6808ea0](https://github.com/Francois-Esquire/foundry/commit/6808ea03df79e37a933022b8bb30f0285dba9755))
* **marbles:** rename public package to [@foundry](https://github.com/foundry).sh/marbles ([d85d06c](https://github.com/Francois-Esquire/foundry/commit/d85d06c47ad12085bda5780994c8fccfc890d3d9))
* **marbles:** request options for HTTP monitors ([daeab1e](https://github.com/Francois-Esquire/foundry/commit/daeab1e69b1b5efcb43a63e4343c66988bad771d))
* **marbles:** sandbox handles pass the container through ([4d8026a](https://github.com/Francois-Esquire/foundry/commit/4d8026a13b12fa2909eb4c4fb674d59a954989ef))
* **marbles:** step retry and timeout, and bail ([59edd62](https://github.com/Francois-Esquire/foundry/commit/59edd627382db6471317b4c1dde0da2eeeb29272))
* **marbles:** workspace handles pass the package Workspace through ([af4958f](https://github.com/Francois-Esquire/foundry/commit/af4958ff100f9b6473152ca770c698c52cf23a84))
* **quirks:** add child agents and durable automation ([6b4dea1](https://github.com/Francois-Esquire/foundry/commit/6b4dea1b864d5b670c83e94c001f721564acdda0))
* **quirks:** copy app and supporting packages ([addb1fb](https://github.com/Francois-Esquire/foundry/commit/addb1fb5915f248201caba4f714f4dfa449e3401))
* **release:** prepare independent releases and gated npm publishing ([bd33566](https://github.com/Francois-Esquire/foundry/commit/bd3356662761d8e36d4c187e26a69a82c56357fd))
* **sandbox:** add portable sandbox package and integration coverage ([b8f0f5b](https://github.com/Francois-Esquire/foundry/commit/b8f0f5b6ea7e2c32fe0b6ae0902cbc7ce7fdeb0e))
* sync agent composition and workspace file creation ([7a2f752](https://github.com/Francois-Esquire/foundry/commit/7a2f752d86372eac6df74353ab4d0823bac52eb5))
* **workflows,quirks:** run streams with replay and path-scoped chunks ([5e988a8](https://github.com/Francois-Esquire/foundry/commit/5e988a8ee9f4bb876cec55faf16237adf5081d49))
* **workspaces:** adopt shared storage entries and align Quirks ([d936e5c](https://github.com/Francois-Esquire/foundry/commit/d936e5c8b333acd3742a869c1708f6eb91318b81))
* **workspaces:** drive Quirks monitoring through workspace change events ([31d7375](https://github.com/Francois-Esquire/foundry/commit/31d73756b5d1b4ffadbfdc09881454a83bdd716f))
* **workspaces:** support filesystem-resolved sources and load references ([8a20bfe](https://github.com/Francois-Esquire/foundry/commit/8a20bfed18fa3a44231feb7c17eede9b96e6d687))


### Bug Fixes

* **marbles:** unify execution and harden runtime lifecycle ([5a59f1e](https://github.com/Francois-Esquire/foundry/commit/5a59f1e2aecaae346981bbac5e022d9027e086fa))
* **agents:** resume a session created again and export session enums ([41fa124](https://github.com/Francois-Esquire/foundry/commit/41fa124c30803d185d671e6ddd9e7699a6fbb3d6))
* **agents:** settle abandoned streams and close review gaps ([6c8a17f](https://github.com/Francois-Esquire/foundry/commit/6c8a17fde778509276da0a975135fb520cc5907f))
* **ci:** avoid expensive buffer assertions and retain bundled model types ([81b5790](https://github.com/Francois-Esquire/foundry/commit/81b579091fc1b4df7b80da81a416525370815a34))
* **ci:** bound nested test workers and isolate package suites ([8e1642b](https://github.com/Francois-Esquire/foundry/commit/8e1642b0b4870a86a7f862caa942655d29b4a567))
* **ci:** bound test concurrency and budget consumer compilation ([07b577f](https://github.com/Francois-Esquire/foundry/commit/07b577faaac343f33ad78b55be6319015267c3b2))
* **knip:** make workspace dead-code check pass ([30e4752](https://github.com/Francois-Esquire/foundry/commit/30e475297d249ba18916351a99e2873f59771579))
* **lib:** harden the file lock against wedges, stray releases and racing breakers ([d249694](https://github.com/Francois-Esquire/foundry/commit/d249694d93ab37e8ec5a49a675993d463833b243))
* **lib:** share the queue and lock, pin grant schemas, flush directories ([6b9def0](https://github.com/Francois-Esquire/foundry/commit/6b9def0ae82b2af587869dff71ecf59c6526f10f))
* **marbles,workflows:** one-line errors for bad input and a roll at an ask ([a70542c](https://github.com/Francois-Esquire/foundry/commit/a70542c5dd84738ca44265b850a478db04ecf1f1))
* **marbles,workspaces:** worktree defaults everywhere, replayed creates, hasBranch ([830ca17](https://github.com/Francois-Esquire/foundry/commit/830ca17d48d89359187a072df9435c2ad0c72cf6))
* **marbles:** fail a step whose result is not JSON instead of hanging ([c97bb1b](https://github.com/Francois-Esquire/foundry/commit/c97bb1bd173dce962af09cddcdbc5099ed8cba1e))
* **marbles:** harden run lifecycle and session contracts ([5fe38ac](https://github.com/Francois-Esquire/foundry/commit/5fe38acecab7f911bb19e764d2cf8178a07bd9ec))
* **marbles:** map the types build from package exports ([b33f6e9](https://github.com/Francois-Esquire/foundry/commit/b33f6e9302154a764ec384ec683e19c7afa490bf))
* **marbles:** never overwrite an unreadable session file ([1571a3e](https://github.com/Francois-Esquire/foundry/commit/1571a3e099539cbe0816325f99af39b62d95cb7b))
* **marbles:** reject zero cadences and carry launchd flags through dry runs ([8e386f1](https://github.com/Francois-Esquire/foundry/commit/8e386f10058575da6ac99c65761face4408964bc))
* **models:** export every runtime module the docs promise ([9a52994](https://github.com/Francois-Esquire/foundry/commit/9a52994d6eae031ae6cb993454ba522bb9b1fcb2))
* **models:** keep kind defaults in step with registration ([eb7a768](https://github.com/Francois-Esquire/foundry/commit/eb7a768c4bbd50b6dac3badcd9962d564f5d4e62))
* **models:** validate settings where they enter and keep defaults across re-registration ([539da34](https://github.com/Francois-Esquire/foundry/commit/539da344efdab9ab34d967809fa345d9bd468cbd))
* **models:** validate the kind defaults settings route by ([588781e](https://github.com/Francois-Esquire/foundry/commit/588781e5f55e58c312fac6aa8183afa2888dc7dc))
* **sandbox:** resolve every process cwd alike, apply registry config, unify errors ([3ba0ce0](https://github.com/Francois-Esquire/foundry/commit/3ba0ce0ee639bdf0ef803a501f450a95ace23bc6))
* **workspaces:** refresh source after pending watcher scans ([2394604](https://github.com/Francois-Esquire/foundry/commit/2394604f42e440d5c4192e3a4aefe50e617da309))


### Documentation

* **marbles:** document the programmatic engine, agent identity, state and locks ([06332ba](https://github.com/Francois-Esquire/foundry/commit/06332ba3738806005b99068c9fd438d677271e3f))

## Marbles changelog

The first planned release is **0.0.1 (alpha)**. Every `0.0.x` release may
introduce breaking changes. `0.1.0` is the first supported API milestone.
Release Please prepares package-specific entries from Conventional Commits.

## Unreleased

`@foundry.sh/marbles/lib` is a programmatic library. A program builds an
`Engine` from explicit instances, then drives and inspects it without the
CLI, the dashboard, or the authoring words; the engine owns its run scopes and
its trigger state. The Marbles CLI and dashboard are one host on top of it.

### Breaking changes

* **Agent ids.** An agent's id was its registration order (`agent#1`,
  `agent#2`, …). It is now the `name` you give it, else the top-level `const`
  the `agent({...})` call is assigned to, else `agent-<digest>` (the first 16
  hex digits of a SHA-256 of its prompt, provider and model). Tool grants
  approved "for future runs" and the triggers an agent creates are filed under
  this id, so records written under `agent#N` no longer match any agent:
  * The next run asks again for each tool it had a grant for. Approve it again.
    The old `agent#N` grants in `agent-grants.json` are inert. Do not edit that
    file by hand, because the grant store refuses an entry whose address does
    not match its subject.
  * Triggers created by agents keep firing, but their agents no longer list or
    manage them. Pause or delete them from the dashboard (select the trigger,
    then `p` or `k`). To hand one back, set `owner.agentId` in
    `<state>/<workspace-id>/automations/<id>.json` to the agent's new id; the
    record stays with the session that created it.
  * Two different agents that resolve to the same id fail at import with
    `agent "<id>" already declared (<file:line>) with a different prompt or
    route (<file:line>); rename one or name it explicitly`. Declaring the
    same agent twice (same prompt and route) is allowed.
* `WorkflowRecord.tree` is removed and `WorkflowRecord.setup` is required. A
  static tree is a setup that returns it.
* `Shared.inferred`, `Shared.site` and `Shared.uninferable` are replaced by
  two host-supplied strings: `origin` (where the definition was declared,
  quoted in messages) and `nameHint` (how to name a nameless definition).
* A workflow cannot be a child in another tree. Locking one as a child throws
  `child "<key>" is a workflow; a workflow can only be the root of a run`, and
  a setup that returns such a tree fails before any of it runs.
* `HarnessInteractions.registerSession(session, authority)` takes the
  `SandboxAuthority` that `authority()` returned, and only that object
  registers a session as durable. `HarnessActivities.attach(sessionId,
  session, { delegated? })` returns the session to hold and close.
* `createSession` with the id of an existing session returns that session
  unchanged, history included, instead of replacing it. This holds for
  Marbles' `JsonSessionStore` and for `InMemorySessionStore` in
  `@foundry/agents`.

### Fixed

* A zero cadence (`"0s"`, `"000m"`) or one past `Number.MAX_SAFE_INTEGER` is
  refused by `schedule().every/at`, `monitor().every` and agent-created
  automations.
* `launchd install` passes `--artifacts` and each `--harness` to the scheduled
  `roll`. Under `--dry-run`, `launchd install` prints the plist path and
  contents and the `launchctl` commands, `launchd uninstall` prints the
  `launchctl bootout` command and the plist it would remove, and neither
  changes anything.
* `--dry-run` persists nothing: no sessions, runs, grants, approvals, agent
  triggers, or heartbeat.
* Names inferred from a `const` (steps, workflows and agents) are read from
  the formatted stack, so they are correct under loaders that transpile
  (vitest, tsx, source maps).
* `JsonSessionStore` re-reads the session file for every operation. Each
  change is a read-change-write under a per-session lock file
  (`sessions/<id>.json.lock`), so two processes no longer lose each other's
  messages. A session file that cannot be read is skipped with a warning and
  never overwritten. Changing that session throws and asks you to repair or
  remove the file.
* Schedule, run and automation-edit locks (`<state>/<workspace-id>/locks/`)
  and session locks share one protocol:
  * A lock whose holder has exited is taken over, one process at a time,
    through a transient `<lock>.break` file. If a crashed process leaves a
    `.break` file behind, nobody takes that lock over until it is removed.
  * A lock file left empty (its creator died before writing its pid) is broken
    after 30 seconds. Until then, `roll` prints `held by a process that is
    taking it now; retry`.
  * A lock file that is neither a pid nor empty is never removed. `roll`
    prints `held by an unknown process (if none is running, remove <path>)`.
  * Releasing a lock never removes a lock another process has taken since.
  * Lock files are created with mode `0o600`.
  * A skipped tick prints `skipped: held by <holder>`. The automation edit
    lock's error names the holder.
* The dashboard shows "Waiting for approval" and "Waiting for answer" in the
  warning color. `s`, `p` and `k` follow the selected run's status: steer
  and pause while running, resume while paused, cancel only an unsettled run.
* The dashboard shows errors as their message, without an `Error:` prefix.

### Changed

* The CLI rejects a bad command line before it loads any module or touches
  state. This covers an unknown command, wrong positionals (`roll a b`, a
  name after `run`, extra arguments to `list`, `status` or `sessions`, an
  unknown starter) and an unknown `--harness` id. The message and usage go to
  stderr and the exit code is 1. `--help` wins over everything else on the
  line.
* `status` and `sessions` find the workspace without executing its modules.
  They no longer print a `[source]` line, and they work when a module is
  broken.
* Only a run that persists writes `workspace.json` (`run`, `roll`, and the
  dashboard after Enter, never under `--dry-run`). `list`, `launchd`,
  `sessions` and `status` leave the state root as they found it.
* `list` prints triggers that agents created as monitors:
  `[monitor] <key> <source> <cadence>`, not `[schedule] … → __automation_monitor`.
  Cadences read `every 1h`, `daily at 09:00`, or `mon, fri at 09:00`. Config
  schedules come first, then config monitors, then triggers that agents created.
* Automation errors are keyed by automation id, not by file name.
* An engine without a state dir now takes real schedule locks: ticking one
  key twice at once gets `skipped: held by this process`, as a second process
  would.
* The setup screen lists Claude Code before Codex, which is also the order
  used to pick the first available harness.
* Dashboard footer:
  * `p pause` and `p resume` are separate hints.
  * `l launch` shows only on definitions, and `b run` only on steps and
    activities.
  * While typing, the bottom line lists only `Ctrl+C quit`.
  * The search and prompt lines read `Type to search · Enter apply · Esc
    clear` and `steer · Enter send · Esc cancel`.
* Esc or `h` from empty details returns to the list you were on.

### Added

* `agent({ name })` gives an agent an explicit, durable id.
* Library (`@foundry.sh/marbles/lib`):
  * `EngineOptions.store` and `engine.store`. Pass a `StateStore` for trigger
    history, monitor observations and agent-created triggers, with the locks
    that keep two ticks apart. By default the engine uses a `JsonStateStore`
    over `state`, or an `InMemoryStateStore` without `state`. Also exported:
    `StateStore`, `StateCollection`, `StoredDocument`, `JsonStateStore`,
    `InMemoryStateStore`, `Lock` and `HeldLock` (`holder` says who has the
    lock). Store keys and lock names must be plain names.
  * `EngineOptions.workspaces` is optional. Without it the engine builds a
    watched workspace system over the local filesystem whose `git()` layer
    uses the `git` option.
  * `EngineOptions.worktrees` and `Engine.worktreesFor(state)`, the default
    place worktrees are cut.
  * `engine.scopes`, a `ReadonlyRunScopes` view (`get`, `has`, `size`,
    iteration) of the live runs' `RunScope`s.
  * `SandboxesManager.containerOf(sandbox)` returns the container behind a
    sandbox this engine opened.
  * `CLI_HARNESS_IDS` (in preference order) and `CLI_HARNESSES`, the single
    description of each CLI harness. Types: `CliHarness`,
    `CliHarnessDescriptor`, `GuestArchitecture`, `GuestArtifact`,
    `GuestAuth`, `GuestFile`.
  * `TERMINAL_RUN_STATUSES`, the run statuses that are settled.
  * Types `NamedDefinition`, `SandboxAuthority` and `JsonSessionStoreOptions`.
    `new JsonSessionStore(dir, { warn })` reports skipped files.
* Packages bundled into Marbles:
  * `@foundry/lib/atomic-file`: `writeFileAtomic` (exclusive temp file and
    rename, optional mode and fsync of the file and its directory),
    `readJsonFile`, `hasErrorCode`.
  * `@foundry/lib/file-lock`: `tryFileLock`, `acquireFileLock`,
    `withFileLock`, `lockHolder`, `processAlive`, `FileLockTimeoutError`. The
    protocol above (`FileLockHolder.empty` marks an empty lock).
  * `@foundry/lib/keyed-queue` (`KeyedQueue`) and `@foundry/lib/exactly`
    (`Exactly<Output, T>`).
  * `@foundry/lib/config/authorization/file`: `FileGrantRepository`, a
    file-backed grant repository generic over subject and capability schemas.
    `config/authorization/grant-state` holds the grant transitions it shares
    with the in-memory repository.
  * `@foundry/agents/authorization`: `capabilitySchema` and
    `agentSubjectSchema`.
  * `@foundry/agents/session`: `newSessionRecord`, `patchSessionRecord`,
    `newSessionMessage`, `patchSessionMessage`, and `SESSION_ROLES`,
    `MESSAGE_STATUSES`, `SESSION_STATUSES`.

## Historical repository notes (2026-09-16; unpublished)

### Features

* adapters ([852c0cf](https://github.com/Francois-Esquire/foundry/commit/852c0cfad0534e96cd88d5e6b896518b617638b7))
* add memory and examples ([de0e0e1](https://github.com/Francois-Esquire/foundry/commit/de0e0e17af6e65e3304e04d8479cd8aacc008d20))
* **agent:** cleaner agent framework ([d085d35](https://github.com/Francois-Esquire/foundry/commit/d085d356a64ec13ba1869c23093782d2dd0e28ef))
* **cli:** add command line app ([625a67a](https://github.com/Francois-Esquire/foundry/commit/625a67ab6b8711384e43b316919f2603392efbfd))
* create artifacts ([1e82dae](https://github.com/Francois-Esquire/foundry/commit/1e82dae0fff7d7c33e25c5b1b9074a32c3be762b))
* **detector:** add detector/analyzer ([814b33d](https://github.com/Francois-Esquire/foundry/commit/814b33dda04f139240edf0fc76f9961b76d3f7ac))
* **memory:** add knowledge ([3b37f85](https://github.com/Francois-Esquire/foundry/commit/3b37f85843407e3abb0c8aca4b90375f2a4bdcea))
* **memory:** added memory server ([2442ab0](https://github.com/Francois-Esquire/foundry/commit/2442ab075fc498bf106c7b786bd75f3e00eda813))
* modules in place ([77e8cc9](https://github.com/Francois-Esquire/foundry/commit/77e8cc92e5abc0d99b12c2b4673b90b4a8306d9e))
* **quirks:** copy app and supporting packages ([addb1fb](https://github.com/Francois-Esquire/foundry/commit/addb1fb5915f248201caba4f714f4dfa449e3401))
* **tests:** prototype introspection ([f05ac06](https://github.com/Francois-Esquire/foundry/commit/f05ac065131d06840a295db16bf7e3d6ea4cfed2))
