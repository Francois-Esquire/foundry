# Marbles packaging

The declaration build combines all public entries and needs an 8 GB Node heap
budget. The package's build script sets it for tsup only; runtime processes
keep their normal heap settings.

Marbles is published as a standalone package. Its build inlines the Foundry
workspace packages, but leaves third-party imports external. Keep their
third-party runtime dependencies in this package's `dependencies`, even when
Marbles source does not import them directly or a build tree-shakes a path.
Optional features may use an explicitly declared optional peer dependency.

Knip cannot trace those bundled imports back to this manifest. Keep its
`apps/marbles` dependency exceptions limited to this packaging case. Before
removing one, inspect the build and run
`bun run test:package` from this directory; the package test installs the
tarball in an isolated consumer and exercises the CLI.

The CLI provider adapters and Anthropic SDKs are optional dependencies.
Provider discovery and execution load their adapters on demand. Keep
`@anthropic-ai/sdk` pinned when it is installed to satisfy the Claude Agent
SDK peer requirement. Pi also depends on an older SDK, so relying on peer
hoisting can select an incompatible version in a fresh standalone install.
`@modelcontextprotocol/sdk` is a runtime dependency: `marbles mcp` serves
MCP over STDIO with it, and it also satisfies a required Claude Agent SDK
peer.
The `evlog` exception covers imports in the bundled models and workflows code.
The `@ai-sdk/mcp` exception covers the bundled agents MCP client, which
connects the MCP servers an agent's definition names; its version follows
`packages/agents`.
The bundled Usage package loads `@anthropic-ai/claude-agent-sdk` when reading
Claude login limits. Keep its version aligned with `@foundry/usage`.
The `@ai-sdk/provider` exception covers model types referenced by the published
declarations; those generated imports are absent in a fresh checkout.
The `@foundry/core` development dependency supplies transitive pagination types
to the declaration bundler through the explicit mappings in `tsup.config.ts`.

# Marbles source layout

Five buckets, each importing only what sits below it:

