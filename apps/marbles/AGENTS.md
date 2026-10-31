# Marbles packaging

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
`@modelcontextprotocol/sdk` also satisfies a required Claude Agent SDK peer,
so it remains a runtime dependency even though the STDIO MCP entry runs only
from source in this checkout.
The `evlog` exception covers imports in the bundled models and workflows code.
The `@anthropic-ai/claude-agent-sdk` exception covers the bundled usage
package, which reads Claude Code's limits through it; its version follows
`packages/usage`.
The `@ai-sdk/provider` exception covers model types referenced by the published
declarations; those generated imports are absent in a fresh checkout.
The `@foundry/core` development dependency supplies transitive pagination types
to the declaration bundler through the explicit mappings in `tsup.config.ts`.

# Marbles source layout

Four buckets, each importing only what sits below it:

- `src/lib/` is the engine and imports nothing outside `src/lib/`: no
  authoring words, no views, no CLI. The `Engine` constructor takes the
  packages' own instances (models, session store, containers, artifact
  system, all required; a workspace system, which it builds from its `git`
  option when omitted, and a `StateStore`, a `JsonStateStore` over `state`
  or in memory without one) and builds the managers and everything that
  connects them itself. It owns its run scopes and its trigger state; no
  module global holds either. Each manager has the plain operation as a
  method, usable on the engine directly, and `scoped(frame)` for the view a
  step body gets, which adds replay, cancellation, and cleanup on top; new
  manager behavior goes in the plain method. The engine owns its registry
  and is told what can run through `define`, `schedule`, and `monitor`.
  `lib/cli-harnesses.ts` describes each CLI harness once (ids in
  preference order, executor, guest artifact and environment);
  `--harness`, setup, and the sandbox all read it.
- `src/authoring/` owns definition instance methods and runtime routing as
  well as the module-authoring sugar; it collects into the `catalog` in
  `authoring/catalog.ts`, which is private to Marbles, and may import
  `lib/`, never the reverse. `Engine.execute` runs direct definitions
  through the same orchestration as named launches; calls inside a step
  become dynamic children in that run. `createEngine` in `src/create.ts`
  is the one place the Marbles defaults and `--dry-run` are decided; it
  builds the instances, constructs the engine, and copies the catalog in.
- `src/workspace/` hosts one workspace in the process it runs in: source
  discovery (`source.ts`), the Varlock environment (`env.ts`), module
  loading and the engine builder (`open.ts`), the schedule loop
  (`loop.ts`), the dashboard snapshot (`snapshot.ts`), source watching
  (`watch.ts`), starter templates and creation, background agent dispatch,
  the task commands the CLI and MCP share (`tasks.ts`), and
  `hostWorkspace()` in `host.ts`, which ties them into the
  `WorkspaceConnection` every host is written against. It imports `lib/`,
  `authoring/`, `layout.ts` and `model/`; never views, `args`, or
  `process/`. The catalog, the authoring host slot, `process.env` and the
  module cache are per-process, so one process hosts one workspace.
- `src/process/` is the Marbles process: one daemon per machine
  (`daemon.ts`) that claims `locks/process` at the state root, listens on
  the layout's Unix socket, and hosts each attached workspace in a worker
  it spawns (`worker.ts`, the only module that imports `workspace/`); the
  wire protocol (`protocol.ts`, `channel.ts`); the client (`client.ts`),
  which joins the running daemon or starts one; and the claim
  (`instance.ts`). Apart from the worker it imports only `lib/`,
  `layout.ts`, `model/` and the pure discovery in `workspace/source.ts`,
  so the daemon never loads an authoring module and survives any of them.
- The app sits on top and may import anything: `src/cli.ts`, `src/args.ts`
  (which parses a command line completely, before anything loads),
  `src/dashboard/`, `src/views/`, `src/components/`, `src/mcp/`,
  `src/status/`, `src/sessions/`. `src/mcp/stdio.ts` and the dashboard are
  clients of the process; under `--dry-run` they host the workspace in
  their own process through `hostWorkspace` instead, since nothing is
  persisted.

`src/layout.ts` decides where things live: the Foundry home
(`$FOUNDRY_HOME`, else `~/.foundry`), the Marbles state root under it, the
shared artifact store, and the process socket; `--state` and
`--artifacts` move one location each. `src/model/` holds the plain data
types the tiers share (snapshots, the `WorkspaceConnection`, run status,
task commands);
it imports types from `lib/` and nothing else.

The `@foundry.sh/marbles` surface is what authoring modules depend on; new
engine API goes on `@foundry.sh/marbles/lib`, not there. That entry exports
`Engine`, types, a few constants, and the package classes the constructor's
instances are built from; do not add loose functions to it. Public entries:
`@foundry.sh/marbles` (`authoring/index.ts`), `@foundry.sh/marbles/prebuilt`,
`@foundry.sh/marbles/lib` (`lib/index.ts`), `@foundry.sh/marbles/workspace`
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
