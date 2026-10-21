# Spyglass renderer

Maintainer note, excluded from the Blume site. Dated 2026-10-17. The plan
for reworking the viewer's rendering: what was decided, the shape the code
moves to, the one architectural change that makes it possible, and the phases
in which it happens. This note is high level on purpose: it fixes the
direction and the order, and each phase is briefed in detail when it starts.

The diagnosis this follows is [`_viewer.md`](./_viewer.md). The design record
is `apps/spyglass/src/web/DESIGN.md`, and the data-to-visual bindings are in
`apps/spyglass/src/web/data/README.md`.

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
   with each `drei` helper checked under WebGPU individually. Decided in
   phase 6: no. The scene is a declared tree of plain objects (the scene
   layers, the mark layers, the labels layer, the stages), rendered on
   demand with each node measured; hosting it in React elements would add a
   reconciler and WebGL-first helpers without buying anything the aesthetic
   phase needs, since rim waves, the outline, clouds and bloom are TSL
   materials and stages. The tree's shape is what an R3F host would need, so
   the door stays open.

## The shape

Under `apps/spyglass/src/web`:

| Layer | Holds | Imports |
| --- | --- | --- |
| `data/` | The codex, renamed: source fields, vocabulary, resolvers, bindings, and the viewer's data types | the library's types only |
| `settings/` | Chart, reader, developer, and render settings with their defaults, including the layout's and the boundary overlays' | `data` |
| `view/` | The view math every layer shares: the tilt, zooms, pixels per unit, detail levels | `data`, `settings` |
| `ladder/` | The ink ladder: what each mark means, as hue, weight, dash, and its rung | `data`, `view` |
| `layout/` | Procedural geometry from data: coasts, landmasses, roads, trades, rivers, folders, districts, fields, contours, rings, and the vocabulary of marks each feature asks to draw | the four leaves |
| `scene/` | The renderers: three.js and TSL for marks (materials, the GPU mark primitives, mesh layers, the camera, the pass graph), and the one DOM layer, for text | the leaves and `layout` |
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
`measureText`; a cached DOM measure replaces it. The measurer is DOM, so it
lives with the UI labels renderer in `ui/map-labels/`, and
layout takes it as an argument (`TextMeasure`).

The UI supplies the scene with its label renderer through the scene options.
The scene coordinates its frame and receives placed boxes without importing UI.
`ui/chart-chrome.tsx` separately renders cast areas, coordinate lettering,
latitude notes and the sea caption from immutable screen-space props.

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

Each phase is one unit of work, committed when its tests pass and the
chart looks the same as the baseline unless the phase says otherwise.
Phases are sequential; a phase may be split into several briefs. All
eight are done; see "What landed" below.

| Phase | Goal | Done when |
| --- | --- | --- |
| 0 | Baseline and record | The label foreshortening choice is taken; screenshots at the three named zooms (overview, island, close) are saved for comparison; this note and [`_text-spike.md`](./_text-spike.md) are committed |
| 1 | Leaves and direction | `data/`, `settings/`, `view/`, and `ladder/` exist and import only leaves; the five layout-to-scene imports and the settings-to-layout import are reversed; the dependency rule is enforced and passes |
| 2 | Layout pure | Every procedural module sits under `layout/`; the distance field is canvas-free; the geometry the painters compute (ripple and contour lines, the selection ring, the rims) is layout's; the painters still paint |
| 3 | Host | `scene.ts` is a composition root over camera, pointer, and a single view state; the scene takes one `apply(state)` plus a small command surface (focus, zoom, capture and restore view); the React host has two effects; Canvas2D still runs |
| 4 | GPU marks and semantic text | The mark primitives exist with the ladder as their style table; the layers port bottom to top of the z-order, one or a few per brief, each painter deleted as its layer ports; the labels node renders placed labels as elements |
| 5 | Remove Canvas2D | No 2D context draws under `src/web`; the ink canvases, ink plane, sea-ink copy, lettering canvas, label projector, and relief projection are gone; hit testing reads marks |
| 6 | Composition | Pass-graph stages are modules in a registry, like layers (`scene/stages/`), and the composer walks it; the scene describes its whole tree with what each node costs (`describe()`), shown in the developer sheet; an animated layer declares itself and the frame loop runs only while one is on screen; the cold frame on entering an island is built off the frame; the R3F decision is taken: no (decision 7). No pixel changes |
| 7 | Aesthetic | Rim waves as the first animated layer, from the rim distance field and a time uniform, still under reduced motion; a selection outline through the outline stage; clouds; bloom tuned for the chart |

Phases 1 through 3 are framework-free and are where most of the clarity
comes from. Phase 4 is the longest and is where the one-context decision is
realized. It is the first phase whose screenshots are allowed to differ from
the baseline: a stroke drawn by the GPU is not the stroke Canvas2D
rasterized, so pixel identity ends here and the evidence becomes the suite,
a capture with no console or WebGPU errors, the hover and escape run still
selecting, the ladder's contrast table, and the screenshots read side by
side with the baseline. Phase 4 is briefed in this order, each brief
committed on its own:

| Brief | Ports | Proves |
| --- | --- | --- |
| 4a | The mark vocabulary in `layout/marks.ts` (stroke, fill, glyph) and its renderers in `scene/marks/`; the chart grid, the sea ripples and the coast ink | A static layer builds once and only touches uniforms during a pan; a filled polygon drapes on the relief at close zoom |
| 4b | The two sheets: the sea as a TSL material over the ocean distance field, the land's pigment and the shallows as fills and a smoothstep on the same field | No sheet is painted; the paper material takes its pigment without a texture |
| 4c | Belonging with the natural features it carries, folders, and the domain band and marks: the next three of the ink canvas's layers, in its order | A fill clipped to the coast drapes on the relief; the reveal and the hover's emphasis repaint through marks within a frame's budget |
| 4d | Connections, files, responsibility with the composition and scenario-route drawings, proximity, file focus | Every file mark follows the terrain; the animated overlays repaint through marks |
| 4e | Text: the measurer in `ui/map-labels/` (DOM, injected into layout), label candidates in `layout/`, the DOM labels node with the frame labels, grid references, latitude scale, sea caption and compass letter | The lettering canvas is gone; `state.labels` is set before the layers that clear around labels run |
| 4f | Topography, crossings, departures, selection, the latitude scale's lines, the compass rose, boundaries, hover | Every `inkLayers` entry is gone and the ink canvas paints nothing |

