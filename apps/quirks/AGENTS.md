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
words, no views, no CLI. It takes definitions as data and its managers as
instances through the `Engine` constructor; `createEngine` in `lib/create.ts`
is the one place the Quirks defaults are assembled. `src/authoring/` is the
config-facing sugar; it registers into the default `catalog` instance that
`lib/catalog.ts` exports, and may import `lib/`, never the reverse. No lib
module reads that instance: an engine runs the catalog it is handed. The
`@foundry/quirks` surface is what configs depend on; new engine API goes on
`@foundry/quirks/lib`, not there. The CLI, dashboard, views, and onboarding sit
beside them and may import both. Public entries: `@foundry/quirks`
(`authoring/index.ts`), `@foundry/quirks/prebuilt`, and
`@foundry/quirks/lib` (`lib/index.ts`).
