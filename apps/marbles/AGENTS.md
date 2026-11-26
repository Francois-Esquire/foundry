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
The `croner` exception covers the bundled scheduling package, which reads
calendar cadences with it.
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
  manager behavior goes in the plain method. `lib/managers/runs.ts` is
  how a run is read (`RunView`: the stored Run first, then the execution
  record) and launched from a step body, each launch kept in the run's
  ledger by its place and definition, so a body that runs again gets the
  same run back. The engine owns its registry
  and is told what can run through `define`, `schedule`, `monitor`, and `task`. Every launch goes through
  `lib/launcher.ts`, which submits it to the engine's one run queue at
  once, registers each host task as a queue handler, and pays each caller
  its run's result. Concurrency is the queue's: each Marbles pool is a
  `@foundry/queue` pool (`configurePool`, `pools`), so a queued run is queued
  in `@foundry/queue` from its launch. `lib/executions.ts` (`Executions`)
  projects the queue's Jobs and Runs into Execution Runs
  (`executionOf` in `lib/execution-record.ts`), kept current from the
  queue's events, and keeps only what Marbles adds to a run, its
  observations, progress and retention gaps, in an `ExecutionStore`
  (`lib/execution-store.ts`), each write in the order it was made.
  Agent-created triggers are
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
  `lib/run-queue.ts` (`RunQueue`) is the engine's one `@foundry/queue`,
  with its pools and host task handlers; it runs workflow Runs through
  `@foundry/workflows/queue-handler`. It materializes a fresh workflow for
  every attempt, from the run's checkpoint and the resolutions of its
  suspensions, and holds it only while that attempt runs (`onStart` to
  `onFinish`); a run is followed to its end through `awaitJob` and
  `runResultOf`. Only the first attempt of a run this engine submits is
  built before the submit, so a launch whose input its schema refuses fails
  before any Run exists. A run scope is opened per attempt
  (`RunScopes.open`), from the scope of the attempt before it or, in a
  process that never ran the run, from what the run store recorded. A
  pause is a suspension named by how many of its step's pauses were
  answered before it; the prompt it is resumed with is that suspension's
  resolution, handed to the step's next session turn once (the count
  taken is kept in the run's ledger). `lib/queued-workflows.ts` is an
  engine's workflow Runs while it runs: the queue, the Feed router, the
  followed runs and their listing, built once the engine's run store is
  open; `lib/engine-definitions.ts` is what the engine can run and how each
  is registered on that queue, and `lib/engine-setup.ts` builds the
  engine's stores, context, agents manager and bindings.
  `lib/workflow-runs.ts` projects the queue's Jobs and Runs into
  `RunRecord`s and its events into `RUNS` facts.
  `lib/schedule-loop.ts` runs `@foundry/scheduling`'s scheduler over the
  trigger store's schedule store while a host runs (`run`), registering
  every declared and agent-created schedule (`registration` in
  `lib/schedule.ts`: an interval is a fixed delay after its run settles, a
  calendar slot a calendar cadence, each with overlap skip and misfire
  run-once) and removing what is no longer declared; `lib/schedule-dispatch.ts`
  is its `ScheduleDispatch`, which launches each occurrence through the
  engine under the occurrence's id as the queue's idempotency key, so a
  restarted dispatcher gets the same run back, reads its end from the
  Execution Run, records a launch the engine
  refuses as a failed occurrence, and holds a monitor's occurrence open
  until the launch its detector asked for is started. A roll
  (`rollSchedule`) launches and awaits a schedule's target directly and
  records no occurrence.
  `lib/followed-runs.ts` follows workflow runs to their end: it observes each
  attempt that runs here, and settles a run when its Job settles,
  whichever engine ran its last attempt. An engine whose queue starts a
  resumed run it does not follow follows it from then. `lib/run-store.ts`
  is where their Runs are kept (`RunStore`, in memory by default); what a
  gone process left is the queue's to recover (`recover`): a run it left
  running is interrupted, one it left queued is adopted. A suspended run needs no owner: any engine may answer it, and its
  questions are open in the Feed from the engine that asked them, or from
  an askable engine that starts while the run is suspended. `lib/crash-recovery.ts` is the one entry point that puts
  right what a crash left, run once per start before the host schedules
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
  plugins (the `ProviderPlugin` shape in `lib/providers/plugins.ts`, one
  module per provider beside it, none importing another) build instances
  from configuration (`lib/providers/configuration.ts`), and the sandbox
  reads their execution facets. A workspace's plugins are the defaults and
  what its source passes to `defineProvider`, collected in its catalog;
  `createEngine` merges them.
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
  view of them a dry run reads through to. `runs.ts` is a workspace's run queue: `@foundry/queue`'s
  `SqliteQueueStore` scoped by the workspace id, whose `onCommit` hook
  files beside each workflow Run it puts Marbles' row in
  `marbles_workflow_runs`, what the run's scope recorded, so a later
  attempt in another process opens its scope from it. Each run's output stays
  a log file on disk, `<state>/<id>/output/<run>.jsonl`. `triggers.ts`
  is a workspace's trigger state: each monitor's state by the trigger's
  key (`marbles_monitor_states`), and `@foundry/scheduling`'s
  `SqliteScheduleStore` scoped by the workspace id, whose occurrence
  claims keep two schedulers from dispatching one due time twice; its
  readers (`storedSchedules`) derive each schedule's last outcome and
  running owner from its latest occurrence and that run's Execution Run.
  `executions.ts` is what Marbles adds to a workspace's Execution Runs
  (`ExecutionStore`): each run's progress and revision a row of
  `marbles_executions`; each observation a row of
  `marbles_execution_observations`, so recording one costs the same however
  many its run has; and what pruning removed, `marbles_execution_gaps`,
  counted once the queue has removed the pruned jobs, in the transaction
  that deletes whatever annex rows remain. Its readers
  (`readExecution`, `queuedRuns`) project a run from the queue's tables.
  The run store's `onCommit` hook deletes a removed job's rows in the
  commit that records `job.removed`. `automations.ts` is the triggers agents created, one
  row of `marbles_automations` each, an edit a transaction that reads
  first; `usage.ts` is each agent turn's usage fact, a row of
  `marbles_usage_facts` by turn. `grants.ts`, `approvals.ts` and
  `activities.ts` are a workspace's agent grants (one document the grant
  repository validates), deferred approvals (one document) and harness
  activities (a row each, replaced only by a higher revision); the
  workspace's records (`tasks.ts`) keep who delivers its changes in
  `marbles_delivery_claims`, a claim a transaction on that row. `providers.ts` is the machine's provider configuration, a row
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
  workspace's, each read through its owner's package store, leaving out
  what another workspace whose `<state>/<id>` is a link owns, as the
  registry does. `status`, the
  resource listings and the dashboard's Feed read through it, and the
  dashboard's lists of other workspaces' runs and triggers
  (`workspace/others.ts`, with `storedSchedules` in `triggers.ts`). Every writer handle goes through `guard.ts`, which
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
  `lib/`, never the reverse. `authoring/runs.ts` is the read-only
  `runs` word, bound per load as `tasks` is; it never starts an engine to
  answer a read. A definition's `.enqueue(input?, { key }?)` launches it
  through the engine and resolves once it is queued, with its run's id and
  `result`. `step.enqueue(name)` and `workflow.enqueue(name)` look the
  name up in the answering engine's registry (`Engine.definition`, which
  leaves out monitors) and launch that very definition as its own
  `.enqueue` would, so keys, replay and pool limits are shared; each
  refuses the other kind, a load still running, and, in a script no
  workspace hosts, finds what the script declared in the catalog.
  `Engine.execute` runs direct definitions
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
  discovery (`source.ts`), module
  loading and the engine builder (`open.ts`), the schedule loop
  (`loop.ts`, over `lib/schedule-loop.ts`), the dashboard snapshot (`snapshot.ts`) with its feed of
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
  `authoring/runtime.ts`; loads may overlap). Each load imports
  copies of its own of every module and data file its source imports by
  path (`copies.ts`: anything but packages and Marbles' own code; it
  rewrites only import specifiers, found with `oxc-parser`, leaves one that
  does not resolve as written, rejects a computed `import()` that does not
  resolve from the importing file, and a file that does not parse, or is
  CommonJS, fails the load), and those
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
  occurrence or delivery starts there again, its queued runs are handed to
  the candidate, and its run queue retires, so it starts nothing but the
  children of its running runs) and finishes its running runs untouched
  before it exits, and the candidate starts, adopting the queued work;
  the candidate is current from the moment it has loaded, before the
  previous one is told to go, and only a current generation that is not
  retiring is replaced when it exits. A suspended run is nobody's to hand
  over: any generation answers it, the resolved run is unowned in the
  queue, and the live generation that is not retiring starts it
  (`Engine.takeHanded` answers for queued runs handed over only). A
  retiring generation does not wait for its
  suspended runs. A generation that was current and died is
  replaced after a bounded backoff, and only a candidate that does not
  load has its fingerprint refused. A generation whose daemon is gone (a
  crash) is out of any daemon's reach: it schedules and delivers no more, lets
  in its queued runs and finishes them with its running ones on the code
  it loaded, leaves its suspended runs in the store, and exits; a
  schedule's occurrence whose run is suspended stays open, so the schedule
  dispatches again only once that run ends, wherever it is answered. The
  next daemon
  records it retiring while its
  process is alive, and leaves its running and queued runs to it, since
  their owner is alive;
  the sweep records it exited once its pid and start prove it gone, and a
  record without a start, which proves nothing, shows in `marbles status`
  as "cannot tell". A queued run whose owner is proved gone is adopted by
  the current generation as it starts, or through the sweep
  (`Engine.adoptQueued`), both the queue's `recover`. The fingerprint
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
  Commands about a run go to the generation whose process owns its
  Execution Run, answers and activity stops to each hosting generation in
  turn until one takes it (any of them can answer a run's question), the
  rest to the current one. Snapshots gather the live runs and step work of retiring generations
  before the current host builds the view (the tables beside `RUN_METHODS`
  in `daemon.ts`); every signal to a generation first proves its pid and start. The rest is the wire protocol (`protocol.ts`,
  `channel.ts`); the client (`client.ts`), which joins the running daemon
  or starts one; and the claim (`instance.ts`). Apart from the generation
  it imports only `lib/`, `database/`, `layout.ts`, `model/` and the pure
  discovery and digests in `workspace/source.ts` and `workspace/watch.ts`,
  so the daemon never loads an authoring module and survives any of them.
- `src/access/` is how a command reaches its workspace, shared by the CLI
  and the MCP server (`workspace.ts`): through stored state, its rows in
  the database opened for each command (or in memory when callers pass `dry: true`); through a running instance, joining the Marbles process
  without starting it (`NotHostedError` when no generation hosts the
  workspace); or by starting and hosting it, which only the CLI does. It
  imports `workspace/`, `process/`, `database/`, `lib/`, `layout.ts` and
  `model/`, and nothing from the app.
- The app sits on top and may import anything: `src/cli.ts` (the thin entry
  that checks `envFilesLoaded()` and calls `runCli`, imported by `bin/marbles`
  too), `src/cli/` (zero-dependency CLI framework and command modules, free of
  top-level React/OpenTUI imports: `index.ts`, the static command registry,
  argument scanner, auto-generated `--help`, global `--source`/`--json`/`--help`
  flags, and uniform middleware; `command.ts`, the typed `defineCommand()`
  contract; `context.ts`, the shared `CliContext` with `output()` for text vs.
  JSON rendering; `errors.ts`, `UsageError` and actionable error classification;
  `commands/*.ts`, one self-contained module per command — no command is the
  dashboard, `start` ensures the background daemon is running and hosts this
  workspace, `stop [--workspace]` stops the daemon or unhosts this workspace,
  `run <name>` runs one thing now and waits, `enqueue <name>` queues it on the
  Marbles process and prints its run ID, and the resource nouns (`runs`,
  `sessions`, `artifacts`, `sandboxes`) and `theme` each take their actions as
  a second word; `settings.ts`, the settings file `marbles theme` reads and
  writes; `watch.ts`, `marbles watch`, which waits out a run still in its queue
  before it follows the run's output; the output of `marbles status` and
  the task commands, `status/text.ts` and `tasks/text.ts`; and `resources/`, the
  resource listings, sharing, and `marbles artifacts relink`, which
  rebuilds each workspace's links under `<root>/.marbles/` from the
  database; they are never read back), `src/tui/` (the OpenTUI dashboard and
  interactive status UI, lazy-imported by `src/cli/` only on a TTY:
  `interactive.ts` and `app.tsx`, the dashboard and its renderer; `views/`,
  the screens; `state/`, their models, reducers and hooks; `hooks/`, the shared
  React hooks; `theme.ts`, theme-to-palette resolution; and `status/view.ts`),
  `src/components/`, `src/mcp/`, `src/status/`. The dashboard is a client of the process.
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
  workspace.

`src/layout.ts` decides where things live, all of it under the Foundry
home (`$FOUNDRY_ROOT`, else `~/.foundry`): the Marbles state root, the
Marbles database and the process socket in that root, the shared
artifact store, and the process recovery records. Nothing moves on its own; the daemon hands its generations the
home in `FOUNDRY_ROOT`. The README lists the final layout on disk. `src/model/` holds the plain data
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
`@foundry.sh/marbles/engine` (`entries/embedded.ts`: `lib/embedded.ts` with
the published `Engine` from `entries/engine.ts`, which the CLI imports alone so
it does not load the provider factories `lib/embedded.ts` re-exports),
`@foundry.sh/marbles/statuses` (`lib/execution-statuses.ts`),
`@foundry.sh/marbles/providers` (`authoring/providers.ts`: `defineProvider`
and the provider types), one entry per provider,
`@foundry.sh/marbles/providers/<id>` (`lib/providers/<id>.ts`, one provider
value each; Claude Code and Codex are the defaults, `lib/providers/defaults.ts`),
`@foundry.sh/marbles/workspace`
(`workspace/index.ts`: host one workspace programmatically), and
`@foundry.sh/marbles/process` (`process/index.ts`: start or join the
Marbles process). The generation is a build entry (`dist/generation.js`) the
daemon spawns, never a public import.

The default authoring folder is `.foundry/marbles`; leading-underscore files
and directories are excluded from discovery but can be imported, and the
source watcher digests them too. The workspace root stays above `.foundry`.

The dashboard's keys, footer, and keyboard help come from one command table
(`tui/state/dashboard-commands.ts`), and its state changes in a pure reducer
(`tui/state/dashboard-state.ts`). `src/components/` is presentational: props
and callbacks in, rendering out. It imports React, `@opentui/*`, other
components, and types from `model/` (from `lib/` only where `model/` has none),
and nothing from `cli/` or `tui/`; `test/components-imports.test.ts` holds it there.
Lookups, filtering, selection, statistics, eligibility, and usage formatting
live in `tui/state/` and `tui/views/`, which hand components ready rows:
`dashboard-rows.ts`, `dashboard-metrics.ts`, `dashboard-views.ts`,
`feed-model.ts` and `feed-answer.ts` (each feed row's pending mark and
metadata label and tone), `inspector.ts` (with `views/inspector.tsx`), and
`tui/hooks/use-run-stream.ts`, building only what is mounted; `tui/theme.ts`
resolves theme names to palettes. `src/components/ui/` holds primitives;
`src/components/blocks/` holds the domain components; `src/components/layouts/`
holds the chrome: each layout arranges a few `ReactNode` regions and owns its
breakpoints, and a view that sizes content by the arrangement calls the pure
function beside it (`dashboardMain`, which also says whether main is shown,
so the view builds no model for a covered main; the metrics block's
`showsWorkflowRankings` likewise). `ui/` imports neither blocks nor layouts,
and blocks import no layouts; the import test holds that too. A view in
`tui/views/` places the models `tui/state/` builds into those regions.

Source files configure pools with `export default defineConfig({ pools: { review: 2 }, pool: "review" })`.
Pool limits are positive integers or `Infinity`. Hosted and script engines use
limit 4 in `default`; raw engines use 1. Awaiting a launched run holds the
caller's place; use `.run()` inline or separate pools.