Nothing in phases 1 through 3 reorganizes the painters themselves,
since they are deleted in phase 4; only the geometry they compute moves
early, because layout needs it either way.

## What landed

Every phase above landed on the branch `feat/spyglass-renderer` between
2026-10-17 and 2026-10-18, one commit per phase or brief, each gated on the
layer rule, the typecheck, the app's vitest suite, the bun integration
tests, Ultracite and a headless WebGPU capture compared to the previous
phase's; phases 1 through 3 and phase 6 at the same-code noise floor, the
rest read by eye against the baseline. The viewer now draws every mark
through one `WebGPURenderer`, letters the chart in one semantic DOM layer,
opens no 2D context, describes its composition as one measured tree, and
runs a frame loop only while the weather moves.

Follow-ups the phases recorded rather than took, in the ledger above:

- The surf's foam sits under bloom's threshold, which is gated above the
  paper's inks; lifting it means a threshold under the paper, or a brighter
  foam ink.
- The selection glow is three device pixels, so it is half as wide in CSS
  pixels at a pixel ratio of two; scaling it widens the blur and drops the
  core under the bloom's gate.
- Glyphs and fills have no edge feather, so specks and rings read a shade
  crisper than the canvas drew them; strokes have one.
- A held selection costs the outline stage two more scene draws a frame
  (about 15 ms of GPU at island zoom on Balanced, against 11 without), and
  the weather keeps the loop running while it is on.
- The cold frame's algorithmic route (grid-aligned triangulation instead
  of tessellate-and-merge, a spatial filter in the polyline clipper) was
  measured, not taken; the idle warm-up hides the cost instead.
- The `ladder/` folder name was questioned and never resettled.
- The relief as drawn is the authority on the terrain. A territory relayout
  replaces the island in `state.drawingData` with one whose files have
  moved, which moves its field's summits, while the relief layer is built
  once from the scene's data and never rebuilt; so every drape, glyph and
  label anchor resolves its island through the relief layer's `islandOf`
  and samples the field the relief was built from, and the drape caches are
  keyed by that island and the geometry. A relayout that should change the
  terrain must rebuild the relief layer; until one does, the marks follow
  the relief that is drawn.

## To settle in the next pass

