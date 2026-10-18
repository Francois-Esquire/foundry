# Marks

The GPU side of the seam in `docs/spyglass/_renderer.md`: a layer returns the
marks it wants drawn, and these modules draw them. The vocabulary is in
`layout/marks.ts` and has no three.js in it. Nothing on the chart is painted:
every mark is geometry here, and every string is an element (`scene/labels/`).

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
as the terrain mesh is; all are kept by the identity of the points or polygon
(and of the islands, for the chart, since a relayout moves them), so a layer
that rebuilds often, as belonging does through its reveal, pays for the
batching alone. The layer node hands the islands as drawn to each rebuild,
off the state, for that.

Flat marks test depth, so the land occludes them. Draped marks draw in order
over the land instead: a screen-width ribbon on a rising shore would sink into
it otherwise. Objects take a render order in (0, 1), by layer then batch, so
they draw after the sea (which sorts before them by depth).

## Layers

`layers.ts` holds the chart's z-order, bottom to top, each with its keys:

| Layer | Producer | Rebuilt when |
| --- | --- | --- |
| `chart-grid` | `layout/grid-marks.ts` | never: the sea's extent |
| `sea-ripples` | `layout/ripple-marks.ts` | never: the chart's ripples |
| `coast` | `layout/coast-marks.ts` | the islands or the selection change |
| `belonging` | `layout/belonging-marks.ts` | the applied layer, hover, reveal, overlay, or the zoom while features show |
| `folders` | `layout/folders.ts` | the chart or the rearranged island |
| `domain` | `layout/domain-marks.ts` | the chart, the domain or the rearranged island |
| `connections` | `layout/connection-marks.ts` | the selected file or the overlay |
| `files` | `layout/file-marks.ts` | the islands, the overlay's evidence or the selected group |
| `responsibility` | `layout/responsibility-marks.ts` | the overlay object, or the zoom while it lays anything in world units |
| `proximity` | `layout/proximity-marks.ts` | the chart or the selected file |
| `file-focus` | `layout/focus-marks.ts` | the selection |
| `topography` | `layout/topography-marks.ts` | the contours, whether they are on, or whether a composition veils them |
| `crossings` | `layout/crossing-marks.ts` | the chart or the selection |
| `departures` | `layout/departure-marks.ts` | the chart or the selection |
| `domain-departures` | `layout/departure-marks.ts` | the chart or the domain |
| `selection` | `layout/selection-marks.ts` | the chart or the selection |
| `compass` | `layout/compass-marks.ts` | never: the chart's corner |
| `boundaries` | `layout/boundary-marks.ts` | the outlines or the developer's visibility |
| `hover` | `layout/hover-marks.ts` | the island under the pointer |

## Adding a layer

Add `{ id, marks }` to `layers.ts`, in z-order. `marks(frame)` reads the view
state, the view and the chart's fixed geometry, and must return the same array
while nothing changed: `staticMarks(inputs, produce)` memoises on the inputs'
identities, and `keyedMarks(keys, produce)` on any list of values read off the
state, for a layer whose producer derives its inputs (the belonging layer
keys on the applied layer, the hover, the reveal and the overlay, never on
the derived `drawnBelonging`, which is a new object each frame). Put the
producer in `layout/` as a pure function of plain inputs. The node's update is
timed as `layer:<id>`, and its `stats()` reports its marks, batches, segments,
vertices, rebuilds and last rebuild time, which the composition carries as
the node's counts (below).

## The composition

The scene is one declared tree, and `describe()` on the scene handle reads
it: every scene layer in the order `scene/scene.ts` updates them (the labels
first, then the drawn layers bottom to top), each with `kind` (`labels`,
`marks`, or `layer` for a mesh layer such as the sea or the relief), whether
it is drawn, the milliseconds its last update took on the CPU, and its
`stats()` as `counts`; then every stage of the pass graph (`scene/stages/`)
in its order, with whether the graph as built holds it. Stages carry no time:
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

Text is the one layer whose renderer is not the GPU: `scene/labels/` sets
every string on the chart as an element in one section over the canvas,
positioned from the camera each frame (`labels-layer.ts`), and measures text
with the browser once per text and font (`measure.ts`). The layer proposes
and places labels through `layout/label-candidates.ts` (pure, measured by an
injected `TextMeasure`), publishes the placed `MapLabel` boxes to the state
before any mark layer updates, so the island under the pointer is resolved
from them (`state.hovered`, which the hover layer keys on) and the hit test
reads them, and lays the margin notes (`layout/margin-notes.ts`) in screen
space. It updates first among the scene's layers for that; its depth is the
DOM's, over everything. Its update is timed as `layer:labels`. It takes no
pointer events; its items are focusable, and Enter or Space selects what an
item names through the scene's `setLabelActivation`. Names are not cut from
the lines beneath them: each name carries a paper halo, which covers them.
