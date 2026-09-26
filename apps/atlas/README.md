# Atlas

One Bun CLI and a Vite + React frontend. No code has been transferred from Agents.

```sh
bun run --filter @foundry/atlas build
bun run atlas serve /path/to/workspace
```

`atlas [path]` generates output, serves it, and opens the browser.
`atlas scan [path]` only generates. `atlas serve [path]` only serves.
Paths default to the caller's current directory. Flags: `--state <path>`,
`--port <number>`, `--no-open`, `--help`. Port zero selects a free port.

Generation currently stops with an explicit "not connected" error.
Serving works now; the frontend displays the generated manifest verbatim when
present, or a missing-output message. The map renderer has not been added.

```text
src/cli/index.ts       Commands: resolve workspace, call library, start server
src/cli/workspace.ts   Canonical workspace path and hashed storage paths
src/lib/generate.ts    Library execution seam, currently throws
src/server/server.ts  Static file serving
src/web/app.tsx        Frontend entry for the future renderer
public/               Static web assets
```

The CLI calls the library with `root`, `output`, `cache`, and `onProgress`.
The library will write its own files under:

```text
~/.foundry/atlas/<sha256-of-canonical-workspace-path>/
  output/
  cache/
```

`--state` replaces `~/.foundry/atlas`. The server maps `/data/*` directly to
`output/*`, preserving file bytes. It does not parse, wrap, project, or rewrite
the data. The frontend will consume the library's existing types and shapes.
There is no saved-view file, data API, or separate contracts layer. The cache
is not served. Generation and output publication belong to the library.

## Build and development

`build` bundles `src/cli/index.ts` into `dist/cli/atlas.js` with Bun and builds
the browser app into `dist/web` with Vite. Vite copies `public/` into that web
output. The CLI serves those assets without running Vite. Scanning does not
rebuild the frontend. Add library workers to the build when they are migrated.

```sh
bun run --filter @foundry/atlas dev -- /path/to/workspace --no-open
bun run --filter @foundry/atlas typecheck
bun run test --filter=@foundry/atlas
```

Development uses Vite hot reload and proxies `/data` to the same static file
server. Tests run after the build through Turbo. All configuration currently
uses CLI arguments; use Varlock if environment settings are introduced.
