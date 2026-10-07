## Unreleased

`@foundry/marbles/lib` is a programmatic library. A program builds an
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
* Library (`@foundry/marbles/lib`):
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

## 0.1.0 (2026-09-16)

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
