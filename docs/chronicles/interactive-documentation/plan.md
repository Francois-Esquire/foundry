# Interactive documentation: plan

Round 1: investigation and design only. No production changes, no new
dependencies, nothing committed. Written 2026-11-04 on branch
`docs/interactive-documentation`, HEAD
`99e225798344a89e1d2841dc84a67e1ca3f7fb1d`.

Supporting artifacts:

- [ia-inventory.md](ia-inventory.md): the current site, where each requested
  journey lives today, and the proposed Marbles map.
- [reuse-candidates.md](reuse-candidates.md): the external revision, every
  reusable file with its path, and the Blume and Astro seams found in
  installed sources.
- [url-state.md](url-state.md): anchors, coordinates, schemas, encoding, size
  limits, and reset/back-forward behavior for Phase B.

`docs/chronicles/` is outside Blume's content globs, so none of this publishes.
Public pages should explain the product simply; the architecture stays here.

## User requirements and my recommendations

User requirements, as given:

1. Bring the documentation to life with illustrations and vgpu work from the
   prototypes repository.
2. Organize the information architecture, with clear journeys for getting
   started, the authoring library, standalone workflows, MCP, the software
   factory, and monitoring.
3. A second part that reorganizes the documentation and introduces scribbled
   or drawn annotations, shareable URL state that can affect layout, ways to
   point to parts of pages, and a way to transfer selected documentation into
   a write-up.

Everything else in this plan is my recommendation and is labeled that way
where it could be mistaken for a requirement. What "transferred/written up"
means is an open product choice (section B4).

## What I inspected and ran

Inspected by reading source:

- This worktree: `docs/blume.config.ts`, all 18 `meta.ts` files, frontmatter
  and headings of every published page, `docs/pages/index.astro`,
  `docs/scripts/build-example.ts`, `docs/package.json`, `turbo.json`,
  `tsconfig.json`, `marbles/contributing.md` (documentation section).
- Installed Blume 1.6.3 and Astro 7.3.2 sources and Blume's bundled docs
  (islands, customization, syntax, export, schema, layout, router, island
  runtime). Specific lines are in reuse-candidates.md.
- The prior worktree `.worktrees/docs-library-website` (read-only): branch
  `docs/library-website` at `1898a394`, its `IMPLEMENTATION-REPORT.md`, its
  uncommitted diff summary, and the headings of its new pages. Compared against
  current main.
- The prototypes repository (read-only) at `642ac5d`, with 52 dirty entries
  concentrated in `apps/web/src/gpu/islands/`. Details in reuse-candidates.md.
- `apps/spyglass/package.json` in this repo, to see existing graphics
  dependencies (`three` 0.185, React 19.3.0).

Executed: nothing beyond read-only shell commands (`git status`, `git log`,
`git diff --stat`, `ls`, `grep`, `sed`, `cat`). No build, test, typecheck,
docs check, dev server, browser, GPU capture, or network call.

Setup state, checked before deciding not to run tools:

- `copy.log`: "Copied 280734 files · 13.7 GiB (reflinked, no extra disk)".
- `install.log`: Bun 1.3.14 installed 153 packages, but the `husky` prepare
  step failed with "could not lock config file
  /Users/miketobia/code/foundry/foundry/.git/config: File exists", most likely
  because several worktrees' hooks ran at once. I did not retry or work
  around it during the investigation. Parent follow-up: rerunning only
  `bun run prepare` after the concurrent setup hooks finished succeeded;
  the configured hooks path and generated hook files are present.
- This worktree and the main checkout were clean when checked.

## A finding that changes the premise

The prototypes do not contain illustrations that explain Marbles concepts.
Nothing there draws a step, a workflow, a run, a retry, or a schedule. What
they do have:

- a style layer: `shaders/illustration/paper.wgsl` (paper grain and pigment
  wash), toon shading and outlines, a painterly filter;
- a lifecycle contract for starting and tearing down a GPU scene on a canvas
  (`lab/experiment.ts`, `components/experiment-view.tsx`, `gpu/pond/pond.ts`);
- reduced-motion handling in one scene (`gpu/marble-slide/page.tsx`).

