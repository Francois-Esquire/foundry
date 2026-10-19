# Marks

The GPU side of the seam in `docs/spyglass/_renderer.md`: a layer returns the
marks it wants drawn, and these modules draw them. The vocabulary is in
`layout/marks.ts` and has no three.js in it. Nothing on the chart is painted:
every mark is geometry here, and every string is an element (`ui/map-labels/`).

## Vocabulary

`Stroke`: a polyline (`points`, x, y pairs in chart units), `width` in CSS
pixels, an optional `dash` (dash and gap, or dash, gap, dot and gap for a
dash-dot line, CSS pixels), a `cap`. `Fill`: a `Polygon` (outer ring, then
holes). `Glyph`: a `shape` at a point, `size` its diameter in CSS pixels, a
number or a function of pixels per unit for a mark whose screen size follows
the zoom, as a file mark's does; `offset` nudges it by CSS pixels east and
south at the zoom; `upright` stretches it north–south by the tilt's
foreshortening so it reads round or square on screen, where the default lies
in the ground plane. The shapes are drawn at unit size, north up: dot, ring,
diamond, spring, tick, square, and the hollow ones whose band is the glyph's
`weight` in pixels at any size. A `frame` keeps its outer edge at the size
and draws its band in; the banded shapes draw their band astride the edge,
as a stroked path lies, so their size is the painter's own: `hoop` (a ring),
`cross` (a plus), `notch` (a bar toward the north-east), `closeMark` (the
"( )" of proximity), `notchedRing` (a departure's ring, open at the north by
the ladder's notch) and `notchPlug` (the arc that closes it), and the file
shapes `file`, `testFile` (hollow, with a plug), `halfDisc` and `mixed`.
Every mark carries a ladder `colour` and an `alpha`, a number or a function
of pixels per unit; a function is read each frame as a uniform, so a mark
whose strength follows the zoom stays static geometry. Share one function
between marks that share it, alpha or size: the renderers batch by its
identity. A mark with `on` is draped on that island's relief; without it, it
lies flat on the sea plane. A stroke may instead be draped `on: "chart"`: a
line between islands, as a traced import is, is lifted vertex by vertex onto
whatever lies under it, an island's relief or the sea plane, and drawn as
draped strokes are.

There is no clip. What a painter clipped is cut in `layout/clip.ts`: a fill
by polygon intersection (`clipPolygons`, over `polygon-clipping`), a polyline
by keeping the pieces inside (`clipPolyline`). Both are kept by the identity
of their inputs, and `placePolygons`/`placePolylines` in `layout/marks.ts`
keep an island's geometry moved onto the chart the same way, so a rebuild
hands the renderer the polygons and polylines it has already draped. A line
over the sea that the painter kept off the land is not cut at all: flat on
the sea plane, it is occluded by the relief and the coast walls of any
island it passes behind, which is the same picture.

## Renderers

`strokes.ts` batches strokes by `(width, dash, cap, flat or draped, alpha)` into
one `LineSegments2` each, colours per vertex. Every stroke joins and ends
square, through the material's dash path with no gap, since its own round ends
double-blend at every joint of a translucent line; `cap: round` waits for a
renderer with true joins. A dash shorter than the stroke's width is drawn the
width long, keeping the period, as a round-capped canvas dot was the width
round; a dash-dot stroke is drawn twice over one geometry, the dashes and
then the dots offset into their gaps, since the material knows one dash and
one gap. `fills.ts` batches by `(alpha, plane)` into one mesh; `glyphs.ts` by
`(shape, alpha, plane, upright, size function)` into one instanced mesh, with
centre, weight, offset, ink and a fixed size per instance; a size that follows
the zoom is the batch's uniform, read each frame. `drape.ts` cuts a polyline
to the terrain's cell and lifts each vertex onto the relief, or, on the chart,
onto the island under it found by `islandAt`, and tessellates a draped polygon
as the terrain mesh is. The relief sampled is the one drawn: the scene's
relief layer gives the island each surface was built from (`islandOf`), and
every sampler of terrain height, the drape, the glyph renderer and the labels'
anchors, resolves a mark's island through it first, since a relayout replaces
the island in the drawing but never rebuilds its relief. The draped geometry
is kept by that island and by the identity of the points or polygon (and by
the islands as drawn, for the chart, since a relayout moves them), so the
cache can never hand back a drape baked against another field, and a layer
that rebuilds often, as belonging does through its reveal, pays for the
batching alone. The layer node hands the islands as drawn to each rebuild,
off the state, for that.

What the three share is in `batch.ts`: `groupBy` gathers marks by the text of
their key in the order the first of each group appeared, `zoomKeyText` names
a number or a shared function of the zoom (alpha or size) in that text, and
`markMaterialOptions` and `placeObject` set every batch's material and object
up the same way. `ink.ts` keeps a ladder ink as a linear colour. Each
renderer's geometry is its own. Every built batch reports its `segments`
(strokes) and `vertices` (fills and glyphs), zero where the count does not
apply, so the layer's stats sum them without a guard.

Flat marks test depth, so the land occludes them. Draped marks draw in order
over the land instead: a screen-width ribbon on a rising shore would sink into
it otherwise. Objects take a render order in (0, 1), so they draw after the
sea (which sorts before them by depth): a layer takes one step of it, and its
batches share the step evenly (`markRenderOrder`), so a layer's last batch
sorts under the next layer's first however many it has. A mark's optional
`order` places it in a compositing group within its layer, lowest first;
all ordinary marks share group 0. Inside a group, fill batches draw first,
then strokes, then glyphs, with style batches in first-seen order. Groups
never merge: the composition drawing gives its operations successive orders
so a ghost's paper veil covers its tether and its outline covers the veil.
The remaining responsibility marks share a group above the composition.

## Layers

`layers.ts` holds the chart's z-order, bottom to top, each with its keys:

| Layer | Producer | Rebuilt when |
| --- | --- | --- |
| `chart-grid` | `layout/grid-marks.ts` | never: the sea's extent |
| `sea-ripples` | `layout/ripple-marks.ts` | never: the chart's ripples |
| `coast` | `layout/coast-marks.ts` | the islands or the selection change |
| `belonging` | `layout/belonging-marks.ts` | the belonging view as shown, so the applied layer, the hover, the reveal, the matched region, the selection or the overlay, or the zoom while features show |
| `folders` | `layout/folders.ts` | the chart or the rearranged island |
| `domain` | `layout/domain-marks.ts` | the chart, the domain or the rearranged island |
| `connections` | `layout/connection-marks.ts` | the selected file, or whether an overlay is shown |
| `files` | `layout/file-marks.ts` | the islands or the overlay's evidence |
| `file-members` | `layout/file-marks.ts` | the active group, the layer's own files or its island, or whether a composition shows |
| `responsibility` | `layout/responsibility-marks.ts` | the overlay as shown, which the UI's animations replace, or the zoom while it lays anything in world units |
| `proximity` | `layout/proximity-marks.ts` | the chart or the selected file |
| `file-focus` | `layout/focus-marks.ts` | the selection |
| `topography` | `layout/topography-marks.ts` | the contours, whether they are on, or whether a composition veils them |
| `crossings` | `layout/crossing-marks.ts` | the chart or the selection |
| `departures` | `layout/departure-marks.ts` | the chart or the selection |
| `domain-departures` | `layout/departure-marks.ts` | the chart or the domain |
| `selection` | `layout/selection-marks.ts` | the chart or the selection |
| `boundaries` | `layout/boundary-marks.ts` | the outlines or the developer's visibility |
| `hover` | `layout/hover-marks.ts` | the island under the pointer |

## Adding a layer

Add `{ id, marks }` to `layers.ts`, in z-order. `marks(frame)` reads the view
state, the view and the chart's fixed geometry, and must return the same array
while nothing changed: `staticMarks(inputs, produce)` memoises on the inputs'
identities, and `keyedMarks(keys, produce)` on any list of values read off the
state. The belonging layer and the overlay are read as the frame shows them,
off `state.shown` (`layout/belonging-view.ts`): the scene resolves it once a
frame, before any layer runs, from the applied layer with the reveal and the
hover over it, the matched region, the selection and the overlay against the
view. It is the same object while none of those changed, and a frame of the
reveal or of the hover's emphasis makes a new one whose derived fields keep
their identity (the overlay as shown, its evidence set, the active region,
the island), so a layer keys on the fields it reads, and only the belonging
layer, which keys on the object, is built again for a frame of motion. Put
the producer in `layout/` as a pure function of plain inputs. The node's
update is timed as `layer:<id>`, and its `stats()` reports its marks,
batches, segments, vertices, rebuilds and last rebuild time, which the
composition carries as the node's counts (below).

## The composition

The scene is one declared tree, and `describe()` on the scene handle reads
it: every scene layer in the order `scene/scene.ts` updates them (the labels
first, then `hover-resolve`, then the drawn layers bottom to top), each with
the `kind` it declares (`labels`, `marks` for a mark node, or `layer` for a
mesh layer such as the sea or the relief, and for a step of the scene's own
that draws nothing, as the weather and `hover-resolve` are), whether it is
drawn, the milliseconds its last update took on the CPU, and its `stats()`
as `counts`; then every stage of the pass graph (`scene/stages/`) in its
order, with whether the graph as built holds it. Stages carry no time:
the GPU times the frame as a whole, which `getRenderStatus().frameMs` reads
out. The developer sheet shows the tree as one table under "Composition".

Two more things a layer may declare. `animating()` says it is moving on its
own: while any layer does, and the reader has not asked for reduced motion,
the scene draws the next frame unasked, and stops the moment none does; the
scene's clock (`scene/clock.ts`) hands each update the seconds the scene has
been in motion and holds the same value as a uniform for a material; under
reduced motion a frame ticks the clock without advancing it. The weather
(`scene/weather.ts`) is the layer that animates: it draws nothing itself,
since the water material reads its surf and the shared paper surface reads
its clouds' light, but it owns the two toggles' uniforms and reports
`animating()` while either is on. `prepare(view, state)` is the costly part of a coming build as
steps the scene runs in idle time: the mark node's asks the layer for the
marks the given state would have it draw, which caches their clips, then
touches each mark's draped geometry, which caches that, so the frame that
builds the layer pays for the batching alone. The scene uses it for the
belonging layer: a layer applied is prepared first, and the reveal starts
when its marks are ready, so entering an island no longer costs one frame
of 35 ms.

## Labels

Text is the one layer whose renderer is not the GPU: `ui/map-labels/` sets
every string on the chart as an element in one section over the canvas,
positioned from the camera each frame, and measures text with the browser
once per text and font (`measure.ts`). The UI supplies this renderer through
the scene options; the scene has no dependency on its implementation. Four modules share the work.
`labels-layer.ts` is the frame pipeline: it proposes labels through
`layout/label-candidates.ts` (pure, measured by an injected `TextMeasure`;
the proposers themselves are in `layout/label-proposals.ts`), keeps the
candidates while nothing they read changes, places them, publishes the
placed `MapLabel` boxes to the state before any mark layer updates, so the
island under the pointer is resolved from them (`state.hovered`, which the
hover layer keys on) and the hit test reads them, then measures every width
and baseline before it writes an element. `label-items.ts` keeps the
elements: the list of islands, one focusable item per island with its name
and the labels on it, the captions beside them, the place each item names,
and the keyboard activation. The separate React `ui/chart-chrome.tsx` renders
margin notes, coordinates and cast areas from prepared screen-space props.
`text-element.ts` supplies the map labels' DOM helpers: how
an element is lettered (its font, ink and halo written once, and again only
when they change), moved (snapped to device pixels, squashed by the tilt)
and set at a point by its baseline or its middle, and the keyed reconciler
that keeps elements across frames by what they show and retires the rest.
`MapLabel` is a union on `kind`; a label with a `place` is selectable, and
the hit test and a keyboard activation select that place. The layer updates
first among the scene's layers, and the `hover-resolve` step declared right
after it asks the pointer's resolver, which reads `state.labels`, for the
island to ink; its depth is the DOM's, over everything. Its update is timed
as `layer:labels`. It takes no pointer events; its items are focusable, and
Enter or Space selects what an item names through the scene's
`setLabelActivation`. Names are not cut from the lines beneath them: each
name carries a paper halo, which covers them.