- `src/lib/` is the engine and imports nothing outside `src/lib/`: no
  authoring words, no views, no CLI. The `Engine` constructor takes the
  packages' own instances (models, session store, containers, artifact
  system, all required; a workspace system, which it builds from its `git`
  option when omitted; and a store for each thing it keeps, each in
  memory without one: `RunStore`, `ExecutionStore`, `TriggerStore`,
  `AutomationStore` and `UsageStore`) and builds the managers and everything that
  connects them itself. It owns its run scopes and its trigger state; no
  module global holds either. The workspace's tasks reach it through
  `records` (`lib/events/records.ts`): the host hands in the database's
  (`database/tasks.ts`), and without one the `lib/` class keeps them in
  memory, whatever `state` is. The class the package publishes is
  `entries/engine.ts`, a tier above `lib/` and `database/`: given `state`
  and not `dry` (`Engine.persistence`, the one rule for where any engine
  persists, which a dry engine does nowhere), it keeps every store it is
  not handed in the database, over one handle
  (`withWorkspaceDatabase` in `database/managed.ts`). Each manager has the plain operation as a
  method, usable on the engine directly, and `scoped(frame)` for the view a
  step body gets, which adds replay, cancellation, and cleanup on top; new
  manager behavior goes in the plain method. The engine owns its registry
  and is told what can run through `define`, `schedule`, `monitor`, and `task`. Every launch goes through
  `lib/launcher.ts`, which owns queue admission, host tasks, and live runs.
  `lib/executions.ts` owns durable execution records and retention; they
  are kept in an `ExecutionStore` (`lib/execution-store.ts`), each change
  written in the order it was made, and a step that reads and decides
  across processes in one store transaction. Agent-created triggers are
  kept in an `AutomationStore` (`lib/automation/store.ts`) and usage facts
  in a `UsageStore` (`lib/usage-store.ts`). Agent grants are one validated
  document in a `GrantDocumentStorage` (`@foundry/lib`), deferred approvals
  are kept in a `DeferredApprovalStore` (`lib/sandbox/deferred-approvals.ts`)
  and harness activities in an `ActivityStore` (`lib/sandbox/activities.ts`),
  each in memory without one. Which engine delivers a workspace's
  changes is a claim its `records` grant (`claimDelivery`, the
  `DeliveryLease` seam); `lib/events/delivery.ts` hands each observer,
  known by workspace, source and name, the facts of its source from the
  change log (`lib/events/log.ts`), in order, from its own place. Provider
  configuration, the machine's and each workspace's, and the identity key
  are kept in a `ProviderStore` (`lib/providers/store.ts`); the
  configuration reads it when the engine starts (`refresh`), not when it
  is built.
  `lib/held-runs.ts` follows held workflow runs to their end;
  `lib/run-store.ts` is where their Runs are kept (`RunStore`, in memory
  by default), and `lib/run-recovery.ts` is the one rule for which parked
  Runs a starting engine adopts and which Runs a gone process left it
  closes out. `lib/crash-recovery.ts` is the one entry point that puts
  right what a crash left, run once per start after the launcher settles
  the Execution Runs of exited processes and before the host schedules
  anything; each part's rule is its own package's or module's, and it
  only orders the calls (orphaned children, container rows, Runs,
  harness activities, artifact files), and keeps what each step did for
  `marbles status` (`RecoveryReport`, in `marbles_recoveries` through
  `database/recoveries.ts`). Every owner Marbles records, of a claim, a
  Run, an Execution Run, a container row, a lock or a background child,
  is a `ProcessIdentity` (`@foundry/lib/process-identity`, pid and start
  time), judged gone only by `isGone`, and never while a write
  transaction is open: a claim judges its row's owner first and, in the
  transaction, only checks it is still that owner (`claimJudged` in
  `database/owner.ts`, which maps a claim row's owner columns to and from
  a `ProcessIdentity`).
  Each engine has an execution context (`lib/execution-context.ts`): its
  workspace id, where its work starts (`cwd`, the root by default) and the
  environment its commands inherit. Every place the engine calls code an
  author wrote runs it as that context (`withinContext`, which leaves a
  run scope inherited from another engine's run): a step's whole
  execution, schemas and body (`tree.ts`, `materialize`), its retry
  decision, a launch's input schema and a workflow's setup (`factoryFor`),
  a host task's body (`launcher.ts`), each observer (`Delivery`), every
  session the agents manager opens, whichever entry opens it
  (`openSession`: an agent's own function, and each turn's output
  schema, stop conditions and harness authority, approval and question
  callbacks), and a worktree callback outside a run
  (`managers/workspaces.ts`); whatever that code starts inherits it. Nothing in `lib/` reads
  `process.cwd()` or `process.env` for it.
  `lib/cli-harnesses.ts` describes each CLI harness once (ids in
  preference order, executor, guest artifact and environment). Provider
  plugins (`lib/providers/plugins.ts`) build instances from configuration
  (`lib/providers/configuration.ts`), and the sandbox reads their execution
  facets.
- `src/database/` is the Marbles database: one SQLite file at the state
  root, `<state>/marbles.db`, that every process on the machine opens at
  once. `open.ts` has one way in per role: `initializeDatabase`, for
  whoever holds the state root's process lock (the Marbles process for its
  lifetime, any other writer of a workspace's state only while it makes
  the database current, through `openHostDatabase` and `writeAsHost` in
  `workspaces.ts`), creates it (WAL, busy timeout, foreign keys) and
  migrates it; `openDatabase` (a handle kept open, as a host keeps one) and
  `writeDatabase` (one piece of work) write only to a file that is there
  and current; `readDatabase` reads through a read-only connection and never
  creates the database file, migrates it, or changes its content. It
  makes no side file either, but for one narrow race, described on
  `readDatabase`, that can leave an empty WAL file and its shared-memory
  file, which hold nothing and which readers and writers pass over. A
  reader opens the shared-memory file read-write: SQLite maps it once per
  process, so a read-only mapping would refuse this process's writers. `client.ts` makes everything this
  process does on the file take turns, keyed by the file's device and
  inode (a link or another spelling of its name shares the queue), since
  the native driver blocks the thread while it waits for a lock. Nothing
  may open and close the database file or its side files outside SQLite:
  closing any descriptor to it drops this process's locks on it;
  `migrate.ts` applies the migrations in `migrations/` in one write
  transaction, and refuses an applied history that is not an exact prefix
  of the shipped one. `migrations/` is generated and not in source:
  `bun run db:generate` (`drizzle.generate.ts`) writes one migration,
  `0000_init`, that creates every table, and the build and the test run
  both call it first. No release has shipped a database, so there is no
  earlier migration to build on; a database made before a table changed
  is refused, and is deleted by hand. `schema.ts` composes every table,
  Marbles' own (`tables.ts`) and each domain package's
  `@foundry/<pkg>/store/tables`, one `export *` line per package. Marbles' own
  stores sit beside the tables (`workspaces.ts`, the workspace registry,
  which leaves out any workspace whose `<state>/<id>` is a link, for every
  reader alike), `changes.ts`, a workspace's change log: every change
  fact any of its stores commits (`marbles_changes`), at the next
  position of the workspace's counter (`marbles_change_logs`, never
  reused, compaction or not), with the run that made it, and each
  observer's place (`marbles_observers`). Every store below records its
  facts there through one `ChangeRecorder` per workspace, called by the
  store's `onCommit` hook on the transaction it is handed, so a change
  and its facts commit together; the recorder notes the causing run when
  the store is handed the write (`causing`), and wakes delivery in this
  process. `tasks.ts` is a workspace's tasks: the package's
  `SqliteTaskStore` scoped by the workspace id, and the records
  (`DatabaseWorkspaceRecords`) that own the workspace's recorder and log.
  `sessions.ts` is a workspace's agent sessions the same
  way: the package's `SqliteSessionStore` scoped by the workspace id, whose
  `onCommit` hook raises each session's row in `marbles_session_revisions`
  and records its facts,
  the listing usage recovery, `marbles sessions` and `status` read. A row
  exists only for a session record put; a commit that puts messages first
  reads, through a view of its own transaction, the session each leaves,
  and puts that record again so it is raised too. Nothing reads the
  package's tables directly. `stores.ts` is a workspace's artifacts,
  sandbox containers and workspace catalogue: each package's SQLite store
  scoped by the workspace id, handed over as the package makes it, with
  the recorder's hook alone, but the artifact store's, which also removes
  a deleted artifact's shares, as the run store's does a Run's; each
  container row names its holder itself, which Marbles makes its process
  identity (`lib/sandbox/holders.ts`), so a start takes back the rows a
  gone process left. `artifact-links.ts` (`keepingLinks`, over
  `followingCommits`) follows the engine's artifact commits, after they
  land, nested transactions included, to keep each linked workspace's
  links (`links.ts`) current, and the engine `createEngine` builds over it
  drains those updates (`drainLinks`, giving up after a bound only what
  waits: updates not begun, or waiting for a links lock) once disposed,
  before its host closes the database; `links.ts` is the one routine a rebuild and
  an update share, which reconciles disk with the database under
  `.marbles/.lock`, reading the database there, and checks each directory
  (`lstat` and `realpath` inside `.marbles`) right before each change and
  again after each creation; a writer in the workspace can still win the
  window between a check and a call. `keepingLinks` refuses a host-bound
  store. Shares are checked and written in one transaction
  (`associationTransaction`). Artifact blob files stay on disk, under
  `<artifacts>/workspaces/<id>/blobs`; `readArtifacts` is the read-only
  view of them a dry run reads through to. `runs.ts` is a workspace's workflow Runs: the package's
  `SqliteWorkflowStore` scoped by the workspace id, whose `onCommit` hook
  files beside each Run it puts Marbles' row in `marbles_workflow_runs`,
  what the run's scope recorded and the engine that owns it, so a parked
  run is adopted by the next process that can answer it; a claim on a Run
  is a transaction on that row, not a lock file. Each run's output stays
  a log file on disk, `<state>/<id>/output/<run>.jsonl`. `triggers.ts`
  is a workspace's trigger state: each schedule's and monitor's last tick
  and each monitor's state by the trigger's key, and the claim that keeps
  two ticks of one trigger apart, a transaction on the tick's row.
  `executions.ts` is a workspace's Execution Runs: each record a row of
  `marbles_executions`, its lifecycle changed only from a status the
  change allows and by the owner it names, and its progress patched only
  while it is unsettled (`ExecutionStore`); each
  observation a row of `marbles_execution_observations`, so recording one
  costs the same however many its run has; and what pruning removed,
  `marbles_execution_gaps`. The run store's `onCommit` hook writes a
  workflow's Execution Run there too when its Run parks or resumes, so the
  two land together. `automations.ts` is the triggers agents created, one
  row of `marbles_automations` each, an edit a transaction that reads
  first; `usage.ts` is each agent turn's usage fact, a row of
  `marbles_usage_facts` by turn. `grants.ts`, `approvals.ts` and
  `activities.ts` are a workspace's agent grants (one document the grant
  repository validates), deferred approvals (one document) and harness
  activities (a row each, replaced only by a higher revision); the
  workspace's records (`tasks.ts`) keep who delivers its changes in
  `marbles_delivery_claims`, a claim a transaction on that row, as tick
  claims are. `providers.ts` is the machine's provider configuration, a row
  per scope with a revision the configuration's watcher polls, and the
  identity key; `DatabaseProviderStore.forState` is the same for a
  process that keeps no handle open. Its settings may hold secrets: `initializeDatabase` keeps
  the database file and its side files mode 0600, and nothing the provider
  store throws quotes a setting.
  `associations.ts` keeps which workspaces other than its owner each
  resource is shared with (`marbles_resource_workspaces`), under the rules
  `ResourceAssociations` in `lib/resources.ts` states; `resources.ts`
  (`ResourceView`) is what a workspace shows of the resources every
  package store keeps, its own and those shared with it, or every
  workspace's, each read through its owner's package store. `status`, the
  resource listings and the dashboard's Feed read through it, and the
  dashboard's lists of other workspaces' runs and triggers
  (`workspace/others.ts`, with `storedTicks` in `triggers.ts`). Every writer handle goes through `guard.ts`, which
  refuses a transaction once another Marbles has migrated the file past
  this one. A task command with no generation hosting its workspace opens the database per
  command: `readTasks` read-only, `changeTasks` as a writer (`writeAsHost`).
  A store takes `{ database }` (`StoreDatabase`, the type a package store
  declares too), the database or one of its transactions; a package store
  also takes `scope`, which is the workspace id. `transaction.ts` runs
  several stores' writes in one transaction by handing each the same `tx`. Open one
  handle per process and pass it down. It imports `lib/`, `layout.ts`, and
  third-party packages; every tier above `lib/` may import it.
