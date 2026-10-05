# Quirks packaging

Quirks is published as a standalone package. Its build inlines the Foundry
workspace packages, but leaves third-party imports external. Keep their
third-party runtime dependencies in this package's `dependencies`, even when
Quirks source does not import them directly or a build tree-shakes a path.
Optional features may use an explicitly declared optional peer dependency.

Knip cannot trace those bundled imports back to this manifest. Keep its
`apps/quirks` dependency exceptions limited to this packaging case. Before
removing one, inspect the build and run
`bun run test:package` from this directory; the package test installs the
tarball in an isolated consumer and exercises the CLI.

The `evlog` exception covers imports in the bundled models and workflows code.
The `@ai-sdk/provider` exception covers model types referenced by the published
declarations; those generated imports are absent in a fresh checkout.
The `@foundry/core` development dependency supplies transitive pagination types
to the declaration bundler through the explicit mappings in `tsup.config.ts`.

# Quirks source layout

`src/lib/` is the engine and imports nothing outside `src/lib/`: no authoring
words, no views, no CLI. The `Engine` constructor takes the packages' own
instances (models, session store, workspace system, containers, artifact
system), all required, and builds the managers and everything that connects
them itself. Each manager has the plain operation as a method, usable on the
engine directly, and `scoped(frame)` for the view a step body gets, which adds
replay, cancellation, and cleanup on top; new manager behavior goes in the
plain method. The engine owns its registry and is told what can run through
`define`, `schedule`, and `monitor`. `src/authoring/` is the config-facing sugar; it
collects into the `catalog` in `authoring/catalog.ts`, which is private to
Quirks, and may import `lib/`, never the reverse. `createEngine` in
`src/create.ts` is the one place the Quirks defaults and `--dry` are decided;
it builds the instances, constructs the engine, and copies the catalog in. The
`@foundry/quirks` surface is what configs depend on; new engine API goes on
`@foundry/quirks/lib`, not there. That entry exports `Engine`, types, and the
package classes the constructor's instances are built from; do not add loose
functions to it. The CLI, dashboard, views, and onboarding sit
beside them and may import both. Public entries: `@foundry/quirks`
(`authoring/index.ts`), `@foundry/quirks/prebuilt`, and
`@foundry/quirks/lib` (`lib/index.ts`).
