# Atlas

A CLI and local web viewer for workspace semantic surveys. Point it at a
directory of TypeScript packages; Atlas analyzes them, saves the result
outside the workspace, and serves a map you can explore in the browser:
packages as territories, files as settlements, dependencies as the routes
between them.

Atlas runs on [Bun](https://bun.sh) 1.3.14 or newer. Git history is optional
and needs `git` on the PATH.

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
atlas [path]         Refresh a workspace, serve it, and open the browser
atlas scan [path]    Generate output without starting the web viewer
atlas serve [path]   Serve saved output without running analysis

  --state <path>     State root (default: ~/.foundry/atlas)
  --port <number>    Local port (default: 4173; 0 chooses a free port)
  --no-open          Do not open the browser
  --history          Include Git history when scanning
  --help, -h         Show this help
```

Paths default to the current directory. A scan is incremental: packages
whose sources have not changed reuse their last analysis. The workspace is
never modified. The viewer binds to `127.0.0.1` only.

## What a workspace is

Atlas reads the root `package.json` for its `workspaces` patterns, then
treats every immediate child of `apps`, `packages`, `plugins`, and `tooling`
that has a `package.json` with a name and at least one `.ts` or `.tsx` file as
a unit. A `foundry.config.json` at the root can change the roots and exclude
units:

```json
{
  "semantics": {
    "roots": ["apps", "packages"],
    "exclude": ["packages/fixtures"],
    "history": { "checkpoints": 12, "range": "1y", "strategy": "monthly" }
  }
}
```

## Where output goes

```text
~/.foundry/atlas/<sha256 of the workspace path>/
  output/              the dataset the viewer reads
    manifest.json      what was scanned, what was skipped, where each file is
    workspace.json     the whole workspace report
    packages/          one report and one projection per package
    modules/           file records and import edges, sharded by package
    projections/       the dependency graph and other renderer-neutral views
    concepts/          the concept index
    manifests/         byte-for-byte copies of each package.json
    internals/         per-package internal structure evidence
    history/           checkpoints, timeline, and deltas with --history
  cache/               analysis cache; delete the directory to force a rebuild
```

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
bun run --filter @foundry/atlas build      # dist/cli and dist/web
bun run --filter @foundry/atlas dev -- /path/to/workspace --no-open
bun run --filter @foundry/atlas typecheck
bun run test --filter=@foundry/atlas
bun run --cwd=apps/atlas test:package      # install the tarball and run the bin
```

`build` bundles the CLI and its analysis worker into `dist/cli` with Bun and
the browser app into `dist/web` with Vite. `dev` runs Vite with hot reload
against saved output; it never scans. Vitest covers the library and renderer;
Bun tests exercise the built CLI, worker, server, and browser loaders.
`test:package` packs the tarball, installs it into a temporary consumer, and
scans and serves a fixture through the installed bin, which is what the
release workflow runs before publishing.

`scripts/capture.ts` is a manual look check, outside the test command: it
opens a running viewer in a headless Chrome over the DevTools protocol, runs
steps such as `zoom=6`, `press=Chart settings`, `shot=name`, and `errors`,
and saves screenshots under `.cache/shots`. Pass `--browser` with the path to
a Chrome binary and `--webgpu` to test the WebGPU path; without it the
capture uses the software WebGL 2 fallback.

```text
src/cli/       commands, argument parsing, workspace identity
src/lib/       semantic analysis library
src/server/    static file server
src/web/       browser viewer: data loading, geography, and semantic overlays
src/web/ui/    React chrome, hooks, and the stylesheet
src/web/scene/ three.js scene, render pipeline, materials, and layers
public/        static web assets, including the ship model
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
