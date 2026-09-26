# Atlas

One Bun CLI, the semantic analysis library, and a Vite + React viewer.

```sh
bun run --filter @foundry/atlas build
bun run atlas scan /path/to/workspace
bun run atlas serve /path/to/workspace
```

`atlas [path]` generates output, serves it, and opens the browser.
`atlas scan [path]` only generates. `atlas serve [path]` only serves.
Paths default to the caller's current directory. Flags: `--state <path>`,
`--port <number>`, `--no-open`, `--history`, `--help`. Port zero selects a free port.
`--history` adds Git checkpoints during a scan and requires a Git repository.

The CLI generates the dataset incrementally, then runs `runInternalAnalysis`
through the review stage for each complete package. Internal reports are currently
recomputed on every scan. Workspace settings still come from the library's
existing `foundry.config.json#semantics` loader.

```text
src/cli/index.ts       Commands: resolve workspace, call library, start server
src/cli/scan.ts        Calls the library and saves its existing results
src/cli/workspace.ts   Canonical workspace path and hashed storage paths
src/lib/              Semantic analysis library migrated from Agents
src/server/server.ts  Static file serving
src/web/              Atlas renderer and browser data loaders
public/               Static web assets, including the ship model
```

The CLI calls `generateSemantics` with `root`, `config`, `cache`, and `onProgress`.
Generated files live under:

```text
~/.foundry/atlas/<sha256-of-canonical-workspace-path>/
  output/
    manifest.json       Library's dataset manifest
    ...                 Library's reports, indexes, shards, and projections
    manifests/          Byte-for-byte copies of package.json files
    internals/          Unwrapped runInternalAnalysis results by package
    history/            Library's history output when --history is requested
  cache/
```

`--state` replaces `~/.foundry/atlas`. The server maps `/data/*` directly to
`output/*`, preserving file bytes. It does not parse, wrap, project, or rewrite
the data. The frontend consumes the library's existing types and shapes.
There is no saved-view file, data API, or separate contracts layer. The cache
is not served. The renderer retains its existing layout and geometry calculations
in memory. The original workspace is unnecessary for rendering saved output;
the CLI still resolves the supplied workspace path to locate it.

The library publishes the main dataset before the CLI writes package manifests
and internal reports. Wait for the scan to finish before loading it. A scan without
`--history` replaces the output with a current-only dataset.

## Build and development

`build` bundles the CLI and its analysis worker into `dist/cli` with Bun and builds
the browser app into `dist/web` with Vite. Vite copies `public/` into that web
output. The CLI serves those assets without running Vite. Scanning does not
rebuild the frontend. Bun and installed runtime dependencies are required; this
is not a standalone executable.

```sh
bun run --filter @foundry/atlas dev -- /path/to/workspace --no-open
bun run --filter @foundry/atlas typecheck
bun run test --filter=@foundry/atlas
```

Development uses Vite hot reload and proxies `/data` to the same static file
server. It reads saved output without scanning automatically. Tests run after the
build through Turbo. Vitest covers the library and renderer; Bun tests exercise
the built CLI, worker, HTTP server, and browser loaders together. Analyzer fixture
source is excluded from lint and dead-code analysis because its text is test input.
All app configuration uses CLI arguments; use Varlock if environment settings are
introduced.

See [migration notes](docs/migration.md) for the source mapping and verification
limits. Other documents under `docs/` preserve the original design notes.