- **Text's remaining choices**, settled in 4e. Labels keep today's
  foreshortening (`scaleY(cos 0.7)` on each element reproduces it exactly),
  decided 2026-10-17 so the phase 0 baseline stays the comparison through
  phase 5; upright lettering is a phase 7 choice. The halo matches the
  paper: a 6 px halo on the sea probes `(245, 239, 223)`, `grounds.labelHalo`
  exactly, in both the 4d capture (lettering plane inside the pass graph)
  and the 4e capture (element outside it), and the paper strip beside a
  label at close zoom is the same `(214, 216, 199)` in both, so the pipeline
  leaves these near-white values alone and nothing needs retuning. Drift:
  transforms are rounded to device pixels. Measured with a 10.5 × 6.5 px
  drag at island zoom (`capture.ts`'s `shift` step), the marks move
  10.5 × 6.5 and a snapped label 11 × 6 then 10 × 7, the same pixels each
  frame (mean difference 0.34 of 255); unsnapped it moves 10.6 × 6.5 but
  Chrome rasterises the glyphs again at each fractional offset (mean
  difference 6 to 10), which shimmers through a pan. Snapped text is
  therefore at most half a device pixel off the marks, and the offset never
  accumulates. One door closes: text sits above everything, so clouds and
  bloom never pass over a label.
- **Animation and stillness.** Settled in phase 6. A layer declares itself
  by `animating()` on its `SceneLayer`; after each frame is submitted the
  scene asks for the next while any layer says so and
  `prefers-reduced-motion` is not set, and stops the moment none does, so
  the loop costs a still chart nothing (0 frames in 2 s idle on the
  reference workspace). A change of the preference draws one frame, which
  shows the chart as it now stands and starts or stops the loop. The
  scene's clock (`scene/clock.ts`) is a uniform of seconds since the scene
  opened, set once per frame and handed to each layer's update, so a
  material reads time without owning a clock; reduced motion stills the
  water by stopping the loop, which leaves the uniform where it is, so the
  water stays, still. 7a's weather is the first layer that animates, and it
  tightened the clock: a frame drawn under reduced motion (a pan) ticks the
  clock without advancing it, so the surf and the clouds hold their phase
  through the pan rather than jumping with each frame, and the clock counts
  the seconds the scene has been in motion, not since it opened.
- **Detail levels.** Which marks appear at which zoom is the view leaf's
  concern today in `detailLevel`; the mark renderer needs the same answer
  without each layer re-deriving it.
- **What leaves the chart.** Marks that exist only because Canvas2D made them
  cheap, such as the paper grain filter and the feathered shallows, are
  either re-expressed in TSL or dropped. Each is decided as its layer ports.
  The ledger so far, from 4a:
  - Chart grid: the Canvas2D clip off land is gone; the grid lies just above
    the sea plane and the land's depth occludes it. The faint print of the
    grid on the relief (the ladder's `grid-on-land` rung) is not drawn; it
    was barely perceptible at 0.17 alpha. Where lines cross, two translucent
    strokes blend twice, where one Canvas2D path composited once.
  - Sea ripples: unchanged in shape; the reveal with zoom is a per-frame
    alpha on static strokes, and nothing is culled to the view in JS.
  - Coast ink: draped on the island's relief, drawn in order over the land
    rather than depth-tested, since a screen-width ribbon on a rising shore
    would sink into it. The outer half of each stroke is no longer clipped,
    so the painter's doubled widths are halved (rule 2.75 px, pen 1 px at
    unit pressure) and the dark hairline now frames the gilt rule on both
    sides, which reads a shade browner at overview. The ladder's key still
    lists the painter's doubled widths.
  - Strokes in general: joins and ends are square. The line material's own
    round ends bead at every joint of a translucent stroke, so `cap: round`
    waits for a renderer with true joins. Edges are feathered over one device
    pixel in the shader, since the scene pass has no multisampling.

  From 4b, the two sheets:
  - Sea shading: the depth steps and the vignette to open water are the same
    two step functions as the painter's, evaluated on the CPU over the same
    1280-cell field of the sea's extent (`layout/ocean-shade.ts`) and
    uploaded as two half-float levels; the material mixes the ladder's three
    water grounds by them, in linear light where the painter mixed in sRGB
    bytes, a difference under one step of 8 bits for grounds this close.
    The sea plane samples the levels where the painted sheet's texels were,
    so the overview is the same picture.
  - Shallows: a soft band of `grounds.shallows` where the chart's shore
    field, the one the ripples and contours already share, is within 3.2
    units of a coast, feathered over one unit either side, in place of each
    island's `territory.shallows` polygon blurred three pixels. The old band
    was a density contour of varying width (1.7 to 7 units off the coast,
    3.1 in the middle, over the reference workspace); the new one is one
    width everywhere, so the band gains where the old one was narrow and
    loses where it was wide, and at close zoom its edge is a shade more
    even. The shore field is 1280 cells over
    the chart's longer side, 0.76 cells a unit on the reference workspace,
    which reads smooth at the three zooms. An island joined into a
    continent had no shallows; its continent's outline is among the coasts
    the field measures, so a continent now takes the band along its outline
    instead. This follows from the field and was not observed: the reference
    dataset forms no continent at the default settings.
  - Pigment: each island's wash is computed once on the CPU as the painter
    composited it, the pigment under the warm paper at 0.48 in sRGB bytes
    (`layout/island-pigment.ts`), converted to the working space as a texel
    of an sRGB texture would be, and carried on every terrain vertex as a
    `pigment` attribute. The paper material reads the attribute and has no
    map; one material serves every land surface. The same island takes the
    same pigment as before, since the choice is by id.
  - Continent: the connecting land's mesh carries `grounds.continent` as its
    pigment. Nothing else changes; the mesh already stood where the sheet's
    fill was.
  - Coast plane: gone, with its 4096-pixel texture. The shallows are in the
    water and the pigment is on the meshes, and nothing else read it. The
    ink canvases open at the host's size instead of the sheet's.

  From 4c, belonging, folders and the domain:
  - Clipping is geometry. The painters clipped with the canvas at every
    turn: a district to the coast and to its enclosing group, the domain's
    band to the coast and to its cells, a folder cut to the land. A mark is
    drawn whole, so `layout/clip.ts` cuts instead: a fill by polygon
    intersection over `polygon-clipping`, a polyline by splitting each
    segment where it crosses a ring and keeping the pieces whose middle is
    inside, even-odd as the canvas clips were. A district's outline cut this
    way stops at the shore and never strokes the coast, as the clip left it.
    Both are kept by the identity of their inputs, as are an island's
    polygons moved onto the chart and the draped tessellation of a polygon,
    so the belonging layer's rebuilds through the reveal and the hover's
    emphasis pay for the batching alone: the first build of an island's
    layer is 30 to 35 ms on the reference workspace (the intersections, and
    the relief sampled along every coast-clipped vertex); each frame of the
    reveal and of the hover is then 0.7 to 1.6 ms.
  - The band's inner half: the painter stroked the domain's band at twice
    its width under the clip so only the inner half showed. The band is
    drawn centred on the clipped edge at the ladder's weight, as the coast
    was in 4a, so half of it now lies outside the covered cells. The
    painter also skipped islands outside the view each repaint; the domain
    layer builds every island's band once and lets the GPU cull, as the
    folders do.
  - Tilt. Glyphs lie in the ground plane and are foreshortened with it,
    as the painted marks were; a glyph with `upright` is stretched north
    to south by `tiltStretch` so it reads square on screen, which only the
    domain's file squares take, since only they were painted under the
    stretch. The painter widened east–west folder cuts by `1/cos(chartTilt)`
    because the ink was a texture on the ground; the stroke renderer's
    width is screen-space and the same in every direction, so no cut is
    widened. The package diamond's inset from the southern coast is in
    screen pixels, so a glyph takes an `offset` in CSS pixels applied at
    the zoom, rather than the domain layer rebuilding as the zoom changes.
  - Hollow squares. The anchor (a 1 px pen round a 4 px half side) and the
    domain's file square (the `domain-file` row's 2.5 px round 6.5) share
    no band share, so a `frame` glyph carries its band as a per-instance
    `weight` in pixels, drawing the inner corners in by it at any size,
    and both stay exact. The anchor's pen and half side, and the member
    square's 3 px, are the painter's own, not the ladder's, as before.
  - Natural features. Reeds are quadratic curves flattened to five points
    each; springs are a `spring` glyph, a ring open to the east at the arc's
    radius, instead of a stroked arc. A stream's three strokes keep their
    widths, and the glint keeps its one-pixel nudge south-east: a stroke
    has no screen-space offset, so the nudge is laid in world units at the
    zoom the marks are built for, which is exact because the river pen, the
    reed size and the marsh's tuft spacing follow the zoom in world units
    as before and the belonging layer is built again as the zoom changes
    while features are shown; a pan never rebuilds it. Stroke widths are
    rounded to 0.05 px so near-equal pens share a line object.
  - Alphas. Every strength that fades with the zoom (the districts',
    the files', the composition's veil, the uncertain outline's
    `min(0.3, pixels / 30)`, the features' strength, each folder depth's
    zoom) is an alpha function of pixels per unit, shared by the marks that
    share it; what depends on state (active, retained, passive, the reveal,
    the emphasis) is folded into the function at build. Folder cuts of
    every island and depth are built once per chart, and each depth's alpha
    brings it in at its zoom; nothing is culled to the view.
  - Order within a layer. A mark layer draws its fills, then its strokes,
    then its glyphs, so a parent group's outline now lies over the
    districts' washes where the painter drew each region's wash over the
    outline before; the washes are translucent and the difference is not
    visible at the named zooms. The painted layers above remain above:
    the relief's ink mesh draws after every draped mark.
  - Hit testing is untouched: `hitBelonging` and the pointer read layout.
    `paintDomainDepartures` stays painted until 4f, since it plugs the
    departure rings. The reader's interface sets no domain, so the domain
    layer's evidence is its unit tests.

  From 4d, connections, files, responsibility, proximity and the file focus:
  - Sizes follow the zoom as uniforms. A file mark is the file pen wide and
    a speck the speck radius, both map units that the painter recomputed
    every repaint; a glyph's size may now be a function of pixels per unit,
    batched by its identity and read into the batch's size uniform each
    frame, so the files layer (3,402 glyphs on the reference workspace,
    three batches at rest, six with an overlay's evidence and a group's
    members) is built once per chart, evidence set and selected group, and
    a pan or zoom costs it nothing. The painted pen was `min(1.8, 4.5/px)`
    units; it is the same in pixels, `min(1.8·px, 4.5)`.
  - The file shapes. Each role and kind is a glyph shape in the pen's
    proportions: the filled tall rect hanging south of its point, the test's
    hollow rect with its plug, the story's half disc, a ring for commons, a
    cross through a hollow square for a junction (two glyphs at one point),
    the mixed half fill, a hollow square for unknown. Their bands are the
    pen's one pixel through the `frame` mechanism, generalised: these
    shapes draw their band astride the edge as a stroked path does, so the
    size handed to the renderer is the painter's own; `frame` keeps its
    outer edge fixed, as the domain and anchor squares were measured.
  - No feather on glyph edges. The stroke renderer ramps its ribbon's alpha
    over one device pixel; glyph shapes are triangles with hard edges, and
    the scene pass has no multisampling, so a speck of four pixels reads a
    shade heavier than the painter's antialiased dot, and a file rect's
    corners are square where the canvas softened them. A screen-space
    feather for glyphs is phase 7's, with the rest of the look.
  - Evidence and members. A file outside an overlay's evidence recedes to
    0.15 of the files' strength through its own alpha function, so dimmed
    files form their own batches rather than carry an alpha each; the
    selected group's exact members are a solid square and a paper frame
    over the files, hidden by an alpha once a composition takes over.
  - Across the sea. A traced import runs from a file on one island to a
    file on another; a stroke may be draped `on: "chart"`, cut to the
    terrain's cell and each vertex lifted onto the island under it or the
    sea plane between, drawn as draped strokes are. The lift finds the
    island by its coast, boxed first, which is the cost of selecting a hub:
    the reference workspace's most-imported file has 139 traced imports,
    1,572 lifted vertices and 25 ms of draping, paid once per file and
    islands, since the lifted vertices are kept by both. The painter's
    straight line was projected onto the relief where it crossed land and
    lay on the sea plane elsewhere; the draped line does the same, and
    climbs the cliff over one cell at each shore.
  - What the overlay lays in world units. The hint's dotted arc, the
    unresolved file's dashed diamond and a route's arrowhead are drawn in
    world units at the zoom the layer was built for, as the painter drew
    them: a glyph has no dash and no bearing, and a dashed screen-sized
    circle as a stroke needs its radius in units. The responsibility layer
    is therefore built again as the zoom changes whenever the overlay has
    hints, unresolved files, routes or a composition, not only a
    composition as the brief had it; without any of those it is static.
    The rings on members and related files, the route's ring on a
    responsibility and the disagreement notch are glyphs. A rebuild with a
    composition of 150 declarations on the reference workspace's largest
    island, fitted as the UI fits it, is 1.2 to 1.4 ms (397 marks, seven
    batches), mid-spread the same; the trace's and the routes' progress
    arrive as a new overlay object and rebuild at the same cost.
  - Composition in map units. The paper under a declaration, its outline,
    a blocker's diagonal, the ghosts, tethers and veils are fills and
    strokes in map units, clipped to the coast by `layout/clip.ts` where
    the painter clipped with the canvas. A square is known clear of the
    coast from its centre and a clearance of its half diagonal, two walks
    of the coast where testing each corner is four and the polygon
    intersection is only for the few that straddle it, which the fitting
    never produces at full spread.
  - Proximity is one static layer: every island's ties, cut to the land as
    the canvas clip cut them, their beads, and the "( )" marks, built once
    per chart and selected file (147 marks and four batches on the
    reference workspace, 6 ms) and shown from island zoom by one alpha.
    The painter clipped the beads and the close marks to land as well; a
    bead or mark whose centroid lies off the land is left out instead,
    which no tie of the reference workspace needs. The close mark is one
    glyph of two arcs set apart, upright so it reads round on screen as it
    did under the painter's stretch; its arcs sit `apart` at the ladder's
    share of the radius, two pixels at the radius of five.
  - The file focus is three upright glyphs: the paper halo and the
    selection's ring as banded hoops of the same radius, and the centre
    square. Z-order is kept exact: every ported layer draws under every
    painted one, labels first. Hit testing is untouched.
  - What the reader cannot reach. "Trace imports" and the responsibility
    overlay have no control in the reader's interface, so the connections
    and responsibility layers' evidence is their unit tests and the
    chart-drape renderer test, as the domain's was. Selecting a file by a
    tap at close zoom is reachable and was captured.
  From 4e, text:
  - Every string on the chart is an element: `ui/map-labels/labels-layer.ts`
    builds `<section aria-label="Chart">` in the host over the canvas, one
    focusable `<li>` per island (named "spyglass, package, 639 files"),
    holding its name and caption, shown when placed, and a nested list of
    the folders, regions and files labelled on it ("src/, folder",
    "belonging.ts, file", "Territory, region"); frame labels and the
    domain's name are items of a captions list; the margin notes are
    `aria-hidden`. Elements are kept by what they name and say, so a pan or
    a zoom moves them rather than replacing them. Enter or Space on an item
    selects what it names through `setLabelActivation`, which the pointer
    module routes to `onSelect`.
  - The lettering canvas, its mesh, `createLabelProjector` and
    `elevatedLabel` are gone. A label carries its anchor's height `z`
    (`drapedHeight` for a name on land, the plane for one on the sea), its
    box stays on the plane where the raised name is seen (`liftedY`), and
    the layer projects the raised point through the camera. The old lifted
    anchor and the raised one project to the same pixel: 1.3e-13 px over
    1,113 labels at island zoom on the reference workspace.
  - Layout proposes and places: `layout/label-candidates.ts` is the
    painter's proposal code as `labelCandidates(inputs, measure)` and
    `placeLabels(candidates, view, fileId)`, with its budgets and the
    focused-name rule; `MapLabel` carries its `kind`, `font` (face,
    italics, letter-spacing in em), `halo`, `ink` and `z`, so the layer
    styles it without re-deriving. `TextMeasure` returns a width in em,
    measured once per text and font by a hidden element at 100 px
    (`ui/map-labels/measure.ts`), which also reads each face's baseline
    offset. Candidates are proposed again whenever the view or the state
    changes, as the painter did each repaint, minus every `measureText`.
  - Margin notes are screen-space elements laid out by
    `ui/chart-margin-layout.ts`: the grid references at their cells, the
    latitude scale as one element with an inline SVG axis and ticks, its
    plates on narrow views, its fade and its legend clearance; the sea
    caption and the compass "N" are chart-anchored with their size in
    pixels per unit, so they scale with the zoom as the painted ones did.
    The compass rose stays painted until 4f.
  - Look: DOM text is hinted and sub-pixel positioned, so glyphs are
    crisper than the texture's, and the synthesised italic and
    letter-spacing come from the browser (`font-synthesis: style` on the
    layer, since the page turns synthesis off). Positions and sizes match
    the 4d captures at the three zooms.
  - Cost: `layer:labels` is 0.6 ms median (5 ms max) through a pan at
    island zoom with 11 labels placed and 25 elements, and 1.1 ms median
    (21 ms max, the frame that first proposes and measures 26 file names)
    at close zoom with 33 placed and 38 elements. The paint stage `ink` no
    longer letters anything.
  - Hit testing is untouched: the hover resolver and `labelUnder` read
    `state.labels`, which the layer publishes before the ink repaints.
  From 4f, the last eight painted layers, in the ink canvas's order:
  - Sea lines pass beneath islands by depth, not by clipping. `clipToSea`
    kept the crossings, the departure lines and the selection's lines off
    the land; each is now a flat stroke on the sea plane with the depth
    test on, and the relief and the coast walls of an island it passes
    behind hide it there, which is the same picture. On the reference
    workspace, with lib selected at island zoom, the dotted line from its
    eastern dependent passes behind the spyglass island's south-western
    islet and is hidden across it; at the default overview no line
    crosses land (the one that runs closest, lib to workflows, threads the
    channel between the spyglass island and its southern islet, and now
    reads whole where the clip had broken it against the label boxes).
  - Names are kept clear by their halos, not by cutting the lines. The
    painters cut a box round every placed label out of the sea clip; the
    DOM labels carry a 6 px paper halo on the sea, and the dash-dot line
    that runs under "artifacts" at overview is covered by it, the name as
    legible as before. Nothing reads the labels' boxes any more except the
    hit test.
  - Curves flatten in layout: `seaCurvePoints` turns a sea curve into a
    polyline of twenty segments, kept by the curve, so a reselection hands
    the renderer the same points. Widths and dashes stay CSS pixels; the
    beads are `dot` glyphs flat on the sea.
  - Dashes. The line material knows one dash and one gap, so the ladder's
    dash-dot rows (`departure-line` `[8, 3, 1, 3]`, the pockets boundary)
    are drawn twice over one geometry, the dashes and then the dots offset
    into their gaps; `Stroke.dash` takes the four-entry pattern. A dash
    shorter than the stroke's width is drawn the width long, keeping the
    period: the canvas drew `selection-importers`' 0.1 px dash as a
    round-capped dot the width round, and the material would have drawn a
    tenth of a pixel. This touches `proximity-apart` from 4d, whose 1 px
    dash at 1.5 px is now 1.5 px in a period of 4.
  - Departure rings are `notchedRing` glyphs, upright and draped, their
    radius per level from the ladder and the ladder's weight as the band;
    the unit shape is rebuilt as a banded arc open at the north by the
    ladder's notch, where it had been a fixed-share ring with a 54° gap.
    The domain's plug is a `notchPlug` glyph, the arc over the same notch
    at the same size and stance, in the domain's heavier pen, so it meets
    the ring at any zoom. Both end square where the painter's ring had
    round caps. Without a feather on glyph edges (4d), the rings read
    heavier at overview, and where departing files sit close they merge
    into a blob a shade darker than the painted one did.
  - Topography is static geometry: every contour built once, the land's
    draped on its island (`ContourLine.on`), the sea's rings flat, each
    with one alpha function per distinct product of the ladder's alpha,
    the ring's own opacity, the minor lines' fade past overview and the
    veil a composition draws over them. The occupancy thinning on 3 px
    cells and the clearing around labels are dropped: both read the zoom
    and the frame's labels, the fade already thins the minor lines at
    overview, and the halos cover the names. Read at the three zooms with
    contours on, nothing crowds: the overview's sea rings are the faint
    bands they were, and the summit contours at island and close zoom sit
    where the painted ones sat. The first build with contours on, at
    island zoom on the reference workspace, is 23.5 ms (`layer:topography`
    max), the land contours' draping; a pan or zoom costs it nothing.
  - The compass rose is five flat strokes and four fills in map units at
    the chart's corner, static. Its outline pen is 0.65 CSS pixels, the
    painter's 0.65 map units at overview, where the rose is seen; it no
    longer thickens with the zoom. The rose reads a shade heavier than the
    painted one: its fills have hard edges, as every fill and glyph does
    until phase 7's feather, and its hairline is widened by the stroke
    feather's device pixel.
  - Boundaries are the developer's dashed strokes, flat, keyed on the
    outlines and the visibility; `boundaryStyles` moves to
    `layout/boundary-marks.ts`, where the developer's controls read it.
    The pen is 1 CSS pixel, the painter's at overview.
  - Hover is two draped strokes along the hovered island's coast, the band
    and the line, keyed on `state.hovered`: the scene resolves the island
    under the pointer right after the labels layer updates, since a label
    is hit before the land beneath it, and before any mark layer runs. The
    labels layer therefore updates first among the scene's layers; its
    depth is the DOM's, so the list's order is no longer its z. (The
    resolution is since a declared step of the layer list, `hover-resolve`,
    right after the labels, and the resolver reads the labels off the
    state; every layer declares its `kind` for the composition.) At overview
    the hover inks the coast of the island under the pointer (3,733 pixels
    differ between a hover and none on the reference workspace) and Escape
    clears it.
  - Cost. Through a pan at island zoom on the reference workspace, every
    new layer is 0 ms median; the maxima are the first builds: selection
    9.4, hover 2.8, departures 1.4, compass 0.7, the rest under 0.1. The
    `ink` and `sea-ink` stages (0.5 and 0.2 ms median, 8.4 and 0.6 max)
    are gone with the canvases, and the two texture uploads a frame with
    them. `render-submit` is 1.0 ms median (0.7 before) and 63.6 max (62.9
    before): the submit now encodes twenty more line objects, and the first
    frame after a tap still compiles pipelines. The frame's CPU time at
    rest moves from about 2.0 ms (labels 0.6, ink 0.5, sea-ink 0.2,
    submit 0.7) to about 1.8 (labels 0.8, submit 1.0).
  From phase 5, the removal:
  - No 2D context is opened under `src/web`: `scene/ink-canvases.ts`,
    `scene/paint-map.ts`, `scene/ink/`, `scene/sea-ink.ts`,
    `scene/ink-texture.ts`, `scene/archipelago-ink.ts`,
    `scene/selection-ink.ts`, `scene/hover-ink.ts`, `scene/topography.ts`,
    `scene/boundaries.ts` and `scene/paint-paper.ts` are deleted, with the
    ink plane, the relief's projection of the ink texture (its
    `MeshBasicNodeMaterial`, the drawing meshes, `setMap`, the view
    uniforms) and the `ink`, `ink:<id>` and `sea-ink` timing stages; the
    ladder's `dashAt` went with its last caller. The lettering canvas and
    the label projector went in 4e.
  - Hit testing reads layout, as it did: `state.labels` from the labels
    layer, the land polygons and the terrain geometries the relief exposes.
    Nothing in `interaction/` imported a deleted module, so nothing there
    changed. The marks produce no hit geometry of their own; the glyphs
    and strokes are drawn from the same layout the hit test reads.
  From 7a, the weather, the first of the decoration decision 6 reinstates:
  - Two animated layers, both the reader's, both on by default (`waves`,
    `clouds` in `defaultReaderSettings`, a "Weather" group under the layers
    in the reader's sheet), and both drawn only when on: each is a uniform
    of 1 or 0 that multiplies its effect (`scene/weather.ts`), so off is
    bit-exact. With both off the three zooms match the phase 6 captures at
    the noise floor (beyond 8 of 255: overview 1 pixel, island 203, close
    2,286, where phase 6's own reruns gave 0, about 240 and about 2,300),
    and an idle chart submits no frame (0 in 2 s at overview and island
    zoom). One scene layer, `weather`, draws nothing and updates nothing:
    it holds the uniforms and reports `animating()` while either is on,
    and the water material and the paper surface read the uniforms and
    the clock.
  - Rim waves: surf along each archipelago's rim, in the water material.
    The band is shaped from the distance beyond the rim (`surfBand`:
    nothing at the rim, full at 5 units beyond it, gone by 16), and its
    brightness is two sines of the clock (0.9 and 0.55 rad/s) over a noise
    phase that varies along the rim at about fifty units and drifts, so
    patches of foam brighten, fade and travel along the rim rather than
    the whole rim pulsing; at the crest the water is mixed 0.6 of the way
    to `grounds.surf` (#eef1e6, the lightest water, added to the ladder
    and measured like any ground). On screen the band is 9 px at the
    fitted overview (0.58 px a unit on the reference workspace) and about
    35 px at island zoom; the foam patches are 20 to 25 levels lighter
    than the deep water at their crests, the band between them 5 to 10.
    It reads as a soft pale ring round the archipelago at overview, dashed
    by the foam, and as a ribbon of breaking water at island zoom.
  - The rim field. The sea's shade field carries `outside` already, but
    at 1280 cells over the sea's extent its cells are 4.6 units on the
    reference workspace, and a band 16 units wide sampled from it showed
    the rasterised rim's staircase at island zoom and 45-pixel steps at
    close zoom. The surf therefore measures the rims again on their own
    grid (`layout/ocean-field.ts`'s `rimField`): 1280 cells across the
    chart's extent grown to hold every rim (the reference rim reaches 17
    units past the chart's top), 1.14 units a cell, uploaded as one R16F
    texture of the distance in map units. On the reference workspace that
    is 1215 × 1280 texels, 3.1 MB, and 74 ms more at load (one scanline
    fill and one distance transform), paid before the terrain is built.
    The shore field could not serve: it stops at the chart's edge, where
    the texture clamps, and the rim crosses it.
  - Cloud shadow: in `paperSurface`, so the land, the connecting land and
    the sea take one function; the coast walls are a plain colour and take
    none, which does not show. The cover is two octaves of `mx_noise_float`
    in chart space, one period about 420 units, carried by a wind of (5,
    −2.5) units a second and reshaping slowly, kept to the noise's crests
    (`smoothstep(0.12, 0.4)`) so it is sparse: four to six shapes, each one
    to three hundred units across, cross the overview at a time. The shade
    is the cover set off 46 units away from the sun (`scene/renderer.ts`'s, at
    (−600, 700, 700)), darkening the pigment by 0.09 in linear light,
    which is about 4% of a level on the sRGB screen: measured against the
    phase 6 overview, 13,000 pixels are 8 levels darker, 2,700 are 9, none
    more than 11. The wisp is the cover's thickest part, in place, 0.07
    lighter in linear light (about 3% on screen), so a cloud reads as a
    pale body sunward of a soft shadow. Text lies over the canvas, so no
    label is shaded.
  - Cost. The loop runs at the display's rate while either is on: 120
    frames in 2 s idle at overview and at island zoom on the reference
    workspace, 19% and 17% of the main thread (16% and 13% script), with
    `render-submit` 2.0 ms and 1.6 ms median (max 2.2) against 1.9 ms
    median through the load and the tap with the weather off; the GPU's
    `frameMs` reads 7 ms in both cases, so the two noise functions a
    fragment cost nothing the readout can see. The frame's cost is the
    frame itself, not the weather: every layer's update and the submit run
    each time, and the labels re-propose nothing while the view holds. The
    clock is not capped: a half-rate loop would halve the 19% but the brief
    asked for a cap only where a full-rate loop measurably matters, and on
    the development machine it does not; the figure is recorded here for
    the day it does.
  - Reduced motion: the loop stops and the clock holds, so two captures
    500 ms apart are identical (0 pixels differ), as are two either side
    of a pan and back, with the band and the shade still drawn; with the
    preference lifted the next capture differs again along the rim and in
    the shade. Two captures 500 ms apart with motion allowed differ along
    the rim, where the foam moved, and across the shade, which drifted
    2.5 units, and nowhere else; the largest difference is 8 of 255, since
    the surf's phase moves slowly and the shade's edges are soft.
  From 7b, the selection glow and the bloom, the last of the decoration:
  - A stage, `scene/stages/outline.ts`, between occlusion and bloom in the
    registry, built when `selectionGlow` (a rendering setting, on by
    default, "Selection glow" in the sheet) is on. It wraps three's
    `OutlineNode`: the selected island's terrain meshes are drawn against
    the depth of everything else, the edge of that mask is found at half
    resolution, blurred 1.5 texels (3 device pixels) and added to the frame
    in `inks.selectionGlow`, #f5cc80, a lighter, warmer tint of the
    selection ink: the ink itself, #361b05, is too dark to add as light.
    The node's pulse (`edgeGlow`) stays at zero, so the glow is still and
    reduced motion needs nothing of it. Its view, "Selection glow", shows
    the edge mask in the glow's colour.
  - The selection reaches the stage without touching the graph. The frame
    carries one `selection` array that the composer refills from a
    `selectedObjects` provider before each render (`scene.ts` answers
    `relief.meshesOf(state.selected)`, the island's terrain surfaces, one
    per coast polygon); the node keeps the array and reads it each frame,
    and the graph's signature never sees the selection. Measured on the
    reference workspace: across the tap that selects the spyglass island,
    the host receives no `spyglass:render` status event (the composer
    sends one when a graph is built or fails) and the composition's stage
    list reads the same before and after; `render-submit` stays at 1.8 ms
    median, with one frame of 23 ms when the node compiles its materials
    for the first non-empty selection. The fake-stage test in
    `test/web/pipeline.test.ts` holds the same: the provider is read once a
    render, the stage's array follows it, and `configure` with the same
    settings builds nothing.
  - Strength. The glow's core must pass the bloom's gate (below), so it is
    a bright line rather than a soft band: the half-resolution edge peaks
    near a quarter, and at strength 2 the core adds about half the ink.
    On screen at island zoom the core is (253, 240, 207) on sea of
    (189, 211, 187), at overview (255, 234, 178) over the shore water; the
    line is about 3 px at either zoom. The ring stays the strongest mark:
    the glow is light on light sea, about 1.4:1 by luminance, where the
    ring's dark ink is over 6:1, and at overview the glow lies between the
    coast ink and the ring, which is drawn over it as a mark. Softer
    settings were tried first (a 4 to 6 px band at 0.7 to 0.9) and read
    well, but their core reached only 0.72 to 0.80 in linear light and the
    bloom never lifted them: the on-and-off difference at island zoom
    (230 pixels beyond 8 of 255) was the rebuild floor. These figures are
    at a pixel ratio of 1; the thickness is in device pixels, so at a ratio
    of 2 the line is about 1.5 CSS pixels and its core reads (223, 223, 205)
    at island zoom and (229, 222, 197) at overview, a finer, dimmer edge
    whose haze is about half as wide. Scaling the thickness by the ratio
    would widen the blur and lower the core, which the gate already only
    just admits, so the width stands in device pixels and is noted here
    for the day the glow is retuned. Terrain surfaces
    are outlined, not walls: with the walls in the mask too the line moves
    to the cliff's foot and reads whiter and a touch heavier, (255, 255,
    216) on the same segment, where the terrain's rim gives the cleaner,
    warmer edge. The hidden edge (the node's
    second channel) appears where a draped district or file mark lies a
    hair above the terrain, never behind another island, since the islands
    are apart and the walls low; both channels take one strength, so the
    classification does not show. The mask is found at half resolution on
    every tier: at full resolution the edge is one pixel and the blur
    spreads it thin, and the Full tier's glow came out several times
    dimmer than Balanced's, so the downsample is the stage's constant, not
    the tier's; with it the Full tier's core reads (244, 230, 196) on the
    same segment. On Light the paper and the sea are unshaded, so they are
    brighter and more of the core passes the bloom's gate: the line reads
    (255, 255, 231) there and its haze is broad, since the Light tier's
    bloom is a quarter of the resolution; it does not block the glow, so
    the tiers' bloom resolutions stand.
  - Cost. The node draws the scene twice more while anything is selected,
    once for the depth of what is not selected and once for the mask, and
    nothing while the selection is empty. At island zoom on Balanced the
    GPU reads 15 to 16 ms a frame with the glow and 11 without, in one
    session, against 7 ms with nothing selected in 7a; at close zoom 7 ms
    with the glow, since little of the chart is in view. The frame loop
    runs at the display's rate while the weather animates, so a held
    selection pays this every frame.
  - Bloom, on by default at threshold 0.85, strength 0.6, radius 0.35
    (from off at 0.8, 0.2, 0.35). The node's highpass is a gate, not an
    excess: a pixel over the threshold passes at its full colour, so the
    threshold must clear the brightest thing the chart draws, and what
    passes is then blurred at the strength. Measured with the bloom's own
    view against the same view at threshold 1, which is black apart from
    the DOM: at 0.85 nothing of the chart passes at any of the three zooms
    (0 pixels at overview, island and close on Balanced; a 480-pixel focus
    ring on the sheet's button, DOM, was in both; on Light 0, 0 and 1,953
    pixels by at most 5, the unshaded paper's brightest grazing the gate at
    close zoom); at 0.8 the overview and island zoom still pass nothing,
    the live surf passes 0 to 261 pixels by 1 to 3 levels at its crests,
    and close zoom leaks 41,000 pixels: the
    marks drawn in `inks.paper`, #f1ead9, 0.82 in linear light, the
    brightest flat colour on the chart, brighter than the lit paper; at
    0.75 the overview leaks 4,600 pixels by up to 8, at 0.7 two thirds of
    the frame. The lit paper's brightest sits between 0.70 and 0.75; the
    surf's crests reach about 0.8. So 0.85 clears the paper inks by 0.03
    and the surf's foam does not lift: "a little surf" would need a
    threshold under the paper inks, and at close zoom the halos round the
    file rings would bloom. Restraint in the composite, reduced motion,
    nothing selected: bloom on against off at overview differs by 0
    pixels beyond 8 and at most 7, the same as the rebuild floor (the
    graph built again with no change of settings: 0 and 7), and the probes
    are within 1 level (paper (241, 206, 183), sea (195, 203, 190) and
    (195, 203, 189), the spyglass's paper (197, 218, 194), the rim
    (196, 204, 191) and (196, 204, 190)); at island and close zoom the
    on-and-off difference (240 and 2,388 beyond 8) is the floor there
    (230 at island zoom in the same session; 7a measured 203 and 2,286
    between runs), and the probes are within 1 level; on Light, which has
    no occlusion and so no floor, on against off at overview is 0 pixels.
    What the bloom does
    lift is the glow: with the spyglass island selected, on against off is
    17,800 pixels beyond 8 at island zoom (largest difference 54) and
    5,200 at overview (48), a warm haze about a dozen pixels into the sea
    along the coast. Labels and margin notes cannot bloom: they are
    elements over the canvas, outside the pipeline, as 4e decided, and the
    bar's chrome is DOM too. Strength and radius were taken by eye: 0.5 at
    radius 0.5 washed a level or two over the whole island from the widest
    level of the blur; 0.35 keeps the haze near the line.
- **Build off the frame.** Settled in phase 6. A mark layer builds when its
  keys change, on the frame that needs it: entering an island cost one
  frame of about 35 ms (4c measured 34.7 ms, phase 6 34.6 before its fix)
  to clip and drape its districts, which the painter never paid since it
  drew without preparing. Measured on the reference workspace, the frame
  was three costs, none of which one algorithmic change brings under 10 ms:
  the draped geometry of the four clipped district polygons, 22.7 ms
  (`TessellateModifier` 5.3, `mergeVertices` 6.3, sampling the relief at
  each vertex 10.9); the clips, 6.7 ms (`polygon-clipping` 4.7,
  `clipPolyline` 2.0, over 285 draped outline pieces); the batching, about
  3. Every one of these is cached by the identity of its input, so the
  layer is built off the frame instead: a mark node's `prepare` asks the
  layer for the marks the coming state would have it draw and touches each
  one's draped geometry, as steps run in idle time (`scene/idle.ts`,
  `requestIdleCallback` with a timeout, a timer where it is missing), and
  the scene applies a belonging layer and starts its reveal when they are
  ready. The first frame to draw the layer now takes 1.6 ms, and the layer
  appears a few idle periods later than it did, under the reveal's 240 ms.
- **Verification.** There is no visual regression test. Phase 0's screenshots
  are the comparison until phase 5, when a contrast check against the
  ladder's floors can replace the eye. That check must read a composited
  page capture, as `scripts/capture.ts` already does, since a render-target
  readback never sees a label once text is in the DOM. The ladder's own test
  is a pure table check and survives every phase.
