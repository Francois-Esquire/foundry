# Spyglass renderer

Maintainer note, excluded from the Blume site. Dated 2026-10-17. The plan
for reworking the viewer's rendering: what was decided, the shape the code
moves to, the one architectural change that makes it possible, and the phases
in which it happens. This note is high level on purpose: it fixes the
direction and the order, and each phase is briefed in detail when it starts.

The diagnosis this follows is [`_viewer.md`](./_viewer.md). The design record
is `apps/spyglass/src/web/DESIGN.md`, and the data-to-visual bindings are in
`apps/spyglass/src/web/codex/README.md` until phase 1 renames that folder.

## Decisions

1. **One GPU context for marks, one semantic layer for text.** The viewer
   today paints most of what is seen into two Canvas2D canvases and shows
   them as textures over a small three.js scene. The Canvas2D path goes.
   Every mark on the chart becomes GPU geometry or a TSL material through
   `WebGPURenderer`. Nothing rasterizes to a bitmap first. The WebGL 2
   backend remains the fallback three.js provides; no WebGL-specific code is
   written. Text is the one exception, decided by the spike in
   [`_text-spike.md`](./_text-spike.md): every label and margin note is a
   real element positioned over the canvas from the camera each frame. That
   is the only candidate that rendered all three faces crisply at the
   chart's sizes, measured within rounding of today's `measureText`, kept hit
   testing unchanged, and gave names, focus order and a screen-reader
   structure for free. MSDF glyphs through a node material work on both
   backends and remain the answer if text ever has to sit inside the lit
   scene; troika fails on both.
2. **No pmndrs postprocessing.** `postprocessing` and
   `@react-three/postprocessing` compile GLSL against a `WebGLRenderer`.
   Adopting them means leaving WebGPU and rewriting every node material. The
   pass graph in `scene/pipeline.ts`, built on `three/addons/tsl/display`,
   stays and becomes the place effects compose. Three r185 ships the stages
   this plan needs: GTAO, SSGI, bloom, denoise, outline, and screen-space
   `Line2`/`LineSegments2` for WebGPU.
3. **Separation of concerns by function, not by feature.** The viewer is
   organized into layers that each do one kind of work: resolve data, hold
   settings, lay out geometry, render, respond to the pointer, and host in
   React. A feature such as departures or the latitude scale touches several
   layers, and each layer's part of it sits with that layer's other work.
4. **Ubiquitous sources.** The things every layer reads are leaves that
   import nothing from the viewer: the resolved data, the settings, the view
   math, and the ladder. Rendering and layout both read from them and never
   from each other's internals.
5. **The codex is renamed `data`.** It already is the viewer's resolved
   data and its bindings; the name "codex" suggested a glossary and collided
   with other uses. The folder's shape and its README survive the rename.
6. **Decoration returns, as a deliberate reversal.** `_viewer.md` records
   that waves, wind, the current, and the animation loop were deleted in
   4.1a, and that bloom and the stage inspector became a developer session's
   in 4.1b, under "decoration that carries no data is deleted". This plan
   reinstates animated water, a selection glow, and clouds as part of the
   chart's aesthetic. The viewer's audience is developers, and the stance is
   that they may be asked for a capable GPU. An animated layer therefore
   becomes a first-class concept: the frame loop runs only while one is
   visible, and reduced motion stills it.
7. **React Three Fiber is decided later, not here.** R3F 9 hosts
   `WebGPURenderer` through an async `gl` factory, renders on demand with
   `invalidate`, and lets a `useFrame` priority hand the frame to the TSL
   pipeline. That makes it viable. Whether it buys more than the registries
   this plan builds is judged in phase 6, after the Canvas2D path is gone,
   with each `drei` helper checked under WebGPU individually.

## The shape

Under `apps/spyglass/src/web`:

