# Marks

The GPU side of the seam in `docs/spyglass/_renderer.md`: a layer returns the
marks it wants drawn, and these modules draw them. The vocabulary is in
`layout/marks.ts` and has no three.js in it.

## Vocabulary

`Stroke`: a polyline (`points`, x, y pairs in chart units), `width` in CSS
pixels, an optional `dash` (dash, gap, CSS pixels), a `cap`. `Fill`: a
`Polygon` (outer ring, then holes). `Glyph`: a `shape` (dot, ring, diamond,
notchedRing, tick, square, frame, spring) at a point, `size` its diameter in
CSS pixels; a `frame` is a hollow square whose band is the glyph's `weight` in
pixels at any size; `offset` nudges it by CSS pixels east and south at the
zoom; `upright` stretches it north–south by the tilt's foreshortening so it
reads round or square on screen, where the default lies in the ground plane.
Every mark carries a ladder `colour` and an `alpha`, a number or a function
of pixels per unit; a function is read each frame as a uniform, so a mark
whose strength follows the zoom stays static geometry. Share one function
between marks that share it: the renderers batch by its identity. A mark
with `on` is draped on that island's relief; without it, it lies flat on the
sea plane.

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
`glyphs.ts` by `(shape, alpha, plane, upright)` into one instanced mesh, with
centre, size, weight, offset and ink per instance. `drape.ts` cuts a polyline
to the terrain's cell and lifts each vertex onto the relief, and tessellates a
draped polygon as the terrain mesh is; both are kept by the identity of the
points or polygon, so a layer that rebuilds often, as belonging does through
its reveal, pays for the batching alone.

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
