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

The `evlog` exception covers imports in the bundled models and workflows code.
The `@ai-sdk/provider` exception covers model types referenced by the published
declarations; those generated imports are absent in a fresh checkout.
The `@foundry/core` development dependency supplies transitive pagination types
to the declaration bundler through the explicit mappings in `tsup.config.ts`.

# Marbles source layout

`src/lib/` is the engine and imports nothing outside `src/lib/`: no authoring
words, no views, no CLI. The `Engine` constructor takes the packages' own
instances (models, session store, containers, artifact system, all required;
a workspace system, which it builds from its `git` option when omitted, and a
`StateStore`, a `JsonStateStore` over `state` or in memory without one) and
builds the managers and everything that connects them itself. It owns its run
scopes and its trigger state; no module global holds either. Each manager has
the plain operation as a method, usable on the engine directly, and
`scoped(frame)` for the view a step body gets, which adds replay,
cancellation, and cleanup on top; new manager behavior goes in the plain
method. The engine owns its registry and is told what can run through
`define`, `schedule`, and `monitor`. `lib/cli-harnesses.ts` describes each
CLI harness once (ids in preference order, executor, guest artifact and
environment); `--harness`, setup, and the sandbox all read it.

`src/authoring/` is the module-authoring sugar; it collects into the
`catalog` in `authoring/catalog.ts`, which is private to Marbles, and may
import `lib/`, never the reverse. `createEngine` in `src/create.ts` is the one
place the Marbles defaults and `--dry-run` are decided; it builds the
instances, constructs the engine, and copies the catalog in. The
`@foundry/marbles` surface is what authoring modules depend on; new engine API
goes on `@foundry/marbles/lib`, not there. That entry exports `Engine`, types,
a few constants, and the package classes the constructor's instances are
built from; do not add loose functions to it. The CLI, dashboard, views, and
onboarding sit beside them and may import both. Public entries:
`@foundry/marbles` (`authoring/index.ts`), `@foundry/marbles/prebuilt`, and
`@foundry/marbles/lib` (`lib/index.ts`).

`src/source.ts` owns filesystem discovery for the CLI. `src/host.ts` is where
the CLI and the dashboard start: it loads the source, places the workspace
under the state root, and builds the engine through `createEngine`, so each
host decision is made once. `src/args.ts` parses a command line completely,
before anything loads. Setup belongs in `src/onboarding/`, never `src/lib/`.
The default authoring folder is `.foundry/marbles`; leading-underscore files
and directories are excluded from discovery but can be imported. The
workspace root stays above `.foundry`.

The dashboard's keys, footer, and keyboard help come from one command table
(`views/dashboard-commands.ts`), and its state changes in a pure reducer
(`views/dashboard-state.ts`). `src/components/ui/` holds primitives that
import nothing from views, lib, or blocks; `src/components/blocks/` holds the
domain components. `src/model/` holds plain data types, with no imports,
that both tiers and the snapshot builder share.