- `src/authoring/` owns definition instance methods and runtime routing as
  well as the module-authoring sugar; it collects into the `catalog` in
  `authoring/catalog.ts`, which is private to Marbles, and may import
  `lib/`, never the reverse. `Engine.execute` runs direct definitions
  through the same orchestration as named launches; calls inside a step
  become dynamic children in that run. `createEngine` in `src/create.ts`
  is the one place the Marbles defaults and what `--dry-run` echoes are
  decided, and where it persists, following `Engine.persistence`; it
  builds the instances, constructs the engine, and copies the catalog in.
  Given the host's `database`, it keeps the tasks, sessions, workflow
  runs, Execution Runs, trigger state, automations, usage, grants,
  deferred approvals, activities, provider configuration, artifacts,
  sandbox containers and workspace catalogue there;
  given only a state dir, the engine opens one handle of its own for its
  tasks, sessions, runs, Execution Runs, trigger state, automations,
  usage, grants, deferred approvals and activities
  (`openWorkspaceDatabase` in `database/managed.ts`), reads and writes its
  provider configuration per call (`DatabaseProviderStore.forState`),
  keeps its artifacts, containers and catalogue in memory, and closes the handle after
  everything else it holds, since its agents may write a session after its
  records close.
- `src/workspace/` hosts one workspace in the process it runs in: source
  discovery (`source.ts`), the Varlock environment (`env.ts`), module
  loading and the engine builder (`open.ts`), the schedule loop
  (`loop.ts`), the dashboard snapshot (`snapshot.ts`) with its feed of
  every workspace (`feed.ts`) and its usage
  totals (`usage.ts`) and the host's own lines (`diagnostics.ts`), source
  watching (`watch.ts`), starter templates and creation, background agent
  dispatch, the task commands the CLI and MCP share (`tasks.ts`), and
  `hostWorkspace()` in `host.ts`, which ties them into the
  `WorkspaceConnection` every host is written against. A host opens one
  writer handle on the database (`openHostDatabase`) before it builds the
  engine, or is handed one, keeps it until the engine is disposed, and
  records the workspace's registration (root, source, where its work
  starts) through it once the engine has started; under `--dry-run` it
  opens none. Nothing under `workspace/` reads `process.cwd()`: the CLI
  passes the directory it runs in (`directory`), and a workspace's
  registration says where its work starts (`cwd`). Each workspace loads
  into a `Catalog` of its own (`loadSource`, through `loadInto` in
  `authoring/runtime.ts`; loads may overlap), and its Varlock values into
  the engine's execution context, never `process.env`. Each load imports
  copies of its own of every module and data file its source imports by
  path (`copies.ts`: anything but packages and Marbles' own code; it
  rewrites only import specifiers, found with `oxc-parser`, and a file
  that does not parse, or is CommonJS, fails the load), and those
  copies import a library bound to the load (`authoring/bound.ts`): every
  word that declares or routes runs in the load's scope (`inLoad`), and
  builders and instances keep whom they answer to (`captureScope`: the
  load, or the binding of the engine whose run made them, never that run). Each engine bound to its workspace (`setHost`) is a
  binding, keyed by the execution context its runs and observers run in
  (`Engine.context`, `lib/execution-context.ts`); a load takes the
  binding of the engine that takes its catalog. Work answers to its own
  binding's engine and catalog until that engine is disposed, whatever
  engine is bound to the workspace after it, and is refused
  (`WorkspaceReleasedError`) once it is. A released binding keeps
  neither engine nor catalog, and the loads it took are dropped, only
  their numbers kept so late calls from them are refused; a host lets
  its engine go as soon as it disposed it (`releaseEngine`), and any
  other disposed engine is let go when the next engine is bound or load
  begins. Work without a
  binding reaches an engine only while one engine alone is alive for the
  workspace: a load no engine has taken yet, or work naming nothing in a
  process hosting one workspace; with two alive it is refused
  (`AmbiguousWorkspaceError`), as is a run of an engine no host here
  bound whose workspace another engine is bound to. Nothing reads the
  stack for it. `hosted.ts` (`HostedWorkspaces`) hosts several
  workspaces in one process over one database handle, refuses work that
  names no workspace, shares one registration of a workspace between
  callers, addresses what each declared by workspace id and local name
  (`run`, `roll`), and loads every registered (`hosted`) workspace again,
  reporting each that fails (`loadRegistered`; a registration whose source
  is gone fails; one made with no source path reads the default
  `.foundry/marbles` under its root when that is there, and is its root
  alone when it is not), and drops
  a registration (`unregister`). An engine generation of the
  Marbles process is one of these: it loads every registered workspace up
  to engines not yet started (`stageRegistered`) and starts them when it
  takes over. It imports `lib/`,
  `authoring/`, `database/`, `layout.ts` and `model/`; never `cli/` or
  `process/`.
