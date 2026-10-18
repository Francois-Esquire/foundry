# Marks

The GPU side of the seam in `docs/spyglass/_renderer.md`: a layer returns the
marks it wants drawn, and these modules draw them. The vocabulary is in
`layout/marks.ts` and has no three.js in it.

## Vocabulary

`Stroke`: a polyline (`points`, x, y pairs in chart units), `width` in CSS
pixels, an optional `dash` (dash, gap, CSS pixels), a `cap`. `Fill`: a
`Polygon` (outer ring, then holes). `Glyph`: a `shape` at a point, `size` its
diameter in CSS pixels, a number or a function of pixels per unit for a mark
whose screen size follows the zoom, as a file mark's does; `offset` nudges
it by CSS pixels east and south at the zoom; `upright` stretches it
north–south by the tilt's foreshortening so it reads round or square on
screen, where the default lies in the ground plane. The shapes are drawn at
unit size, north up: dot, ring, diamond, notchedRing, spring, tick, square,
and the hollow ones whose band is the glyph's `weight` in pixels at any
size. A `frame` keeps its outer edge at the size and draws its band in; the
banded shapes added with the file marks draw their band astride the edge,
as a stroked path lies, so their size is the painter's own: `hoop` (a
ring), `cross` (a plus), `notch` (a bar toward the north-east), `closeMark`
(the "( )" of proximity), and the file shapes `file`, `testFile` (hollow,
with a plug), `halfDisc` and `mixed`. Every mark carries a ladder `colour`
and an `alpha`, a number or a function of pixels per unit; a function is
read each frame as a uniform, so a mark whose strength follows the zoom
stays static geometry. Share one function between marks that share it,
alpha or size: the renderers batch by its identity. A mark with `on` is
draped on that island's relief; without it, it lies flat on the sea plane.
A stroke may instead be draped `on: "chart"`: a line between islands, as a
traced import is, is lifted vertex by vertex onto whatever lies under it,
an island's relief or the sea plane, and drawn as draped strokes are.

There is no clip. What a painter clipped is cut in `layout/clip.ts`: a fill
by polygon intersection (`clipPolygons`, over `polygon-clipping`), a polyline
by keeping the pieces inside (`clipPolyline`). Both are kept by the identity
of their inputs, and `placePolygons`/`placePolylines` in `layout/marks.ts`
keep an island's geometry moved onto the chart the same way, so a rebuild
hands the renderer the polygons and polylines it has already draped.

## Renderers

`strokes.ts` batches strokes by `(width, dash, cap, flat or draped, alpha)` into
one `LineSegments2` each, colours per vertex. Every stroke joins and ends
square, through the material's dash path with no gap, since its own round ends
double-blend at every joint of a translucent line; `cap: round` waits for a
renderer with true joins. `fills.ts` batches by `(alpha, plane)` into one mesh;
`glyphs.ts` by `(shape, alpha, plane, upright, size function)` into one
instanced mesh, with centre, weight, offset, ink and a fixed size per
instance; a size that follows the zoom is the batch's uniform, read each
frame. `drape.ts` cuts a polyline to the terrain's cell and lifts each vertex
onto the relief, or, on the chart, onto the island under it found by
`islandAt`, and tessellates a draped polygon as the terrain mesh is; all are
kept by the identity of the points or polygon (and of the islands, for the
chart, since a relayout moves them), so a layer that rebuilds often, as
belonging does through its reveal, pays for the batching alone. The layer
node hands the islands as drawn to each rebuild, off the state, for that.

Flat marks test depth, so the land occludes them. Draped marks draw in order
over the land instead: a screen-width ribbon on a rising shore would sink into
it otherwise. Objects take a render order in (0, 1), by layer then batch, so
they draw after the sea (which sorts before them by depth) and under the ink
plane at 1.

## Adding a layer

Add `{ id, marks }` to `layers.ts`, in z-order. `marks(frame)` reads the view
state, the view and the chart's fixed geometry, and must return the same array
while nothing changed: `staticMarks(inputs, produce)` memoises on the inputs'
identities, and `keyedMarks(keys, produce)` on any list of values read off the
state, for a layer whose producer derives its inputs (the belonging layer
keys on the applied layer, the hover, the reveal and the overlay, never on
the derived `drawnBelonging`, which is a new object each frame). Put the
producer in `layout/` as a pure function of plain inputs. The node's update is
timed as `layer:<id>`, and `stats()` reports its marks, segments, vertices
and last rebuild time (`markLayerStats` on the scene handle).

## Labels

Text is the one layer whose renderer is not the GPU: `scene/labels/` sets
every string on the chart as an element in one section over the canvas,
positioned from the camera each frame (`labels-layer.ts`), and measures text
with the browser once per text and font (`measure.ts`). The layer proposes
and places labels through `layout/label-candidates.ts` (pure, measured by an
injected `TextMeasure`), publishes the placed `MapLabel` boxes to the state
before the ink canvas repaints, so topography, the selection and the hover
clear around them and the hit test reads them, and lays the margin notes
(`layout/margin-notes.ts`) in screen space. Its update is timed as
`layer:labels`. It takes no pointer events; its items are focusable, and
Enter or Space selects what an item names through the scene's
`setLabelActivation`.
