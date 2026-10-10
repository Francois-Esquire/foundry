# Atlas

Workspace analysis as a CLI, a library, and a local viewer. Point it at a
directory of TypeScript packages; Atlas analyzes them, saves the result
outside the workspace, and serves a map you can explore in the browser:
packages as territories, files as settlements, dependencies as the routes
between them.

Atlas runs on [Bun](https://bun.sh) 1.3.14 or newer. Git is optional: a scan
reads evolution from the Git log, and `--history` analyzes Git checkpoints,
when `git` is on the PATH.

```sh
bun add -g @foundry/atlas     # once published
atlas /path/to/workspace      # scan, serve, open the browser
```

Until the package is on npm, run it from a checkout of Foundry:

```sh
git clone https://github.com/Francois-Esquire/foundry.git
cd foundry && bun install
bun run --filter @foundry/atlas build
bun run atlas -- /path/to/workspace
```

## Commands

```text
Atlas — workspace analysis and a local viewer

  atlas [path...]                   Scan a workspace, serve its dataset, and open the browser
  atlas scan [path...]              Scan and save the dataset
  atlas serve [path...]             Serve the saved dataset without scanning
  atlas report <package> [path...]  Print a package report from the saved dataset
  atlas export <dir> [path...]      Write a static viewer of the saved dataset to <dir>

The path defaults to the current directory; one workspace at a time.
A directory named like a command is written as a path: ./scan, ./serve, ./report, ./export.

  --state <path>        State root (default: ~/.foundry/atlas)
  --history             atlas, scan: analyze Git checkpoints as well
  --port <number>       atlas, serve: local port (default: 4173; 0 chooses a free port)
  --no-open             atlas, serve: do not open the browser
  --format <format>     report: terminal, text, markdown (default: terminal; text when piped)
  --density <density>   report: compact, normal, expanded (default: normal)
  --json                Print the result as one line of JSON
  --quiet               Print no progress
  --help, -h            Show this help

Exit codes: 0 done, 1 failed, 2 bad arguments.
```

A scan is incremental: packages whose sources have not changed reuse their
last analysis. The workspace is never modified, except where you point
`atlas export`. The server binds to `127.0.0.1` only. `report` and `export` read the saved dataset and scan
nothing; `export` writes a static viewer, the viewer and a copy of the
dataset, for any static host. See the [CLI reference](https://github.com/Francois-Esquire/foundry/blob/main/docs/atlas/reference/cli.md) for output,
`--json`, and exit codes.

## Library

The same scans and server from code:

```ts
import { scan, serve } from "@foundry/atlas";

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
dataset errors, and the two schema versions; the analyses themselves
stay internal. `serve` needs Bun; under Node, `scan` works with `bun` on the
PATH. See the [library reference](https://github.com/Francois-Esquire/foundry/blob/main/docs/atlas/reference/library.md).

## What a workspace is

Atlas reads the workspace declaration, `pnpm-workspace.yaml#packages` or
else the root `package.json#workspaces`, and treats every directory those
patterns match that has a `package.json` with a name and at least one `.ts`
or `.tsx` file as a package. A workspace that declares no packages is not
scanned.

The configuration directory, `.foundry/atlas/` at the root, configures the
scan. Each configuration file in it default-exports part of the
configuration, and a key is declared in one file only:

```ts
// .foundry/atlas/index.ts
export default {
  exclude: ["packages/fixtures"],
  history: { checkpoints: 12, range: "1y", strategy: "monthly" },
};
```

Scanning a workspace runs these files with your privileges. See
[Configuration](https://github.com/Francois-Esquire/foundry/blob/main/docs/atlas/reference/configuration.md)
for every setting.

## Where output goes

```text
~/.foundry/atlas/<id>/
  workspace.json       the workspace record: root, id, Atlas version, last scan
  lock                 held while a scan runs
  output/              the dataset the viewer reads
    manifest.json      what was scanned and skipped, each package's declared
                       dependencies, and where every file is, itself or
                       through modules/index.json (history/ has its own)
    workspace.json     the whole workspace report
    packages/          one report and one projection per package
    modules/           file records and import edges, sharded by package
    projections/       the dependency graph and other renderer-neutral views
    concepts/          the concept index
    internals/         per-package internal structure evidence
    history/           checkpoints, timeline, and deltas with --history
  cache/               analysis cache; delete the directory to force a rebuild
```

`<id>` is the first 12 hex digits of the SHA-256 of the resolved workspace
path.

`--state` replaces `~/.foundry/atlas`. The server maps `/data/*` to
`output/*` unchanged and never serves the cache.

Documentation: <https://francois-esquire.github.io/foundry/atlas/>

## Rendering

The viewer draws with WebGPU and falls back to WebGL 2 where WebGPU is
unavailable. The Chart panel's **Rendering** section controls a post-processing
pipeline: quality tier, tone mapping, exposure, saturation, vibrance, ambient
occlusion, bloom, and indirect light. Quality **Off** draws the scene directly,
exactly as before the pipeline, with the map filter applied as CSS. Low, Medium,
and High trade resolution and denoising for speed; they never remove a control.
If the pass graph cannot compile on a device, the viewer returns to the direct
draw and the panel reports it.

Sliders are live uniforms; only quality, toggles, tone mapping, the filter, and
the stage view rebuild the graph. Occlusion reach is a screen size in pixels, so
the look holds at every zoom. When the device reports frame times, a sustained
frame over budget steps the tier down one level and the panel says so; choosing
a quality again clears that. **Show stage** swaps the image for one stage's
output (occlusion, depth, indirect light, bloom) for tuning.

Indirect light (screen-space global illumination) needs a perspective camera,
so it applies to wreck dives, not the top-down chart. Relief on the chart also
carries an engraved occlusion term baked into the land geometry, which the same
Occlusion strength control drives and which shades on the direct draw too.

## Development

```sh
bun run --filter @foundry/atlas build      # dist/lib and dist/web
bun run --filter @foundry/atlas dev -- /path/to/workspace --no-open
bun run --filter @foundry/atlas typecheck
bun run test --filter=@foundry/atlas
bun run --cwd=apps/atlas test:package      # install the tarball and run the bin
```

`build` clears `dist`, bundles the CLI, the library entry, both workers, and
their shared chunks into `dist/lib` with Bun, writes the library's
declarations to `dist/lib/index.d.ts` with tsup, and builds the viewer into
`dist/web` with Vite. `dev` runs Vite with hot reload against saved output;
it never scans. Vitest covers the library and renderer, apart from serving,
which needs Bun; Bun tests exercise `serve`, the built CLI, worker, server,
and browser loaders. `test:package` packs the tarball, installs it into a
temporary consumer, and drives the installed bin, the library under Bun and
Node, and a TypeScript consumer of its declarations, which is what the
release workflow runs before publishing.

`scripts/capture.ts` is a manual look check, outside the test command: it
opens a running viewer in a headless Chrome over the DevTools protocol, runs
steps such as `zoom=6`, `tap=510,810`, `press=Chart settings`, `shot=name`, and `errors`,
and saves screenshots under `.cache/shots`. Pass `--browser` with the path to
a Chrome binary and `--webgpu` to test the WebGPU path; without it the
capture uses the software WebGL 2 fallback.

```text
src/cli/       commands, argument parsing, progress, browser opening
src/lib/       the library: scan, serve, the dataset, and the analyses
src/server/    static file server behind lib/serve.ts
src/web/       browser viewer: data loading, geography, and semantic overlays
src/web/ui/    React chrome, hooks, and the stylesheet
src/web/scene/ three.js scene, render pipeline, materials, and layers
public/        the viewer's static files, including the ship model
docs/          design notes and the migration record
```

The viewer composition lives in `src/web/ui/atlas-view.tsx`. It instantiates a
plain `AtlasState` and passes the current state explicitly to `AtlasShell`
and its nested `AtlasMap`. `useAtlasState` holds selection and data-loading
bindings; drawer visibility and focus stay in the shell. The map owns the
scene lifetime, while camera and playback commands use a separate map ref.
There is no context provider.

Add `?view=map` to the viewer URL to render the interactive map without the
shell. `AtlasMap` fills its parent, so embeds must give that parent a height.
The docs embed and full-screen example both use this mode.

Analyzer fixture source under `test/lib/fixtures` is test input and is
excluded from lint and dead-code analysis. All configuration is CLI
arguments; use Varlock if environment settings are introduced. See
[migration notes](docs/migration.md) for the source mapping.
