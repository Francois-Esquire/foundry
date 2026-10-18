# Marks

The GPU side of the seam in `docs/spyglass/_renderer.md`: a layer returns the
marks it wants drawn, and these modules draw them. The vocabulary is in
`layout/marks.ts` and has no three.js in it.

## Vocabulary

`Stroke`: a polyline (`points`, x, y pairs in chart units), `width` in CSS
pixels, an optional `dash` (dash, gap, CSS pixels), a `cap`. `Fill`: a
`Polygon` (outer ring, then holes). `Glyph`: a `shape` (dot, ring, diamond,
notchedRing, tick) at a point, `size` its diameter in CSS pixels. Every mark
carries a ladder `colour` and an `alpha`, a number or a function of pixels per
unit; a function is read each frame as a uniform, so a mark whose strength
follows the zoom stays static geometry. Share one function between marks that
share it: the renderers batch by its identity. A mark with `on` is draped on
that island's relief; without it, it lies flat on the sea plane.

## Renderers

`strokes.ts` batches strokes by `(width, dash, cap, flat or draped, alpha)` into
one `LineSegments2` each, colours per vertex. Every stroke joins and ends
square, through the material's dash path with no gap, since its own round ends
double-blend at every joint of a translucent line; `cap: round` waits for a
renderer with true joins. `fills.ts` batches by `(alpha, plane)` into one mesh;
`glyphs.ts` by `(shape, alpha, plane)` into one instanced mesh. `drape.ts` cuts
a polyline to the terrain's cell and lifts each vertex onto the relief, and
tessellates a draped polygon as the terrain mesh is.

Flat marks test depth, so the land occludes them. Draped marks draw in order
over the land instead: a screen-width ribbon on a rising shore would sink into
it otherwise. Objects take a render order in (0, 1), by layer then batch, so
they draw after the sea (which sorts before them by depth) and under the ink
plane at 1.

## Adding a layer

Add `{ id, marks }` to `layers.ts`, in z-order. `marks(frame)` reads the view
state, the view and the chart's fixed geometry, and must return the same array
while nothing changed: `staticMarks(inputs, produce)` memoises on the inputs'
identities. Put the producer in `layout/` as a pure function of plain inputs.
The node's update is timed as `layer:<id>`, and `stats()` reports its marks,
segments, vertices and last rebuild time (`markLayerStats` on the scene handle).