- `src/process/` is the Marbles process: one daemon per machine
  (`daemon.ts`) that claims `locks/process` at the state root, listens on
  the layout's Unix socket, and hosts every registered workspace in one
  engine subprocess, a generation (`generation.ts`, the only module that
  imports `workspace/`), each numbered in `marbles_generations`
  (`database/generations.ts`). A change of what the current generation
  loaded (its fingerprint: the installation and every workspace's
  source), a reload, or a generation that died starts a candidate: it
  loads every registered workspace up to engines not yet started, else
  nothing switches; then the current one retires (`Engine.retire`: no
  tick, delivery or queued run starts there again, its queued runs are
  handed to the candidate and its parked runs let go) and finishes its
  running runs before it exits, and the candidate starts, taking over the
  parked and queued work; the candidate is current from the moment it has
  loaded, before the previous one is told to go, and only a current
  generation that is not retiring is replaced when it exits. A run of a
  retired generation that parks later is let go as it parks and taken
  over by the current one (`Engine.adopt`, over `Orchestrator.adopt`,
  which claims the run's suspensions at a new revision). The retiring
  engine stops answering a parked run before it gives up its claim. A
  failed release is retried with backoff while the engine lives. A
  failed adoption clears the local scope, parked queue handle and router
  entry, and gives up the claim through the same retry path. Taking the
  claim again cancels any pending retry for the previous attempt. The daemon also
  sweeps the database for parked runs no live engine holds and offers
  them to the current generation. An answer is applied only by the engine
  that holds the run when it is written: the router resolves at the
  revision it read, and the run store refuses a commit to a Run another
  engine owns (`RunMovedError`); either refusal is a `QuestionMovingError`
  the daemon retries elsewhere. A generation that was current and died is
  replaced after a bounded backoff, and only a candidate that does not
  load has its fingerprint refused. A generation whose daemon is gone (a
  crash) is out of any daemon's reach: it ticks and delivers no more, lets
  in its queued runs and finishes them with its running ones on the code
  it loaded, then exits. The next daemon records it retiring while its
  process is alive, and leaves its runs to it, since their owner is alive;
  the sweep records it exited once its pid and start prove it gone, and a
  record without a start, which proves nothing, shows in `marbles status`
  as "cannot tell". A queued run whose owner is proved gone is taken by
  the current generation through the sweep (`Engine.takeQueued`). The fingerprint
  (`process/fingerprint.ts`) is taken before a generation loads: every
  file under each workspace's root, by relative path and content, and
  every file the generation reports reading outside it (`onRead` in
  `workspace/copies.ts`), recorded as it was when read. On load refusal,
  `watching` keeps the outside paths the preceding generation read, with
  their digests at the failed attempt. Restoring one of those files can
  trigger a fresh load even when the candidate never read it.
  A moved queued agent dispatch reopens its stored session in the engine
  that starts the turn. `BackgroundRuns` reads and cancels workflow runs
  through the engine's run and execution records when the host did not
  start them.
  Commands about a run go to the generation whose process owns it, answers
  and activity stops to the one holding them, the rest to the current
  one (the table beside `RUN_METHODS` in `daemon.ts`); every signal to a
  generation first proves its pid and start. The rest is the wire protocol (`protocol.ts`,
  `channel.ts`); the client (`client.ts`), which joins the running daemon
  or starts one; and the claim (`instance.ts`). Apart from the generation
  it imports only `lib/`, `database/`, `layout.ts`, `model/` and the pure
  discovery and digests in `workspace/source.ts` and `workspace/watch.ts`,
  so the daemon never loads an authoring module and survives any of them.
- `src/access/` is how a command reaches its workspace, shared by the CLI
  and the MCP server (`workspace.ts`): through stored state, its rows in
  the database opened for each command (in memory under `--dry-run`); through a running instance, joining the Marbles process
  without starting it (`NotHostedError` when no generation hosts the
  workspace); or by starting and hosting it, which only the CLI does. It
  imports `workspace/`, `process/`, `database/`, `lib/`, `layout.ts` and
  `model/`, and nothing from the app.
- The app sits on top and may import anything: `src/cli.ts` (the entry,
  which runs `main` whenever it loads, imported by `bin/marbles` too),
  `src/cli/` (what only the CLI and its terminal UI use:
  `command-line.ts`, every command's handler, and what `--dry-run` means
  for it, beside `main`; `args.ts`, which parses a command line
  completely, before anything loads; `interactive.ts` and `app.tsx`, the
  dashboard command and its renderer; `views/`, the screens; `state/`,
  their models, reducers and hooks; `hooks/`, the shared React hooks;
  `settings.ts`, the settings file; `watch.ts`, `marbles
  watch`; the output of `marbles status` and the task commands,
  `status/` and `tasks/`; and `resources/`, the resource listings, sharing, and
  `relink`, which rebuilds each workspace's links under `<root>/.marbles/`
  from the database; they are never read back), `src/components/`,
  `src/mcp/`, `src/status/`. The dashboard is a client of the process.
  `src/mcp/stdio.ts` is the `marbles mcp` server, which `cli.ts` loads
  only when that command runs. `src/mcp/relay.ts` runs it in a child
  process whose stdout is the relay's stderr. Protocol frames go out on
  descriptor 3, which the relay copies to its own stdout, so nothing
  printed to stdout reaches the protocol. The relay copies its stdin to
  the server's. Descriptor 4 is a pipe the relay holds; it ends when the
  relay exits, and the server shuts down. The server exits when its
  shutdown deadline passes. The relay kills a server that outlives a later
  one, counted from a signal it passes on or the end of stdin. The server reaches the
  workspace through `access/` and never starts the process or attaches a
  workspace. Under `--dry-run` the CLI hosts the workspace in its own
  process through `hostWorkspace`, since nothing is persisted. The MCP
  server hosts nothing even then: it keeps the tasks in memory and joins
  no process.

`src/layout.ts` decides where things live, all of it under the Foundry
home (`$FOUNDRY_HOME`, else `~/.foundry`): the Marbles state root, the
Marbles database and the process socket in that root, and the shared
artifact store. Nothing moves on its own; the daemon hands its generations the
home in `FOUNDRY_HOME`. The README lists the final layout on disk. `src/model/` holds the plain data
types the tiers share (snapshots, the `WorkspaceConnection`, run status,
task commands);
it imports types from `lib/` and nothing else.

The `@foundry.sh/marbles` surface is what authoring modules depend on; new
engine API goes on `@foundry.sh/marbles/lib`, not there. That entry exports
`Engine`, types, a few constants, and the package classes the constructor's
instances are built from; do not add loose functions to it. Public entries:
`@foundry.sh/marbles` (`authoring/index.ts`), `@foundry.sh/marbles/prebuilt`,
`@foundry.sh/marbles/lib` (`entries/lib.ts`: `lib/index.ts` with the
published `Engine`),
`@foundry.sh/marbles/engine` (`entries/engine.ts`: `lib/embedded.ts` with
the published `Engine`),
`@foundry.sh/marbles/statuses` (`lib/execution-statuses.ts`),
`@foundry.sh/marbles/workspace`
(`workspace/index.ts`: host one workspace programmatically), and
`@foundry.sh/marbles/process` (`process/index.ts`: start or join the
Marbles process). The generation is a build entry (`dist/generation.js`) the
daemon spawns, never a public import.

The default authoring folder is `.foundry/marbles`; leading-underscore files
and directories are excluded from discovery but can be imported, and the
source watcher digests them too. The workspace root stays above `.foundry`.

The dashboard's keys, footer, and keyboard help come from one command table
(`cli/state/dashboard-commands.ts`), and its state changes in a pure reducer
(`cli/state/dashboard-state.ts`). `src/components/` is presentational: props
and callbacks in, rendering out. It imports React, `@opentui/*`, other
components, and types from `model/` (from `lib/` only where `model/` has none),
and nothing from `cli/`; `test/components-boundary.test.ts` holds it there.
Lookups, filtering, selection, statistics, eligibility, and usage formatting
live in `cli/state/` and `cli/views/`, which hand components ready rows:
`dashboard-rows.ts`, `dashboard-metrics.ts`, `inspector.ts` (with
`views/inspector.tsx`), and `cli/hooks/use-run-stream.ts`; `cli/theme.ts`
resolves theme names to palettes. `src/components/ui/` holds primitives that
import nothing from blocks; `src/components/blocks/` holds the domain
components.
