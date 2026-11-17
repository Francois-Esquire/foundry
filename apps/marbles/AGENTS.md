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
  option when omitted, and a `StateStore`, a `JsonStateStore` over `state`
  or in memory without one) and builds the managers and everything that
  connects them itself. It owns its run scopes and its trigger state; no
  module global holds either. The workspace's tasks reach it through
  `records` (`lib/events/records.ts`): the host hands in the database's
  (`database/tasks.ts`), and without one the `lib/` class keeps them in
  memory, whatever `state` is. The class the package publishes is
  `entries/engine.ts`, a tier above `lib/` and `database/`: given `state`
  and no `records`, it opens the database's (`database/managed.ts`). Each manager has the plain operation as a
  method, usable on the engine directly, and `scoped(frame)` for the view a
  step body gets, which adds replay, cancellation, and cleanup on top; new
  manager behavior goes in the plain method. The engine owns its registry
  and is told what can run through `define`, `schedule`, `monitor`, and `task`. Every launch goes through
  `lib/launcher.ts`, which owns queue admission, host tasks, and live runs.
  `lib/executions.ts` owns durable execution records and retention.
  `lib/held-runs.ts` owns held workflow runs and their run files.
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
  `readDatabase`, that can leave an empty WAL file, which holds nothing
  and which readers and writers pass over. `client.ts` makes everything this
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
  view of them a dry run reads through to. The modules and workflows
  tables are composed and migrated, but nothing in Marbles uses them yet:
  workflow runs are still the in-memory store and `runs/*.json`. Every writer handle goes through `guard.ts`, which
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
  Given the host's `database`, it keeps the tasks, sessions, artifacts,
  sandbox containers and workspace catalogue there;
  given only a state dir, the engine opens one handle of its own for its
  tasks and sessions (`openWorkspaceDatabase` in `database/managed.ts`),
  keeps the rest as it would with no database, and closes it after
  everything else it holds, since its agents may write a session after its
  records close.
- `src/workspace/` hosts one workspace in the process it runs in: source
  discovery (`source.ts`), the Varlock environment (`env.ts`), module
  loading and the engine builder (`open.ts`), the schedule loop
  (`loop.ts`), the dashboard snapshot (`snapshot.ts`) with its usage
  totals (`usage.ts`) and the host's own lines (`diagnostics.ts`), source
  watching (`watch.ts`), starter templates and creation, background agent
  dispatch, the task commands the CLI and MCP share (`tasks.ts`), and
  `hostWorkspace()` in `host.ts`, which ties them into the
  `WorkspaceConnection` every host is written against. A host opens one
  writer handle on the database (`openHostDatabase`) before it builds the
  engine, keeps it until the engine is disposed, and records the workspace
  through it once the engine has started; under `--dry-run` it opens none. It imports `lib/`,
  `authoring/`, `database/`, `layout.ts` and `model/`; never views, `args`, or
  `process/`. The catalog, the authoring host slot, `process.env` and the
  module cache are per-process, so one process hosts one workspace.
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
  `src/status/`, `src/sessions/`. The dashboard is a client of the process.
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

`src/layout.ts` decides where things live: the Foundry home
(`$FOUNDRY_HOME`, else `~/.foundry`), the Marbles state root under it, the
Marbles database and the process socket in that root, and the shared
artifact store; `--state` and
`--artifacts` move one location each. `src/model/` holds the plain data
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
