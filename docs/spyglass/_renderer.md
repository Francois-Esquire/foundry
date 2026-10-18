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
   with each `drei` helper checked under WebGPU individually.

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
| 4e | Text: the measurer in the view leaf, label candidates in `layout/`, the DOM labels node with the frame labels, grid references, latitude scale, sea caption and compass letter | The lettering canvas is empty; `state.labels` is set before the layers that clear around labels run |
| 4f | Topography, crossings, departures, selection, the latitude scale's lines, the compass rose, boundaries, hover | Every `inkLayers` entry is gone and the ink canvas paints nothing |

Nothing in phases 1 through 3 reorganizes the painters themselves,
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
    was in 4a, so half of it now lies outside the covered cells.
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
- **Build off the frame.** A mark layer builds when its keys change, on
  the frame that needs it: entering an island costs one frame of about 35
  ms (4c measured 34.7 ms on the reference workspace) to clip and drape its
  districts, which the painter never paid since it drew without preparing.
  The fix is to build on apply, before the frame is asked for, or in idle
  time after the layer's inputs settle; phase 6's composition pass, which
  owns when nodes update, is the place.
- **Verification.** There is no visual regression test. Phase 0's screenshots
  are the comparison until phase 5, when a contrast check against the
  ladder's floors can replace the eye. That check must read a composited
  page capture, as `scripts/capture.ts` already does, since a render-target
  readback never sees a label once text is in the DOM. The ladder's own test
  is a pure table check and survives every phase.
