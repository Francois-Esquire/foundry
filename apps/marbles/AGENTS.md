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

The `ai-sdk-provider-pi` exception covers the bundled Models Pi provider.
`@anthropic-ai/sdk` explicitly satisfies the Claude Agent SDK peer requirement.
Pi also depends on an older SDK, so relying on peer hoisting can select an
incompatible version in a fresh standalone install.
`@modelcontextprotocol/sdk` is a runtime dependency: `marbles mcp` serves
MCP over STDIO with it, and it also satisfies a required Claude Agent SDK
peer.
The `evlog` exception covers imports in the bundled models and workflows code.
The `@ai-sdk/mcp` exception covers the bundled agents MCP client, which
connects the MCP servers an agent's definition names; its version follows
`packages/agents`.
The `@anthropic-ai/claude-agent-sdk` exception covers the bundled usage
package, which reads Claude Code's limits through it; its version follows
`packages/usage`.
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
  `entries/engine.ts`, a tier above `lib/` and `database/`: given `state`,
  it keeps every store it is not handed in the database, over one handle
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
  each in memory without one. Which engine delivers a workspace's task
  changes is a claim its `records` grant (`claimDelivery`). Provider
  configuration, the machine's and each workspace's, and the identity key
  are kept in a `ProviderStore` (`lib/providers/store.ts`); the
  configuration reads it when the engine starts (`refresh`), not when it
  is built.
  `lib/held-runs.ts` follows held workflow runs to their end;
  `lib/run-store.ts` is where their Runs are kept (`RunStore`, in memory
  by default), and `lib/run-recovery.ts` is the one rule for which parked
  Runs a starting engine adopts.
  Each engine has an execution context (`lib/execution-context.ts`): its
  workspace id, where its work starts (`cwd`, the root by default) and the
  environment its commands inherit. Runs reach it through their bindings,
  observers through `inContext`, and nothing in `lib/` reads
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
  `migrate.ts` applies the committed migrations in `migrations/` in one
  write transaction, and refuses an applied history that is not an exact
  prefix of the shipped one. `schema.ts` composes every table, Marbles'
  own (`tables.ts`) and each domain package's `@foundry/<pkg>/store/tables`,
  one `export *` line per package; `bun run db:generate` writes the next
  migration from it, and a test fails when one is missing. Marbles' own
  stores sit beside the tables (`workspaces.ts`, the workspace registry,
  which leaves out any workspace whose `<state>/<id>` is a link, for every
  reader alike), and `tasks.ts`, a workspace's tasks: the package's
  `SqliteTaskStore` scoped by the workspace id, and Marbles' record of
  each change they commit (`marbles_task_changes`), written by the store's
  `onCommit` hook on the transaction it is handed, so a change and its row
  commit together. That hook is the seam for anything else that records
  task changes. `sessions.ts` is a workspace's agent sessions the same
  way: the package's `SqliteSessionStore` scoped by the workspace id, whose
  `onCommit` hook raises each session's row in `marbles_session_revisions`,
  the listing usage recovery, `marbles sessions` and `status` read. A row
  exists only for a session record put; a commit that puts messages first
  reads, through a view of its own transaction, the session each leaves,
  and puts that record again so it is raised too. Nothing reads the
  package's tables directly. `stores.ts` is a workspace's artifacts,
  sandbox containers and workspace catalogue: each package's SQLite store
  scoped by the workspace id, handed over as the package makes it, with no
  hook. Artifact blob files stay on disk, under
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
  workspace's records (`tasks.ts`) keep who delivers its task changes in
  `marbles_delivery_claims`, a claim a transaction on that row, as tick
  claims are. `providers.ts` is the machine's provider configuration, a row
  per scope with a revision the configuration's watcher polls, and the
  identity key; `stateProviders` is the same for a process that keeps no
  handle open. Its settings may hold secrets: `initializeDatabase` keeps
  the database file and its side files mode 0600, and nothing the provider
  store throws quotes a setting. The modules
  tables are composed and migrated; only the resource view reads them yet.
  `associations.ts` keeps which workspaces other than its owner each
  resource is shared with (`marbles_resource_workspaces`), under the rules
  `ResourceAssociations` in `lib/resources.ts` states; `resources.ts`
  (`ResourceView`) is what a workspace shows of the resources every
  package store keeps, its own and those shared with it, or every
  workspace's, each read through its owner's package store. `status`, the
  resource listings and the dashboard's Feed read through it. Every writer handle goes through `guard.ts`, which
  refuses a transaction once another Marbles has migrated the file past
  this one. A task command with no worker opens the database per
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
  is the one place the Marbles defaults and `--dry-run` are decided; it
  builds the instances, constructs the engine, and copies the catalog in.
  Given the host's `database`, it keeps the tasks, sessions, workflow
  runs, Execution Runs, trigger state, automations, usage, grants,
  deferred approvals, activities, provider configuration, artifacts,
  sandbox containers and workspace catalogue there;
  given only a state dir, the engine opens one handle of its own for its
  tasks, sessions, runs, Execution Runs, trigger state, automations,
  usage, grants, deferred approvals and activities
  (`openWorkspaceDatabase` in `database/managed.ts`), reads and writes its
  provider configuration per call (`stateProviders`), keeps its artifacts,
  containers and catalogue in memory, and closes the handle after
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
  that does not parse fails the load), and those
  copies import a library bound to the load (`authoring/bound.ts`): every
  word that declares or routes runs in the load's scope (`inLoad`), and
  builders and instances keep whom they answer to (`captureScope`: the
  load, or the workspace of the run that made them, never that run). So a call names its workspace by its run or observer
  (`lib/execution-context.ts`), else by the load whose library it came
  from; work naming a workspace whose host closed here is refused, and
  only work naming none may fall to the one workspace hosted. Nothing
  reads the stack for it. `hosted.ts` (`HostedWorkspaces`) hosts several
  workspaces in one process over one database handle, refuses work that
  names no workspace, shares one registration of a workspace between
  callers, addresses what each declared by workspace id and local name
  (`run`, `roll`), and loads every registered (`hosted`) workspace again,
  reporting each that fails (`loadRegistered`; a registration whose source
  is gone fails, one made without a source is its root alone), and drops
  a registration (`unregister`). The Marbles process still
  runs one worker per workspace. It imports `lib/`,
  `authoring/`, `database/`, `layout.ts` and `model/`; never views, `args`, or
  `process/`.
