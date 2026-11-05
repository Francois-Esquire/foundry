# Reuse candidates

Supporting artifact for [plan.md](plan.md). Every pointer below was read, not
run. Nothing was copied into Foundry.

## External source revision

| Field | Value |
| --- | --- |
| Repository | `/Users/miketobia/code/experiments/prototypes` (read-only) |
| Branch | `main` |
| HEAD | `642ac5d97ed8c049ce7f6a8641f2b07f4aff2de3` ("feat(web): islands towns first pass, files replanned into streets and lots") |
| Working tree | 52 dirty entries. All but one are under `apps/web/src/gpu/islands/` (modified, deleted, staged deletions, untracked files). The other is a one-line salt-index edit in `apps/web/src/shaders/README.md`. |
| Instructions read | root `AGENTS.md` (Ultracite standards). `apps/web/src/gpu/islands/AGENTS.md` exists; not applied, because nothing under `islands/` is a candidate. |
| Source reuse | The user's brief explicitly authorizes bringing work from this repository into Foundry. Record the selected source revision/paths and preserve existing notices. No additional source-reuse permission is pending. |
| Incompatible conventions | Manifests use `catalog:` (Foundry forbids catalogs). Tests and READMEs use `bun test` and `bunx ultracite` (Foundry uses Vitest only and no floating `bunx`). Manifests and test files are therefore not reusable as-is. |

Files cited below are clean at HEAD unless marked. `gpu/islands/*` is not
citable because its working tree differs from any commit.

Third-party packages the prototypes depend on: `vgpu` 0.6.0, `@vgpu/wgsl`
0.6.0, `@vgpu/wgsl-std` 0.6.0. `vgpu` is MIT, published on npm by
`vercel-labs/vgpu` (from `apps/web/node_modules/vgpu/package.json`). Its README
claims a fullscreen effect ships in 25 KB gzipped; not measured here.

## What exists, plainly

The prototypes do not contain illustrations of Marbles concepts. Nothing
there draws a step, a workflow, a run, or a retry. What they offer is:

1. A style layer: paper texture, ink washes, toon shading, painterly
   filtering, all as WGSL modules.
2. A lifecycle contract: how a GPU scene starts on a canvas, survives React
   Strict Mode, and tears down.
3. Static captures (`shots/*.png`, `*.mp4`) that show what each prototype
   looks like.

The concept illustrations themselves would have to be authored for Foundry.

## Style layer

| Candidate | Path (under `apps/web/src/`) | What it gives | Adaptation |
| --- | --- | --- | --- |
| Paper grain and wash | `shaders/illustration/paper.wgsl` | Two pure functions: `paperGrain(p, footprint)` (screen-anchored fibers that fade before aliasing) and `washDensity(p)` (static pigment variation). No bindings. | Depends on `noise/gradient.wgsl` and `noise/lattice.wgsl`; `lattice.wgsl` imports `pcg3d` from `@vgpu/wgsl-std/hash`, so `@vgpu/wgsl-std` is required either way. Uses salts 284/300 to 304. Either vendor all three files or rewrite the two functions against `@vgpu/wgsl-std` noise. |
| Ink on paper composition | `gpu/pond/pond.wgsl` (328 lines), `gpu/pond/palette.ts` | A complete ink-wash scene over paper: how pond combines `paperGrain`/`washDensity` with strokes. | Pattern only. The pond scene (sailboat, ripples, buoyancy) is not a docs illustration. |
| Black ink on warm paper, 3D | `gpu/bubbles/background.wgsl`, `gpu/bubbles/material.wgsl` | Ink line treatment on meshes, same paper. | Pattern only. |
| Toon shading and outlines | `gpu/shared/toon.wgsl`, `gpu/shared/toon-renderer.ts`, `gpu/shared/shadow.wgsl` | Instanced toon meshes, inverted-hull outlines, shadow pass (used by bounce, tether). | Candidate if an illustration needs simple 3D objects (marbles, tubes). Larger than a 2D diagram needs. |
| Painterly filter | `shaders/post/kuwahara.wgsl` (used by `gpu/spyglass/shaders/brush.wgsl`) | Anisotropic Kuwahara: flattens an image into painted regions. | Probably too heavy for inline figures. Listed for completeness. |
| Shader module rules | `shaders/README.md` ("Modules are pure", salts registry) | Conventions for reusable WGSL: no bindings in modules, a salt registry so layers do not repeat patterns. | Adopt the rules for any `docs/illustrations/shaders/`. |

## Lifecycle and loading

| Candidate | Path | What it gives | Adaptation |
| --- | --- | --- | --- |
| Experiment contract | `lab/experiment.ts` | `start(canvas, context) => Promise<Teardown>`; GPU code imported dynamically inside `start` so menus never bundle it. | Narrow it: drop params store, debug, stats. Keep `start`/`Teardown` and the dynamic import. |
| Mount and teardown sequencing | `components/experiment-view.tsx` lines 67 to 128 | A `pending` promise chain so a remount waits for the previous start; `disposed` flag; teardown called even when start resolves after unmount. | Reuse the pattern. Do not inherit its error UI: it shows "WebGPU isn't available in this browser" for every error, including shader failures. |
| Disposed guard after `init` | `gpu/pond/pond.ts` lines 25 to 45 | If disposal happened while `init()` was pending, dispose the new device and never configure the canvas. | Reuse the pattern. |
| Input and ARIA wiring with cleanup | `gpu/pond/pond.ts` lines 128 to 143 | Focusable canvas with `aria-label`, keyboard alternative to pointer input, full listener removal on teardown. | Reuse for interactive illustrations only. |
| Reduced motion starts paused | `gpu/marble-slide/page.tsx` lines 42 to 46 | Reads `prefers-reduced-motion: reduce` and starts paused. | Reuse. Docs should also render one still frame instead of a blank canvas. |
| DPR clamp | `gpu/pond/pond.ts` (`surface(device, canvas, { dpr: [1, 1.5] })`) | Caps pixel cost on high-density screens. | Reuse. |
| Timestamped init fallback | `lab/gpu.ts` (`initTimed`) | Retries `init` without optional features. | Pattern for optional features only. |
| Static captures | `gpu/pond/shots/`, `gpu/marble-slide/shots/`, `gpu/bubbles/shots/` | Reference images, produced by each prototype's `capture.ts` on a local GPU adapter. | Style reference. Not docs assets: they show prototype scenes, not concepts. |

