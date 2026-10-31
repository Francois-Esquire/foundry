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

  spyglass [path...]                      Scan, serve, and open the browser
  spyglass scan [path...]                 Scan and save each workspace's dataset
  spyglass serve [path...]                Serve the saved datasets without scanning
  spyglass report <package> [path...]     Print a package report from the saved dataset
  spyglass lens <id> [path...]            Print a lens from the saved dataset
  spyglass check [path...]                Check the workspace's rules against the saved dataset
  spyglass plan <opportunity> [path...]   Plan one opportunity and authorize it; writes nothing in the workspace
  spyglass apply <opportunity> [path...]  Preview a planned change; write and verify it with --write
  spyglass export <dir> [path...]         Write a static viewer of the saved datasets to <dir>

The path defaults to the current directory. spyglass, scan, serve, and export read
several paths as one collection; the other commands read one workspace.
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
dataset errors, and the two schema versions; the analyses themselves
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

The viewer draws with WebGPU and falls back to WebGL 2 where WebGPU is
unavailable. The compass in the top-right corner opens **Chart controls**;
**Map** contains measured overlays, **Rendering** contains atmosphere, and
**Reset visualization** sits above the tabs. Zoom and overview live in the app bar
extending left from the compass. The bottom bar holds the Belonging/Files
reading mode switch and the legend. On the Vite dev server, the app bar
also shows FPS. Development adds **Layers** for layout and boundaries,
**Stats** for live composition, and lighting controls under **Rendering**. FPS counts map frame submissions and reads zero
when idle.

The viewer keeps its fixed cartographic camera angle while panning, zooming,
and exploring. Files retain their map marks, and labels stay upright.

At world scale, package routes carry the relationships. File dependency routes
appear closer in, with at most 12 or 24 relationships according to zoom. A selected
file takes priority; otherwise routes stay within the viewed or selected package.
Arrowheads point toward the imported file. The legend explains the current
composition and keeps additional enabled symbols in an expandable section.

In development, **Layers → Scene visibility** can hide or solo each drawable
layer, including the ocean, island surfaces, cliffs, marks, labels, and chart
furniture. **Ocean**, **Clean ocean**, **Terrain only**, and **Annotated map** are temporary isolation
presets. While isolated, the layer checkboxes add or remove parts of that view;
**Restore previous view** returns to the visibility choices made before isolation.
**Show all** clears both isolation and hidden-layer choices. These controls keep
the same canvas, camera, geographic data, and selection. Existing data, zoom, and
overlay settings still determine whether an enabled layer has anything to draw.
The separate connecting-land and road-generation settings still rebuild geometry.

**Ocean** retains the complete water appearance. **Clean ocean** keeps the base
water and paper texture with depth shading, shallows, foundations, foundation light,
surf, and surface motion off. The **Effects** group controls those ingredients independently; an effect's
**Solo** button includes the ocean surface. Foundation light is confined to the underwater plateaus. Rendering's atmosphere
toggles still gate foundation light and water motion, and
reduced motion freezes their phase. With both off and no other animation, the
scene becomes idle. Depth shading and shallows do not animate.

Surface motion combines wave bands of different lengths and directions, with
curved crests and calmer patches. Fine bands fade at distant zoom levels to
avoid shimmer. It changes water lighting only; coastlines and map positions
stay fixed.

**Foundations** shows shared third-party runtime and optional dependencies as
underwater plateaus. Dependencies shared by the same set of islands form a group.
The overview draws every shared group, with no ranking cutoff. The foundation
selector can inspect each group's islands and full dependency list, or each
individual dependency's resolved versions and consuming islands. Direct and transitive reliance are distinguished. Static import counts
refine direct reliance without treating unobserved imports as proof of non-use.
Missing usage is shown separately from an analyzed zero count.

After analysis and lenses finish, a visualization preparation pass saves
`visualization/map.json`: settled island positions and terrain, dependency membership,
and one vector footprint per distinct shared group. The artifact carries schema,
geometry policy, input identity, and layout settings. Unchanged inputs reuse it;
changed inputs or policy rebuild it. The viewer also uses the same preparation
code for older datasets without this artifact.