- `src/process/` is the Marbles process: one daemon per machine
  (`daemon.ts`) that claims `locks/process` at the state root, listens on
  the layout's Unix socket, and hosts each attached workspace in a worker
  it spawns (`worker.ts`, the only module that imports `workspace/`); the
  wire protocol (`protocol.ts`, `channel.ts`); the client (`client.ts`),
  which joins the running daemon or starts one; and the claim
  (`instance.ts`). Apart from the worker it imports only `lib/`,
  `database/`, `layout.ts`, `model/` and the pure discovery in
  `workspace/source.ts`,
  so the daemon never loads an authoring module and survives any of them.
- `src/access/` is how a command reaches its workspace, shared by the CLI
  and the MCP server (`workspace.ts`): through stored state, its rows in
  the database opened for each command (in memory under `--dry-run`); through a running instance, joining the Marbles process
  without starting it (`NotHostedError` when no worker hosts the
  workspace); or by starting and hosting it, which only the CLI does. It
  imports `workspace/`, `process/`, `database/`, `lib/`, `layout.ts` and
  `model/`, and nothing from the app.
- The app sits on top and may import anything: `src/cli.ts`, `src/args.ts`
  (which parses a command line completely, before anything loads),
  `src/dashboard/`, `src/views/`, `src/components/`, `src/mcp/`,
  `src/status/`, `src/resources/` (the resource listings, sharing, and
  each workspace's links under `<root>/.marbles/`, made from the database
  and never read back). The dashboard is a client of the process.
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
artifact store. Nothing moves on its own; the daemon hands its workers the
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
Marbles process). The worker is a build entry (`dist/worker.js`) the daemon
spawns, never a public import.

The default authoring folder is `.foundry/marbles`; leading-underscore files
and directories are excluded from discovery but can be imported, and the
source watcher digests them too. The workspace root stays above `.foundry`.

The dashboard's keys, footer, and keyboard help come from one command table
(`views/dashboard-commands.ts`), and its state changes in a pure reducer
(`views/dashboard-state.ts`). `src/components/ui/` holds primitives that
import nothing from views, lib, or blocks; `src/components/blocks/` holds the
domain components.