Gaps in the prototypes that docs must not inherit:

- No offscreen pause. Pond's `frameLoop` runs every frame while mounted; only
  `/terrain` stops drawing once settled. No `IntersectionObserver` anywhere in
  `components/`, `gpu/shared/`, `gpu/pond/`, `gpu/marble-slide/`.
- Error handling conflates "no WebGPU" with any other failure (above).
- No device-loss handling seen in the files read.

## The one thematically close scene

`gpu/marble-slide/` (README, 14 files, about 1,700 lines of TypeScript and
WGSL including tests): glass funnel, tubing, four marbles, a flipper. It is
the obvious visual match for a product called Marbles. It is not a good first
docs illustration:

- The canvas is viewport-sized and sticky, and page scroll drives the camera
  target (`README.md`, "Geometry and layout"). Inside a docs article, that
  fights Blume's scroll container, TOC scroll-spy, and anchor jumps.
- 240 Hz physics, transparent glass, mesh rebuilds on resize. Heavy for a
  figure.
- It illustrates "marbles rolling", not a Marbles concept.

Treat it as a later candidate for the Marbles landing page or the home page,
where a full-viewport scene is acceptable.

## Editor patterns (Phase B)

| Candidate | Path (under `apps/editor/src/`) | What it gives | Adaptation |
| --- | --- | --- | --- |
| Versioned document parse with migration | `documents/document.ts` (`DOCUMENT_VERSION`, `parseDocument`, version 1 → 2 upgrade, clear error for unknown versions) | A model for reading old URL or draft payloads. | Pattern only. The document model is bitECS-specific. |
| Local storage index | `documents/storage.ts` (one key per document plus an index key, change listeners) | A model for per-route mark drafts and a cross-page collection. | Pattern only. |
| Coalesced undo | `editor/history.ts` (`COALESCE_MS = 600`, `LIMIT = 100`, checkpoint before each edit) | Undo steps that merge rapid edits. | Pattern only. Marks need a much simpler snapshot (an array of marks). |
| Agent tools over WebMCP | `agent/tools.ts`, `README.md` ("registered with WebMCP when the browser has it") | Exposes editor operations to agents. | Out of scope: API expansion is paused. Blume has its own `components/islands/webmcp.ts`. Noted only. |

## Foundry-side seams (verified by reading installed sources)

| Seam | Where | Finding |
| --- | --- | --- |
| Islands | `node_modules/blume/docs/content/islands.mdx` | `docs/islands/<PascalCase>.tsx` becomes an MDX component with no import, hydrated `client:visible` by default. React is enabled automatically when an island exists. Only pages that use an island ship its JS. |
| Overrides and layout slots | `node_modules/blume/docs/configuration/customization.mdx` | `components.ts` with `defineComponents({ mdx, layout, islands })`. Layout slots include `PageHeader`, `PageFooter`, `TableOfContents`, `Footer`. |
| Astro integrations | `node_modules/blume/src/core/schema.ts:1947` | `integrations: AstroIntegration[]` in `blume.config.ts`; bridged into the generated Astro config (`astro/generate.ts:795`). A Vite plugin can enter through `astro:config:setup`. Not tried. |
| Pinned heading anchors | `node_modules/blume/docs/content/syntax.mdx:20` | `## Heading [#custom-id]` pins an anchor. `{#id}` also works in `.md` but breaks `.mdx`. Slugs use `github-slugger`. |
| Client router | `node_modules/blume/src/components/layout/RootLayout.astro:25,432` | Blume mounts Astro's `ClientRouter` on every page. |
| Router same-page rule | `node_modules/astro/dist/transitions/router.js:7` (Astro 7.3.2) | `samePage` compares `pathname` and `search`. Hash-only changes on the same page scroll in place; a different `search` triggers a fetch and DOM swap. `onPopState` (line 384) ignores entries whose `state` is `null` and expects `state.index` on others. |
| Island teardown on navigation | `node_modules/astro/dist/runtime/server/astro-island.js:32,193`; `node_modules/@astrojs/react/dist/client.js:97` | A disconnected island dispatches `astro:unmount` after `astro:after-swap`, and the React client calls `root.unmount()`, so effect cleanups run on client navigation. |
| Per-route Markdown | `node_modules/blume/src/astro/generate.ts:2261-2276`, `templates.ts:1330`, `ai/markdown.ts`, `core/sources/read.ts:47` | Every page gets `/<route>.md` (components downleveled to Markdown) and `/<route>.mdx` (source). Emitted unconditionally. `readExpandedEntryText` expands `<include>` statements for filesystem sources, so the Software Factory's included `_example/` code should appear in the mirrors. The stale October build in the main checkout's `docs/dist` shows `.md` files and `llms.txt`. |
| Export | `node_modules/blume/docs/configuration/export.mdx` | Optional per-page PDF (print dialog) and EPUB (client-side), off in this site's config. |
| Reduced motion | `node_modules/blume/src/theme/entry.ts:213,734`, `RootLayout.astro:1034` | Blume already honors `prefers-reduced-motion` in its own chrome. |