| Layer | Holds | Imports |
| --- | --- | --- |
| `data/` | The codex, renamed: source fields, vocabulary, resolvers, bindings, and the viewer's data types | the library's types only |
| `settings/` | Chart, reader, developer, and render settings with their defaults, including the layout's and the boundary overlays' | `data` |
| `view/` | The view math every layer shares: the tilt, zooms, pixels per unit, detail levels | `data`, `settings` |
| `ladder/` | The ink ladder: what each mark means, as hue, weight, dash, and its rung | `data`, `view` |
| `layout/` | Procedural geometry from data: coasts, landmasses, roads, trades, rivers, folders, districts, fields, contours, rings, and the marks each feature asks to draw | the four leaves |
| `scene/` | three.js and TSL only: materials, the GPU mark primitives, mesh layers, the camera, the pass graph | the leaves and `layout` |
| `interaction/` | Hit testing, hover, pointer handling, camera motion | everything above |
| `ui/` | React: state, shell, sheets, and the host that applies state to the scene | everything above |

The rule in one sentence: the leaves import only leaves above them in the
order data, settings, view, ladder; layout imports leaves; scene imports
leaves and layout; and only interaction and the host see all of them. The
ladder is a leaf because it already reads bindings and detail levels and
nothing else; settings becomes one once the layout and boundary defaults it
pulls from `landmasses.ts` and `scene/boundaries.ts` move into it. A
type-only import against the direction, such as the folder cell type the
data types carry today, is split out rather than tolerated, so the rule has
no exceptions. Dependency-cruiser, already a dependency, enforces the rule
from phase 1 onward, so a leak fails the build instead of waiting for a
review to find it.

## Composition as a declared tree

Everything the chart shows is declared as a tree, in code. A node is a named
layer or mark group with its inputs stated: the sea, its depth field and its
ripples; the land, its coasts, relief and folders; the labels; the chrome
such as the grid, the latitude scale and the compass; the selection; the pass
graph's stages. The tree is data the host walks, not calls buried in a
closure, so reading it shows how the scene is composed, and reordering or
removing a layer is an edit to the tree.

Because every node is named, every node is measurable. The timing hooks the
developer session already has for the ink layers and the frame submit
extend to the whole tree: build time, update time, GPU time where the device
reports it, and counts such as marks drawn and labels placed, each under its
node's name. The rendering sheet reads the same tree to show what is on and
what each layer costs, so refining the look is done against measurements,
not impressions.

The `inkLayers` registry and the per-stage timing are the start of this; the
pass graph's stages and the mesh layers join it in phases 3 and 6, and the
mark producers of phase 4 are its leaves. Whether the tree is plain objects
or React Three Fiber elements is the phase 6 decision; its shape is the same
either way.

## The seam: marks, not paint

Each Canvas2D layer does two jobs today. It decides what to draw from the
repaint's state, and it rasterizes that with a 2D context. The first job is
the viewer's knowledge and survives. The second is replaced by GPU
primitives.

The existing `inkLayers` registry, with its shared repaint state and its
bottom-to-top order, is already the right shape for this. The change is to
its signature: a layer stops painting into a context and instead returns the
marks it wants drawn. One GPU mark renderer consumes them. The ladder stays
the style table, so a mark names its meaning and the renderer looks up its
hue, weight, and dash.

The vocabulary of drawable things is kept small: a stroke along a polyline
with a screen-space width and a dash, a filled polygon, a field sampled from
a distance texture, a label with its anchor and priority, a glyph mark at a
point, and screen-space chrome fixed to the viewport. Everything on the chart
today is one of these. Anything a painter does that does not fit, such as
the pen-pressure runs with a lifted pen, is either expressed as a custom
ribbon geometry or dropped, and the choice is made per mark when it ports.

Marks live in world space with depth. That is what retires the pieces of the
current scene that exist only to carry the bitmaps: the ink canvases, the
sea-ink copy, the ink plane, and the relief layer's projection of the ink
texture onto the terrain. Hit testing moves with them: the mark layer
produces hit geometry for labels and glyphs, and the analytical tests for
land, files, and regions remain in `interaction/`.

Two Canvas2D uses hide outside the painters and go at the same time. The
ocean field rasterizes the coast mask through a 2D context to compute a
distance field; the pure scanline mask already written for the selection
ring replaces it, so layout never touches a canvas. Label collision reads
`measureText`; a cached DOM measure in the view leaf replaces it.