So the concept illustrations have to be authored for Foundry. The prototypes
supply how they look and how they run, not what they show. The one scene that
matches the product name, the marble slide, is a full-viewport, scroll-driven
3D apparatus that would fight a docs page (reuse-candidates.md, "The one
thematically close scene").

Two more constraints on reuse:

- The user explicitly authorized bringing work from their prototypes
  repository into Foundry. Record source paths and revisions when adapting
  its WGSL and preserve any existing notices. No additional source-reuse
  permission is pending for that requested work.
- Its manifests use `catalog:` and its tests use `bun test`. Neither carries
  over.

## Phase A: information architecture and illustrations

### A1. Current inventory

Summary (full table in ia-inventory.md): three tabs, 75 published pages, 32
redirects. Marbles has Get Started, Foundation (12), Use Cases (4 groups, 30
pages), Reference (10), Roadmap. Only five pages are MDX. No islands, no
`components.ts`, so no page ships React today. The only live visual is the
Spyglass viewer in an `<iframe>`.

### A2. Proposed navigation and journeys (recommendation)

The full map and the reading path for each journey are in ia-inventory.md.
In short:

- Retitle Foundation to "Write automations" without moving its files. This is
  the authoring journey.
- Add "Run and connect" (`run/`) for standalone workflows and MCP: a new
  "One workflow, three ways" page, a new MCP guide, and the moved
  `execution-and-state` and `engine` pages.
- Add "Monitor and operate" (`operate/`): a new "Watch runs and the Feed"
  page, plus `usage` and `troubleshooting` moved in.
- Put a four-step summary at the top of Software Factory, and add "Monitor the
  factory".
- Leave Spyglass and Prompts as they are.

Two terms need the user's reading before this is final: "authoring library"
(the authoring API, or the `/lib` embedding entry?) and "standalone
workflows" (runs without the dashboard, or `@foundry/workflows` on its own?).
The map assumes the first reading of each.

### A3. Representative pages for illustrations (recommendation)

Three pages, each with one figure. Each explains an idea that prose and
tables already state but that a picture makes faster to grasp:

| Page | Figure | What it shows | Motion, if any |
| --- | --- | --- | --- |
| `foundation/api.md` (The Marbles model) | Definition, workflow, run | One definition placed in a workflow; two runs of it, each with its own results. Separates "what is declared" from "what executed". | A run token moves through the workflow once, then rests. |
| `foundation/composition.md` | Dependency order | A small tree: two independent steps run side by side, then a third waits for both results. | Steps fill in the order the engine would run them. |
| `foundation/durability.md` | Replay versus retry | A run that parks on a question and resumes, compared with a failed attempt that retries. The page's "Replay is different from retry" section is the anchor. | Two short sequences side by side; static by default under reduced motion. |

Spyglass pages already embed the real viewer, so they get no illustration.
The Software Factory loop is a good fourth candidate after these three land.

Visual direction (recommendation): ink diagrams on paper, using
`paperGrain`/`washDensity` for texture under authored vector shapes. This
fits the existing Prompts screenshots and the neutral gray theme better than
3D scenes. Toon-shaded marbles are a possible later accent, not a first step.

### A4. Adaptation seams

**Static first.** Each figure is an authored SVG with `<title>` and `<desc>`,
rendered server-side inside `<figure>` with a `<figcaption>`. The SVG is the
content. The GPU layer adds paper texture and optional motion on top. If the
GPU layer never starts, the reader loses texture and motion, not meaning.
Blume's `/<route>.md` output and print/PDF both keep the static figure. How
Blume downlevels a custom island in `.md` output is not verified; the figure
should carry a text alternative that survives either way.

**The island.** One island, `docs/islands/Illustration.tsx`, used as
`<Illustration name="composition" />` in MDX (the three pages become `.mdx`).
It hydrates on `client:visible` (Blume's default), checks capability, then
dynamically imports the scene module. Pages without an illustration ship no
React, per Blume's islands documentation.

**The scene contract**, narrowed from `lab/experiment.ts`:

```ts
// Sketch, not for implementation yet
interface SceneContext {
  reducedMotion: boolean;
  theme: { ink: string; paper: string; accent: string }; // read from CSS variables
  onError: (error: unknown) => void;
}

interface Scene {
  start(canvas: HTMLCanvasElement, context: SceneContext): Promise<() => void>;
  setTheme(theme: SceneContext["theme"]): void;
  play(): void;
  pause(): void;
}
```

Dropped from the prototype contract: params store, debug panel, stats,
overlay. Kept: `start` resolves to a teardown, and GPU code loads only inside
`start`.

**WGSL loading.** Both options are plausible; neither has been tried. I am
not choosing between them.

| Option | How | Risk |
| --- | --- | --- |
| Vite plugin through Blume | An Astro integration in `blume.config.ts` `integrations` whose `astro:config:setup` hook adds `wgslVitePlugin()` from `@vgpu/wgsl/loader-vite`. Shaders import as modules, as in the prototypes. | Couples the docs build to the plugin and Blume's generated Astro config. Blume regenerates `.blume/` on config change. |
| Prebuild script | A Bun script beside `scripts/build-example.ts` that resolves each entry shader with `@vgpu/wgsl/prepare` into a generated TS module. | Generated files need a Turbo output entry and a clean rule. Reflection metadata may differ from the plugin path. |

**Where code lives.** In the `docs` package: `docs/islands/`, and
`docs/illustrations/<name>/` for scenes and shaders. No new workspace package
until a second consumer (the foundry.sh site, for example) needs it.

**Repository wiring the first slice needs** (none added this round):

- `docs/package.json`: explicit versions of `vgpu`, `@vgpu/wgsl`,
  `@vgpu/wgsl-std` (0.6.0 to match the prototypes; `lattice.wgsl` needs
  `wgsl-std`), `@webgpu/types`, `happy-dom` (the DOM test environment
  `apps/spyglass` already uses, needed by acceptance criteria 4 and 5), and `react`, `react-dom`,
  `@types/react` pinned to the versions `apps/spyglass` uses (19.3.0) so
  Sherif stays happy. Whether Blume's "React works out of the box" relies on
  its own `react` dependency or the project's was not checked.
- `docs/tsconfig.json` `include` covers only `blume.config.ts`, `**/meta.ts`,
  and `scripts/**/*.ts`. Islands and scenes would be untypechecked until it
  includes them with JSX settings.
- `knip.json`: entries for `docs/islands/**` and `docs/illustrations/**`,
  since Blume loads islands by convention.
- `docs/package.json` gets a `test` script that is one `vitest run`. AGENTS.md
  places tests in `src/test/` for packages and `test/` for apps; `docs` is
  neither, so its test location needs a decision (I'd use `docs/test/`).
- WGSL validation runs through the locally installed
  `node_modules/.bin/vgpu check --require-validation`, never `bunx`.

### A5. Resource lifecycle

Verified by reading Astro's island runtime: when the client router swaps
pages, a disconnected island dispatches `astro:unmount` after
`astro:after-swap`, and the React client calls `root.unmount()`. Effect
cleanups therefore run on client navigation, and teardown can live in the
island's effect cleanup. This has not been observed in a browser.

Rules (recommendation):

- One `Gpu` per figure, created only after the figure is visible and capable.
  At most three figures per page, so a shared device is not worth the
  coordination yet.
- Reuse the prototypes' sequencing: a pending-start chain so a remount waits
  for the previous start (`experiment-view.tsx`), and a disposed check after
  `init()` that disposes a late device without touching the canvas
  (`pond.ts`).
- Stop the frame loop when the figure leaves the viewport
  (`IntersectionObserver`) or the tab is hidden, and when an animation
  finishes. The prototypes do neither for pond; docs must.
- On device loss, dispose and stay on the static figure.
- Teardown removes every listener and attribute it added, as `pond.ts` does.

### A6. Loading and performance (recommendation)

- No JS on pages without figures. On figure pages, nothing GPU-related loads
  before the figure scrolls into view and passes the capability check.
- Reserve the figure's aspect-ratio box in the static HTML so hydration never
  shifts layout.
- Clamp DPR to `[1, 1.5]` like `pond.ts`.
- Budget to verify in the first slice: added gzipped JS per figure page
  measured from the build output, with a target set once the first number
  exists. vgpu's README claims 25 KB gzipped for a fullscreen effect;
  unmeasured here.
- Render on demand. A figure without motion draws once and on resize or theme
  change.

### A7. WebGPU availability and fallback

- No `navigator.gpu`, or `requestAdapter()` returns nothing: keep the static
  figure, show nothing about WebGPU. Readers came for the docs.
- Shader compile or device errors: keep the static figure; log in development
  only. Do not copy the prototype's "WebGPU isn't available" message, which it
  shows for every error.
- No claims about which browsers pass. That needs real browser checks.

### A8. Reduced motion and accessibility

- `prefers-reduced-motion: reduce`: draw one still frame and do not
  auto-play (as `marble-slide/page.tsx` starts paused). A Play button stays
  available.
- Any motion longer than five seconds gets a visible pause control (WCAG
  2.2.2).
- The SVG carries the meaning: `<title>`, `<desc>`, and a `<figcaption>`. The
  canvas is `aria-hidden` when it is texture and motion only.
- Interactive figures (none proposed in the first three) would need keyboard
  equivalents and focus styles, following `pond.ts`.
- Ink and paper colors come from Blume's CSS variables, so the figure follows
  light and dark themes. Contrast is checked against both.

## Phase B: reorganization and annotations

### B1. Reorganization: what is left from the prior worktree

Main's cleanup (`fffbe6d5`) removed old maintainer notes. Main already has
several fixes the prior worktree made: the MCP task tools, the `tasks` CLI
row, Pi as an agent CLI, and `piProvider` in the engine table. Still not on
main, and worth re-deriving (not copying):

| Prior item | Use here |
| --- | --- |
| `library/one-workflow-three-ways.md` with a test that runs it through the CLI, an embedded engine, and the MCP server | Seed for the "Run and connect" entry page. The test is in `apps/marbles/test/docs-library-examples.test.ts` in that worktree. |
| `software-factory/monitor.md` | Seed for "Monitor the factory" and the monitoring journey. |
| "The factory in four steps" on the Software Factory index | Seed for the top of that page. |
| Moving `reference/engine.md` with legacy anchors kept | Matches the proposed MOVE; reuse its anchor approach. |
| Docs example typechecking (`apps/marbles/tsconfig.json` include, Turbo inputs) and exact-match Vitest aliases | Main's `apps/marbles/vitest.config.ts` still has prefix-matching aliases, so `@foundry.sh/marbles` can capture `@foundry.sh/marbles/lib`. Worth a separate small change outside this docs work. |
| npm availability in `installation.md` | Main still says "not yet available from npm". The prior report says `0.0.1` and `0.0.2` were published on 2026-10-17. Needs a fresh check before editing. |
| `docs/_social/` drafts | Not relevant here. |

Also recommended for B1: pin anchors (`[#id]`) on every heading that
pointers, redirects, or illustrations target, and add a line to
`contributing.md` saying so.

### B2. Annotation interactions (sketch)

A "Mark up" toggle in the page actions area (a Blume `PageHeader` or
`TableOfContents` slot; which one fits needs a look in the browser). Off by
default. When off, the page behaves exactly as now.

When on:

- **Tools.** Pen, marker, highlight (from a text selection), note, eraser,
  undo, redo, clear. Keyboard shortcuts only where they do not collide with
  Blume's search shortcut.
- **Input.** Pointer Events. Touch scrolls the page unless the pen tool is
  active and the input is a stylus, so phones stay usable. `touch-action:
  none` applies only to the overlay while drawing.
- **Rendering.** One SVG overlay over the article, redrawn from block boxes on
  resize. Plain SVG, not WebGPU. An ink texture from `paper.wgsl` is a later
  option.
- **Anchoring.** Ink attaches to the block under the stroke's first point;
  highlights use text quotes and reflow exactly. Details in url-state.md.
- **Orphans.** Marks whose block no longer exists are listed, not drawn in the
  wrong place.
- **Accessibility.** Marks are listed as text in a marks panel ("Ink near:
  'Replay is different from retry', paragraph 2"). Highlights and notes can be
  made by keyboard from a text selection. Freehand ink is pointer-only, and the
  panel is its equivalent.
- **Pointing.** Each block gets a "Copy link to this paragraph" affordance,
  next to Blume's existing heading anchors. The link uses `?p=` (url-state.md).
  A zero-code alternative for read-only pointing is browser text fragments
  (`#:~:text=`); support across browsers was not checked.

### B3. URL state (summary)

Full contract in url-state.md. The decisions that matter:

- State lives in the query (`p` pointer, `l` layout, `m` marks). The hash
  stays a plain heading anchor. Reason: Astro's router treats a different
  `search` on the same path as a new page but keeps hash changes in place, and
  Blume's anchors, TOC, and `:target` all depend on a plain hash.
- Our code never calls `pushState`; it uses `replaceState` and keeps the
  router's `history.state`.
- Layout and marks are separate params with separate versions. A bad mark
  payload never resets layout.
- Layout updates the URL live. Marks stay in a local draft and enter the URL
  only on Share (recommendation; the alternative is live marks in the URL).
- Versioned prefix `1.`, deflate-raw plus base64url for marks, 2,000-character
  soft cap with a `.json` download beyond it.

### B4. Assembling a write-up (open product choice)

"Transfer selected documentation into a write-up" can mean several things.
Smallest sensible options, all client-only, none needing a backend:

| Option | What the reader does | Seam | Size |
| --- | --- | --- | --- |
| 1. Copy as Markdown | Adds sections to a collection while reading, then copies them as one Markdown document with a source link under each. | Blume emits `/<route>.md` for every page, with `<include>` statements expanded (read in source, not observed in output). Slice it by heading (ids use `github-slugger`, same as headings). | Small |
| 2. Download a Markdown file | Same collection, saved as a `.md` file. Optionally includes the reader's highlights and notes as quotes. | Same as 1. | Small, once 1 exists |
| 3. Print the collection | A `/collect` page renders the collected sections, then the browser's print dialog saves a PDF. | Blume custom pages (`docs/pages/`) and its print stylesheet. | Medium |
| 4. Hand off to a chat tool | Send the collection to Blume's existing "Open in chat" providers. | `ai.openInChat` in Blume's config, off here. | Small, but it sends content to an external service, so it should stay opt-in and probably out of scope. |

Recommendation: options 1 and 2 together. Ink marks stay out of the export at
first; highlights and notes export as quotes. No collaboration backend, no
publishing integration.

## Implementation order (recommendation)

1. **Illustration spike plus one figure** (first slice, below). It carries the
   most unknowns and decides the dependencies.
2. **IA reorganization.** Content-only; can run in parallel with 1. Moves,
   redirects, pinned anchors, the new guide pages.
3. **Pointers and layout state.** `?p=` and `?l=`, block links, focus mode.
4. **Marks.** Overlay, tools, local draft, Share.
5. **Write-up.** Collection, copy and download as Markdown.
6. **The other two figures**, then the Software Factory loop.

## First slice and acceptance criteria

Scope: one figure on `foundation/composition.md` (converted to `.mdx`), the
`Illustration` island, the scene contract, and one WGSL loading path chosen
after a short spike of both options.

Acceptance criteria:

1. With JavaScript disabled, the page shows the complete figure (SVG with
   title, description, caption) and the same text as before.
2. Pages without the figure ship no new JavaScript; verified by comparing
   build output for one such page before and after.
3. On the figure page, no `vgpu` chunk is requested until the figure is in
   view. Verified in a browser's network panel.
4. With `navigator.gpu` absent, the static figure remains and no message about
   WebGPU appears. Covered by a Vitest test using a DOM environment.
5. Under `prefers-reduced-motion: reduce`, the figure draws one frame and does
   not animate. Covered by a test of the island's start options.
6. Navigating away through the client router runs teardown: the frame loop
   stops and the device is disposed. Covered by a test against `vgpu/mock`
   (deterministic, no GPU), plus one manual browser check.
7. Scrolling the figure out of view stops the frame loop.
8. Light and dark themes both render the figure with readable contrast.
   Manual check.
9. The vendored or rewritten WGSL passes `vgpu check --require-validation`
   through the local binary, and its provenance is recorded in the shader
   file header.
10. `bun run validate`, `bun run --cwd=docs docs:check`, and the docs build
    pass. The docs package's `test` script is one `vitest run`.

Items 3, 6 (manual part), 7, and 8 need a browser and a GPU. Nothing in this
round proves any of them.

## Unknowns

- Whether the Astro integration route for `wgslVitePlugin` works inside
  Blume's generated config, and whether `@vgpu/wgsl/prepare` produces modules
  vgpu accepts at runtime.
- Whether Blume's React support resolves `react` from the project or from
  Blume, and what that means for Sherif and Knip.
- How Blume's `.md` output downlevels a custom island.
- Whether a project can add an early head script for layout state, and whether
  `Tabs`/`Accordion` ids are stable enough to drive from `?l=`.
- Real browser behavior of the router with our `replaceState` calls and
  `?p`/`?l`/`?m` on back and forward.
- GitHub Pages' URL length limit.
- npm status of `@foundry.sh/marbles`.
- The exact source paths/revisions and existing notices to retain for the
  modules selected for adaptation; source reuse is already authorized.

## Decisions for the user

The next concrete decision: **approve the first slice as scoped above**,
which includes confirming that Foundry authors its own concept figures and
uses the prototypes for style and lifecycle only.

Then, in any order:

1. Confirm the readings of "authoring library" and "standalone workflows",
   and approve or adjust the Marbles map in ia-inventory.md.
2. Whether adapting `paper.wgsl` and its two noise dependencies or writing
   a smaller effect against `@vgpu/wgsl-std` fits the first figure better.
3. What a "write-up" is: options 1 and 2 (recommended), or something else.
4. Marks in the URL only on Share (recommended), or live.
