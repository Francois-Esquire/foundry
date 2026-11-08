# Spyglass

Workspace analysis as a CLI, a library, and a local viewer. Point it at a
directory of TypeScript packages; Spyglass analyzes them, saves the result
outside the workspace, and serves a map you can explore in the browser:
packages as territories, files as settlements, dependencies as the routes
between them.

Spyglass runs on [Bun](https://bun.sh) 1.3.14 or newer. Git is optional: a scan
reads evolution from the Git log, and `--history` analyzes Git checkpoints,
when `git` is on the PATH.

```sh
bun add -g @foundry.sh/spyglass
spyglass /path/to/workspace      # scan, serve, open the browser
```

To run it from a checkout of Foundry:

```sh
git clone https://github.com/Francois-Esquire/foundry.git
cd foundry && bun install
bun run --filter @foundry.sh/spyglass build
bun run spyglass -- /path/to/workspace
```

## Commands

```text
Spyglass — workspace analysis and a local viewer

  spyglass [path]                         Scan, serve, and open the browser
  spyglass scan [path...]                 Scan and save each workspace's dataset
  spyglass serve [path]                   Serve the saved dataset without scanning
  spyglass report <package> [path...]     Print a package report from the saved dataset
  spyglass lens <id> [path...]            Print a lens from the saved dataset
  spyglass check [path...]                Check the workspace's rules against the saved dataset
  spyglass plan <opportunity> [path...]   Plan one opportunity and authorize it; writes nothing in the workspace
  spyglass apply <opportunity> [path...]  Preview a planned change; write and verify it with --write
  spyglass export <dir> [path]            Write a static viewer of the saved dataset to <dir>

The path defaults to the current directory. scan reads several paths as one collection;
the viewer (spyglass, serve, export) and the other commands read one workspace.
A directory named like a command is written as a path: ./scan, ./serve, ./report, ./lens, ./check, ./plan, ./apply, ./export.

  --state <path>        State root (default: ~/.foundry/spyglass)
  --history             spyglass, scan: analyze Git checkpoints as well
  --port <number>       spyglass, serve: local port (default: 4173; 0 chooses a free port)
  --no-open             spyglass, serve: do not open the browser
  --write               apply: write the change, verify it, then scan again
  --format <format>     report, lens, check, plan, apply: terminal, text, markdown (default: terminal; text when piped)
  --density <density>   report, lens, check, plan, apply: compact, normal, expanded (default: normal)
  --json                Print the result as one line of JSON
  --quiet               Print no progress
  --help, -h            Show this help

Exit codes: 0 done, 1 failed, 2 bad arguments, 3 a rule broken (check).
```

A scan is incremental: packages whose sources have not changed reuse their
last analysis. The workspace is never modified, except by `spyglass apply --write`, which writes one authorized change, verifies
it, and restores the files on any failure, and where you point `spyglass export`. The server binds to `127.0.0.1` only. `report`, `lens`, and `export` read the saved dataset and scan
nothing; `lens` prints one lens, such as `spyglass lens placement`; `export` writes a static viewer, the viewer and a copy of the
dataset, for any static host. `plan` reads the saved dataset too, and runs the workspace's test and typecheck scripts before
it authorizes a change; it writes nothing in the workspace. `apply` previews that change, and with `--write` makes it. See the [CLI reference](https://github.com/Francois-Esquire/foundry/blob/main/docs/spyglass/reference/cli.md) for output,
`--json`, and exit codes.

## Library

The same scans and server from code:

```ts
import { scan, serve } from "@foundry.sh/spyglass";

const everything = await scan("./my-workspace"); // workspace and every complete package's internals
const report = await everything.packageReport("@acme/db");
const workspace = await scan.workspace("./my-workspace"); // workspace level only
const db = await scan.package("./my-workspace", "@acme/db"); // one package's internals, saves nothing

const server = await serve("./my-workspace", { port: 0 });
console.log(server.url.href);
await server.stop();
```

A scan returns the dataset it saved: the manifest and the directory as JSON,
and accessors that read the saved reports and internals when called. The
package exports `scan`, `serve`, their option and result types, the two
dataset errors, and the three schema versions; the analyses themselves
stay internal. `serve` needs Bun; under Node, `scan` works with `bun` on the
PATH. See the [library reference](https://github.com/Francois-Esquire/foundry/blob/main/docs/spyglass/reference/library.md).

## What a workspace is

Spyglass reads the workspace declaration, `pnpm-workspace.yaml#packages` or
else the root `package.json#workspaces`, and treats every directory those
patterns match that has a `package.json` with a name and at least one `.ts`
or `.tsx` file as a package. Without a workspace declaration, a named package with TypeScript sources is
scanned as a standalone package. Workspace declarations take precedence.

The configuration directory, `.foundry/spyglass/` at the root, configures the
scan. Each configuration file in it default-exports part of the
configuration, and a key is declared in one file only:

```ts
// .foundry/spyglass/index.ts
export default {
  exclude: ["packages/fixtures"],
  history: { checkpoints: 12, range: "1y", strategy: "monthly" },
};
```

Scanning a workspace runs these files with your privileges. See
[Configuration](https://github.com/Francois-Esquire/foundry/blob/main/docs/spyglass/reference/configuration.md)
for every setting.

## Where output goes

```text
~/.foundry/spyglass/<id>/
  workspace.json       the workspace record: root, id, Spyglass version, last scan
  lock                 held while a scan runs
  output/              the dataset the viewer reads
    manifest.json      what was scanned and skipped, each package's declared
                       dependencies, and where every file is, itself or
                       through modules/index.json (history/ has its own)
    workspace.json     the whole workspace report
    packages/          one report and one projection per package
    modules/           file records and import edges, sharded by package
    projections/       the dependency graph and other renderer-neutral views
    lenses/            views derived from the dataset, one file per lens
    visualization/     prepared island geometry and shared dependency footprints
    dependencies/      the declared and resolved third-party dependency inventory
    concepts/          the concept index
    internals/         per-package internal structure evidence
    history/           checkpoints, timeline, and deltas with --history
  cache/               analysis cache; delete the directory to force a rebuild
```

`<id>` is the first 12 hex digits of the SHA-256 of the resolved workspace
path.

`--state` replaces `~/.foundry/spyglass`. The server maps `/data/*` to
`output/*` unchanged and never serves the cache.

Documentation: <https://francois-esquire.github.io/foundry/spyglass/>

## Rendering

The viewer draws its map with Islands, a WebGPU renderer, and needs a browser
with WebGPU; without it the map says so in place of the chart. The compass in
the top-right corner opens **Chart controls**: **Rendering** sets the
camera's angle and the sea's waves, and **Reset visualization** sits above the
tabs. Zoom and overview live in the app bar extending left from the compass,
with the **Labels** and **Ruler** toggles. The bottom bar opens the
introduction and the legend. On the Vite dev server, the app bar also shows
FPS, and **Stats** shows the renderer's status and the map's composition. FPS
counts the frames Islands submits and reads zero when the chart is still.

Clicking an island selects it, and the camera frames it; Escape, or the
overview button, returns to the whole chart. The camera stays north-up, and
the labels, the coordinates and the latitude scale are set over the canvas as
DOM, so they stay upright and readable by assistive technology. Islands
draws the land, the shallow banks of shared dependencies, the towns where the
files are, and the sea; the waves stand still under reduced motion.

After analysis and lenses finish, a visualization preparation pass saves
`visualization/map.json`: settled island positions and terrain, dependency membership,
and one vector footprint per distinct shared group. The artifact carries schema,
geometry policy, input identity, and layout settings. Unchanged inputs reuse it;
changed inputs or policy rebuild it. The viewer also uses the same preparation
code for older datasets without this artifact, and makes the Islands chart
from the map it laid its islands out from, so the chart and the labels share
coordinates.

The original dependency layout, layer spacing, and island clearance establish a
baseline first. Shared dependencies then shorten each related pair's baseline
distance, with each additional shared dependency increasing the contraction
(up to half the original distance). Transitive paths and ubiquitous dependencies
contribute less. A gentle anchor to the original positions prevents aggregate
collapse; unshared pairs receive no extra attraction. Land components keep separate
convex coast envelopes with an 8-unit safety gap, while underwater shelves can
overlap. Dependency inventory comes
from package manifests, including packages without TypeScript analysis; resolved
transitive edges currently come from supported Bun text lockfiles. Missing or
unsupported lockfiles and unresolved targets are disclosed as incomplete coverage.
Old datasets remain readable without foundations.

## Development

```sh
bun run dev:spyglass                       # scan Foundry and open the hot-reloading viewer
bun run dev:spyglass:package               # scan Spyglass itself as one package
bun run dev:spyglass -- /path/to/workspace  # another workspace or standalone package

# From apps/spyglass, the equivalent commands are:
bun dev                                   # Foundry workspace
bun dev:package                           # Spyglass package
bun dev:package /path/to/package           # another standalone package

bun run --filter @foundry.sh/spyglass build # dist/lib and dist/web
bun run --filter @foundry.sh/spyglass typecheck
bun run test --filter=@foundry.sh/spyglass
bun run --cwd=apps/spyglass test:package      # install the tarball and run the bin
```

`build` clears `dist`, bundles the CLI, the library entry, both workers, and
their shared chunks into `dist/lib` with Bun, writes the library's
declarations to `dist/lib/index.d.ts` with tsup, and builds the viewer into
`dist/web` with Vite. `dev` and `dev:package` scan incrementally before starting Vite with hot reload.
No prior build or saved dataset is needed. Restart the command to refresh analysis
after changing the analyzed sources. Both modes accept paths, `--state`,
`--history`, `--port`, and `--no-open`; the default port is 4173. One Vitest run, on Bun, covers the library, the viewer,
`serve`, the built CLI, its worker and server, and the browser loaders. `test:package` packs the tarball, installs it into a
temporary consumer, and drives the installed bin, the library under Bun and
Node, and a TypeScript consumer of its declarations, which is what the
release workflow runs before publishing.

`scripts/capture.ts` is a manual look check, outside the test command: it
opens a running viewer in a headless Chrome over the DevTools protocol, runs
steps such as `zoom=6`, `tap=510,810`, `press=Chart settings`, `shot=name`, and `errors`,
and saves screenshots under `.cache/shots`. Pass `--browser` with the path to
a Chrome binary; it launches Chrome with WebGPU enabled, which the map needs
(a browser without it shows the viewer's no-WebGPU message).

```text
src/cli/       commands, argument parsing, progress, browser opening
src/lib/       the library: scan, serve, the dataset, and the analyses
src/server/    static file server behind lib/serve.ts
src/web/              browser viewer: data loading, layout, labels and settings
src/web/ui/           React chrome, hooks, the map's host and the stylesheet
src/web/islands-host/ the bridge to the Islands renderer: its API, the chart loader
src/web/islands/      the Islands WebGPU renderer, a synced copy (see its README)
public/               the viewer's static files
```

The viewer composition lives in `src/web/ui/spyglass-view.tsx`. It instantiates a
plain `SpyglassState` and passes the current state explicitly to `SpyglassShell`
and its nested `IslandsMap`. `useSpyglassState` holds selection and data-loading
bindings; drawer visibility and focus stay in the shell. The map owns the
renderer's lifetime, while camera commands use a separate map ref.
There is no context provider. Only `src/web/islands-host/` imports the
renderer (the layer check enforces it); the UI reaches WebGPU through it.

Add `?view=map` to the viewer URL to render the interactive map without the
shell. `IslandsMap` fills its parent, so embeds must give that parent a height.
The docs embed and full-screen example both use this mode.

Analyzer fixture source under `test/lib/fixtures` is test input and is
excluded from lint and dead-code analysis. All configuration is CLI
arguments; use Varlock if environment settings are introduced.


### Existing Atlas installations

Use `spyglass` and `@foundry.sh/spyglass` going forward. Move configuration to
`.foundry/spyglass/`; the previous `.foundry/atlas/` directory remains readable
when the new one is absent. New workspaces use `~/.foundry/spyglass/`, while
existing scans under `~/.foundry/atlas/` remain available without being moved.
An explicit `--state` overrides both defaults. Static exports from the previous
name retain their replacement safeguards when refreshed with Spyglass.