Text is the one layer whose renderer is not the GPU. Layout still proposes
labels, places them within their budgets, and publishes the placed boxes the
other layers clear around, exactly as today. The labels node of the tree
renders those placements as elements: a chart section holding a list of
islands, each with its name and caption as its accessible name and a nested
list of the folders, regions and files currently labelled on it; margin notes
hidden from assistive technology. Only placed labels exist as elements, so
the structure is as long as the chart is readable. The layer takes no
pointer events; hit testing stays analytical in `interaction/`, and keyboard
selection joins through the same selection path. The label projector that
lifts lettering over the relief goes, since each label's anchor carries its
elevation and the layer projects the true point.

## Phases

Each phase is one unit of work, committed on main when its tests pass and
the chart looks the same as the baseline unless the phase says otherwise.
Phases are sequential; a phase may be split into several briefs.

| Phase | Goal | Done when |
| --- | --- | --- |
| 0 | Baseline and record | The label foreshortening choice is taken; screenshots at the three named zooms (overview, island, close) are saved for comparison; this note and [`_text-spike.md`](./_text-spike.md) are committed |
| 1 | Leaves and direction | `data/`, `settings/`, `view/`, and `ladder/` exist and import only leaves; the five layout-to-scene imports and the settings-to-layout import are reversed; the dependency rule is enforced and passes |
| 2 | Layout pure | Every procedural module sits under `layout/`; the distance field is canvas-free; the geometry the painters compute (ripple and contour lines, the selection ring, the rims) is layout's; the painters still paint |
| 3 | Host | `scene.ts` is a composition root over camera, pointer, and a single view state; the scene takes one `apply(state)` plus a small command surface (focus, zoom, capture and restore view); the React host has two effects; Canvas2D still runs |
| 4 | GPU marks and semantic text | The mark primitives exist with the ladder as their style table; the layers port bottom to top of the z-order, one or a few per brief, each painter deleted as its layer ports; the labels node renders placed labels as elements |
| 5 | Remove Canvas2D | No 2D context draws under `src/web`; the ink canvases, ink plane, sea-ink copy, lettering canvas, label projector, and relief projection are gone; hit testing reads marks |
| 6 | Composition | Pass-graph stages are modules in a registry, like layers; the R3F decision is taken and, if yes, the scene is hosted in a `Canvas` with the TSL pipeline owning the frame |
| 7 | Aesthetic | Rim waves as the first animated layer, from the rim distance field and a time uniform, still under reduced motion; a selection outline through the outline stage; clouds; bloom tuned for the chart |

Phases 1 through 3 are framework-free and are where most of the clarity
comes from. Phase 4 is the longest and is where the one-context decision is
realized. Nothing in phases 1 through 3 reorganizes the painters themselves,
since they are deleted in phase 4; only the geometry they compute moves
early, because layout needs it either way.

## To settle in the next pass

- **Text's remaining choices.** The spike settled the renderer; three
  choices follow from it. Labels keep today's foreshortening
  (`scaleY(cos 0.7)` reproduces it exactly, at a slight cost in crispness),
  decided 2026-10-17 so the phase 0 baseline stays the comparison through
  phase 5; upright lettering is a phase 7 choice. Whether the label halo matches the paper once the pass graph
  tone-maps the scene beneath it, since the elements sit outside the
  pipeline; the ladder's contrast floors are the check. And how to keep
  elements from drifting a fraction of a pixel against the terrain during a
  pan, by rounding transforms to device pixels or translating the whole list.
  One door closes: text sits above everything, so clouds and bloom never
  pass over a label.
- **Animation and stillness.** How an animated layer declares itself, how
  the loop runs only while one is on screen, and how reduced motion stills
  the water without removing it.
- **Detail levels.** Which marks appear at which zoom is the view leaf's
  concern today in `detailLevel`; the mark renderer needs the same answer
  without each layer re-deriving it.
- **What leaves the chart.** Marks that exist only because Canvas2D made them
  cheap, such as the paper grain filter and the feathered shallows, are
  either re-expressed in TSL or dropped. Each is decided as its layer ports.
- **Verification.** There is no visual regression test. Phase 0's screenshots
  are the comparison until phase 5, when a contrast check against the
  ladder's floors can replace the eye. That check must read a composited
  page capture, as `scripts/capture.ts` already does, since a render-target
  readback never sees a label once text is in the DOM. The ladder's own test
  is a pure table check and survives every phase.