Each shared group generates six nested contour planes from broad coast-distance
fields. Nearby shelves merge naturally; distant consumers are not joined by
synthetic paths. The ocean rasterizes these planes into independent group masks.
Their overlap is normalized to a bounded height field and rendered as twelve
depth bands, with illuminated lips and shaded drop-offs into deeper open water. Coastal glow remains independent of the
foundation layer. Focus combines existing masks;
visibility and appearance update material settings. Neither reruns dependency
analysis or changes island positions. Deliberate layout changes rebuild the footprints.

The original dependency layout, layer spacing, and island clearance establish a
baseline first. Shared dependencies then shorten each related pair's baseline
distance, with each additional shared dependency increasing the contraction
(up to half the original distance). Transitive paths and ubiquitous dependencies
contribute less. A gentle anchor to the original positions prevents aggregate
collapse; unshared pairs receive no extra attraction. Land components keep separate
convex coast envelopes with an 8-unit safety gap, while underwater shelves can
overlap. The camera retains its existing padded bounds.
**Shared-dependency pull** controls that strength from 0× to 4×, with Off, Standard
(1×), and Strong (3×) presets. Zero restores the original layout rules. Selecting, hiding,
or isolating a foundation changes presentation only. Dependency inventory comes
from package manifests, including packages without TypeScript analysis; resolved
transitive edges currently come from supported Bun text lockfiles. Missing or
unsupported lockfiles and unresolved targets are disclosed as incomplete coverage.
Old datasets remain readable without foundations.

Seabed relief blends locally into the original depth-colored ocean: screen
light on shelf tops and lips, multiply shading on descending faces. Outside
the shelves the ocean color is unchanged; coast glow remains independent.

**Foundation light** repurposes the effect formerly labelled **Cloud shadow** and
**Subsurface drift**. The soft moving light is decorative; the dependency plateaus
remain anchored to the map. The `clouds` and `waves` reader-setting keys remain
compatible, with displayed names Foundation light and Water motion. Isolation
changes material uniforms without rebuilding the water, geography, or shader graph.

**Lighting and color** controls the post-processing pipeline: quality tier,
tone mapping, exposure, saturation, vibrance, ambient occlusion, bloom, and
indirect light. Production builds omit the developer panel and use the
default tier; `?dev` cannot enable it. Quality **Off** draws the scene directly. Low, Medium, and High trade resolution and denoising for speed; they
never remove a control.
If the pass graph cannot compile on a device, the viewer returns to the direct
draw and the panel reports it.

Sliders are live uniforms; only quality, toggles, tone mapping, and the stage
view rebuild the graph. Occlusion reach is a screen size in pixels, so
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
`--history`, `--port`, and `--no-open`; the default port is 4173. Vitest covers the library and renderer, apart from serving,
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

The viewer composition lives in `src/web/ui/spyglass-view.tsx`. It instantiates a
plain `SpyglassState` and passes the current state explicitly to `SpyglassShell`
and its nested `SpyglassMap`. `useSpyglassState` holds selection and data-loading
bindings; drawer visibility and focus stay in the shell. The map owns the
scene lifetime, while camera commands use a separate map ref.
There is no context provider.

Add `?view=map` to the viewer URL to render the interactive map without the
shell. `SpyglassMap` fills its parent, so embeds must give that parent a height.
The docs embed and full-screen example both use this mode.

Analyzer fixture source under `test/lib/fixtures` is test input and is
excluded from lint and dead-code analysis. All configuration is CLI
arguments; use Varlock if environment settings are introduced. See
[migration notes](docs/migration.md) for the source mapping.


### Existing Atlas installations

Use `spyglass` and `@foundry.sh/spyglass` going forward. Move configuration to
`.foundry/spyglass/`; the previous `.foundry/atlas/` directory remains readable
when the new one is absent. New workspaces use `~/.foundry/spyglass/`, while
existing scans under `~/.foundry/atlas/` remain available without being moved.
An explicit `--state` overrides both defaults. Static exports from the previous
name retain their replacement safeguards when refreshed with Spyglass.
