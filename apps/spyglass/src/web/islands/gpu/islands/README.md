# Islands

`/islands` charts a codebase as islands, drawn from Foundry's own geometry.
The chart (`src/data/`) is computed once into a few maps (`maps.ts`): the
signed distance to the coast, the island that owns each texel, coverage,
each island's own distance to its coast, height, the rings (which bank's
plate each sea texel stands on, and every bank's under it), the sea's
flow, light, the sun at the sea surface (shade), paint, the files (a
disc at each module's place on its island), the zoning (what the
world plan reserves and grows, WORLD.md), and the seabed (the open sea's
floor far past the chart, below). The frame only samples them.
The land is a real displaced mesh under a 3D camera; the water is a
composite over the terrain's colour and depth, so it has real thickness. What comes next is
in [`PLAN.md`](PLAN.md).

Drag to pan. Shift-drag or right-drag turns and tilts. The wheel or a pinch
zooms. WASD and the arrows pan, Q/E turn, R/F tilt, and +/- zoom. A click
chooses an island or a ring (below, Selection); Escape lets go.

![Fitted](shots/fitted.png)

![Close](shots/close.png)

![Low](shots/low.png)

The palette is Spyglass's. Each island takes one of twelve pastel caps
(`map-data.ts` `ISLAND_PALETTE`, sampled off Spyglass's reference atlas), in
turn by order or by a hash of its id (`palette`). Its rim, wherever the
land is steeper than about 0.6, is cliff rock (`rockColor`) tinted
`rockTint` toward the cap, laid on by the terrain from its smooth normal. Beaches are sand; under the water the floor
goes from wet sand to silt by the platform's depth and takes the sea's
band colour at its depth (`floorTint`): a pale shore, turquoise over the
top levels, cyan over the platform, navy over the deep. The band depths
follow the chart's (`seaBandsOf`). Nothing shapes an island but its coast
and its groups.

Chart units are the source's own, origin at the chart's centre, `x` east
and `y` south. Chart `(x, y)` is world `(x, 0, y)`; height is world `y`,
sea level `y = 0`. Every map shares one square frame:
`side = max(width, height) × 1.1`, `texel = side / resolution`, the origin
at `−side / 2` on both axes. Past the edge the terrain and the water read
the seabed map instead (The open sea, below); the other maps' reads clamp.

`tileWorldSize = 0` preserves this fitted frame exactly. A positive world
span fixes texel density: `resolution` texels per tile side, with enough
tiles on each axis to cover the chart and its margin, rounded up to a
power of two so every map keeps a power-of-two side for its mip chain.
Doubling the chart side adds a 2×2 tile area at the same density. Baking stitches these tiles
into ordinary 2D maps; terrain and water keep native texture filtering,
the original camera, and the original clipmap policy. There is no tile
lookup in the frame shaders. This is a resident-map design, bounded by
the GPU's maximum 2D texture size and available memory, not unlimited
streaming. Oversize charts fail explicitly instead of losing islands.

## The frame

A frame is drawn only when something changed: the camera moved, a setting
changed, a map rebuilt, the canvas resized, the pointer picked (every
move over the canvas hovers, so moving it redraws), or the waves are on
(`waveAmplitude` above 0 in the shaded view). Otherwise the loop drops the
frame (`frame.cancel()`) and nothing is submitted. A setting that changes a
map rebuilds that map and its dependants between frames: `maps.build`
submits work of its own, which can't nest in a frame.

Three stages (`scene.ts`):

1. **Terrain**, into the film: a single-sample `rgba16float` target with a
   `depth32float` depth, reversed-Z (cleared to 0, drawn with
   `compare: "greater"`, an infinite far plane, so depth is
   `near / distance`). No MSAA: the composite reads the depth as a texture,
   which a multisampled target can't give. The props on the shallows
   (below) draw into the same pass.
2. **Water**, a fullscreen composite from the film into the post's frame,
   a linear `rgba16float` target at the output's size, so a smaller film
   (`renderScale`) is upsampled here. It also adds the sky, so it runs with
   the water off too (debug views, the bench's terrain alone).
3. **Post** (`post.ts`, `shaders/post/`), kept apart from the scene:
   - **bloom**: a soft-knee bright-pass from the frame to half size
     (`bloomThreshold`, linear, so only glints, sunlit foam and the
     brightest sand glow; the pastel sea stays as it is), four 13-tap
     downsamples to a thirty-second, and tent upsamples back up, each
     added into the level above (the shared `shaders/post/bloom.wgsl`, as
     Spyglass's). `bloomRadius` leans it on the deeper levels; `bloom` is
     its strength, divided by what the chain sums to, so it means the same
     at any radius. Off (0) the chain is skipped, and in the debug views;
   - **finish**: the bloom added, the warm vignette (`vignette`,
     `vignetteColor`; only with the water), a shoulder that rolls off only
     what passes 0.85 linear (everything below is untouched, so the
     palette is), and the sRGB encoding, into an `rgba8unorm` target;
   - **anti-aliasing** (`antialias`): FXAA (the shared
     `shaders/post/fxaa.wgsl`, Lottes' console variant) on that
     display-referred image onto the output, or a copy. It smooths the
     land's silhouettes, the foam's rings and the mesh's stair-steps, and
     leaves flat colour alone. The debug views skip it, and the bloom.

   The occlusion is baked, not screen-space: the light map's horizon
   occlusion (below), deepened by `occlusion` and taken partly by the sun
   too (`occlusionSun`) in the terrain and the props, so creases, the feet
   of walls and the props sit in the ground.

### Terrain: a flat clipmap

`clipmap.ts` lays out nested square levels of 512 quads a side over the
maps' texel grid. Level 0 is a full square; each level out is a ring of the
same count at twice the stride whose hole is the level inside it. The
levels are centred on the ground under the eye, where perspective makes it
nearest, and level 0's stride is picked so a cell is about 4 px there
(a power of two, at least a quarter texel, held near a doubling so a
resting zoom doesn't swap meshes). Each doubling of distance from the eye is then one
level out, and a cell stays a few pixels wide over the whole view.

Two index buffers draw it: the square once, and the ring instanced once
per further level (`terrain.wgsl` reads the level from the instance
index). Each cell is four triangles fanned round a centre vertex, which
follows the corners (below). Level 0's corner snaps to the coarsest level's stride, so every
level's vertices stay on a fixed lattice and panning doesn't make the
heights crawl. On a level's outer edge every other vertex has no partner in
the ring outside; it takes the mean of its two neighbours along the edge,
so the edges meet without cracks. Past the grid's edge the mesh keeps going
and stands on the seabed map (The open sea, below), which carries the
floor on as the height map would have, the platform's fall included, so
there is no cut. Over the last six seabed texels inside the edge the
terrain and the water fade from the frame's maps into the seabed map
(`farShare` in `frame.wgsl`), so the frame's finer floor tapers into the
seabed's coarser one instead of stopping on a line. Where the mesh ends,
the water composite carries the same floor on to the horizon.

A cliff rises 6 units over a texel or two, too steep for a mesh read from
baked heights: it saws into teeth along any coast oblique to the grid. So
the height map (`rgba16float`) holds, beside the height in r, what the
land is made from, both smooth across texels: the rim's distance inland
in g (negative at sea) and the floor at the coast in b (the floor itself
at sea). Vertices read them bilinear on a lattice of quarter texels and
rebuild the land's profile (`land.wgsl`, the same function the height map
bakes), so close in a cliff rises over many vertices. Fragments take
their normal from the same rebuilt surface half a texel either side, lay
the rock on by it, and read the paint just inside and just outside the
coast, joined on the rebuilt coast over a pixel, so neither the light
map's normal nor the paint's texel-wide edge stripes the cliff. Up a wall
(up under about 0.45) the rim's distance hardly moves from top to foot, so
there land and sea meet where the face crosses the water, by height.

Further out a level's cells are a texel or more, as wide as the cliff
(its rim runs 3 units, a cell at a mid zoom 1.7 to 3.4), and a fixed
diagonal across a cell cuts the crest into teeth wherever the coast runs
along the other one. So a vertex within three quarters of a stride of the
cliff's foot (the coast) or its crest (the rim's end) moves onto it, along
the way inland, and each cell's centre stands midway along whichever
diagonal joins the nearer heights: the cell is split along the contour,
and the crest is a clean line at every level. Vertices two levels share
move only along their shared edge, at the coarser level's stride, so both
move them alike and the seams stay closed.

Fragments sample `paint` and `light` (occlusion, sun visibility) and
light them as Spyglass does: a fill from the sky above (`skyColor`) and the sea below
(`seaFill`), `skyFill` strong and dimmed by the occlusion (raised to the
power `occlusion`, 1.6, so creases sit deeper than baked; the sun and the
bounce take `occlusionSun`, 0.35, of it too, so the ground stays grounded
in full light); and a golden
sun (`sunWarmth`, going neutral toward noon) wrapped round gentle ground
(`softLight`), held so a flat sunlit face is as bright at any elevation
(`sunStrength`), less `shadowStrength` of it in shadow; and warm light
thrown up off sunlit sand and shallows onto faces that look out and down
(`bounce`, `bounceColor`), read from the ground a few texels in front of
them. The sun's visibility comes from a march toward the sun over
the heights; on the sea floor its penumbra widens with the water above it
by `shadowBlur` radians a unit of depth (light scatters on its way down),
so an island's shadow lies crisp on the shoal beside it and soft over the
deep. The same march, from sea level over each sea texel, writes the
`shade` map: the sun at the water's surface, which the composite reads.
There is no ink on the coast: the beach or the drop-off is the edge.

### The sea

Everything below sea level and everything the water does at the shore is
one unit, split by layer into pure modules in `shaders/sea/` (no
bindings; the entry shaders import them) with one set of parameters,
`SeaParams` (`sea-params.ts`), and one group in the sidebar:

| Layer | Module | Used by | Parameters |
| --- | --- | --- | --- |
| bathymetry | `bathymetry.wgsl`: the platform, each island's silhouettes, the banks' levels and plates, the deep's rings, the shore (below) | the height map's coast and sea texels; the paint map's steepness | `shelfWidth` (the slope's width), `bankTop`, `bankStep`, `bankTaper`, `bankDeep`, `bankRun`, `bankSpread`, `bankHull`, `bankBottomReach`, `bankTopReach`, `bankSlope`, `bankWander`, `bankLift`, `bankLiftTread`, the `bankUndulation…` six, `bankBridge`, `bankMargin`, `bankMerge`, `bankRagged`, `bankScarp`, `bankDeepRings`, `bankBeach`, `bankMoat`, `bankMoatAmount`, the `shore…` six; and `shadowBlur`, the light map's penumbra under water |
| seascape | `seascape.wgsl`: the open sea's floor past the platform's slope, sinking from the deep floor in steps | the height map's open sea texels; the seabed map | `seascapeDescent`, `seascapeBasins`, `seascapeScale`, `seascapeVeer`, `seascapeSills`, `seascapeStep`, `seascapeHills`, `seascapeCanyons`, `seascapeFaults`, `seascapePits`, `seascapeSeed`, `seascapeReach` |
| floor | `floor.wgsl`: the sea's bands by depth, and the floor's colour before light | the paint map's sea texels; the terrain past the frame | `sandColor`, `siltColor`, `floorTint`, the six `band…` colours |
| flow | `flow.wgsl`: diffraction, breaking, refraction, swash, sediment | the flow map | `swellAzimuth`, `swellHeight`, `swellLength`, `sedimentDrift` |
| surface | `surface.wgsl`: the waves, both normals, the sky, Fresnel, the glint, the water's transmittance and tint by depth, the land's shadow on the water's own light | the composite | `waterShallow`, `waterDeep`, `waterLegend`, `seaRelief`, `seascapeRelief`, `seaRim`, `clarity`, `visibleDepth`, `depthCurve`, `waveAmplitude`, `waveSpeed`, `waveScale`, `waveSpread`, `reflection`, `specular`, `shadowAmbient` |
| shore | `shore.wgsl`: the surf, the wash against walls, the swash up a beach, and the glow of the sand under a beach | the composite | `surf`, `surfSpacing`, `cliffWash`, `washWidth`, `washPeriod`, `swash`, `swashReach`, `swashPeriod`, `wetSand`, `shoalGlow`, `haze`, `hazeNear`, `hazeFar` |

The map-side layers' parameters sit in `MapParams` too, flat, and rebuild
their maps through `MAP_OF_PARAM`; the frame-side ones are uniforms.

**The banks** (`banks.ts`, `sea/bathymetry.wgsl`, baked into `height`):
the sea floor from where the islands are and which groups they are in,
measured in chart units.

- **depths**: `bankTop` is the one depth art direction sets, the highest
  level's. The rest follow from the chart's level count n
  (`seaDepthsOf(sea, n)` in `sea-params.ts`, the only place they are
  computed): the platform lies the whole stack of levels under the top,
  the deep floor `bankDeep` under the platform. With no groups there are
  no levels, the platform is at `bankTop` and the floor `bankDeep` below
  it. On Foundry at the defaults: 19 levels, the top 2 deep, the platform
  56, the floor 80. The steps are tall, 4 at the bottom and 1.9 at the
  top, as Spyglass's are (its sea falls 92 in 14 steps): a step reads
  through the water by the shadow it casts on the tread below, and a
  lower one would not cast enough.
- **levels**: every group is a bank. `banksOf` orders them, the most
  widely shared first and ties by id, then deals them levels by first fit:
  each takes the lowest level free on all its islands. Foundry's 29 banks
  need 19 levels, the same as its most banked island's ring count. A bank
  stands at its level everywhere. The bottom level stands `bankStep` above
  the platform, and each above it rises `bankTaper` times the rise below:
  level r is `bankStep × (1 − taper^(r+1)) / (1 − taper)` above the
  platform (`bankStep × (r + 1)` at taper 1, even spacing). The stacks so
  flatten toward the top, and an island whose stack is only low levels
  still rises most of the way.
- **lift**: where the treads are broad the steps stand taller. Each
  texel takes the treads of the islands around it, weighted as the
  platform merges their coasts, and a lift of `bankLift` eased in up to
  `bankLiftTread`. A level of rise r, in a stack whose top rises R, is
  lifted to r × (1 + lift × (1 − r / R)): the most near the platform,
  none at the top, which stays at `bankTop`. Every level at a texel takes
  the same lift, so the plates keep their order. A broad two-ring stack's
  steps grow by about a quarter; where nineteen rings crowd, by next to
  nothing.
- **undulation**: every level but the top rides a long wave baked into its
  tread, one sine across the whole chart running `bankUndulationAngle`
  (45°, diagonally), its crests `bankUndulationLength` apart, its height
  `bankUndulation` of the level's own step. Each level's wave is shifted
  `bankUndulationShift` of a wave from the one below, so the levels rise
  and dip out of step, and it climbs in `bankUndulationSteps` soft
  terraces from trough to crest (0 for a smooth wave). Its crests meander
  like a current, `bankUndulationBend` wavelengths either way over cells
  2.5 wavelengths across, so they never rule straight lines; and it swells
  and calms in patches three wavelengths across, to 15% at its calmest. Kept under half a
  step, no level meets its neighbour. The platform's top rides it too, as
  a level below the bottom one (a share of the bottom step, fading out
  down its fall), so islands standing on the bare platform have texture
  round them. Not random: the same chart always
  bakes the same floor. The coasts' tiers read the levels without it.
- **silhouettes**: every banked island's stack runs between two outlines.
  Its **top** is its coast taken smoothly: the coast's distance and its
  hull (the coasts map averaged over a disc `bankHull` times its size
  across, sixteen golden-angle taps) joined by a smooth minimum, so a round
  island stays round and the bays of a ragged one fill. Its **bottom** is
  the platform's outline, held at least its ring count of `bankRun` past
  the top and at most `bankBottomReach` platform reaches past it. The top
  then moves by `bankTopReach` of the platform's lobes, which average to
  nothing: where the platform bulges the top bulges too, and where it dips
  the top pulls in, with no padding overall.
- **rings**: an island's rings are its banks by level, the deepest
  farthest out, spread evenly from its top silhouette to its bottom: each
  tread is the room between them over the ring count, so a two-ring island
  has broad benches and a nineteen-ring one narrow ones, and every island
  rises the whole way. An island's stack can skip levels. `bankRun` 0
  drops the plates and leaves the platform alone; the depths still follow
  the level count.
- **the platform**: one floor under the whole archipelago, islands in no
  group included. Its outline is every island's coast merged by a
  log-sum-exp over `bankMerge` (order-free, unlike a pairwise smooth-min),
  pushed out by `bankSpread`, and made ragged by broad lobes and ridged
  notches (`bankRagged`, cells scaled to the spread and margin). The
  platform runs `bankMargin` past that outline and every stack, a thin
  margin. Past its edge, a short escarpment drops `bankScarp` of the deep
  (over 8% of `shelfWidth`, at least 3 texels).
- **the deep's rings**: from the escarpment's foot the slope, `shelfWidth`
  wide, descends to the floor in `bankDeepRings` rings: that many treads,
  each a ring at its own depth, in equal drops of the rest of the deep,
  each riser `bankSlope` of its run (never under 2.5 texels). The runs
  grow outward by 1 / `bankTaper` a ring, the same rhythm the levels
  flatten upward by, so the rings crowd toward the platform as a contour
  map's do; each run strays by up to a fifth of itself on a per-ring hash
  (salt 729), which keeps them in order, and each edge wanders on its own
  noise (salts 730–732, cells three runs across) by `bankWander` of its run,
  held off its neighbours. 0 rings is a smooth slope.
- **plates**: a bank's members' rings join by a smooth union twice
  `bankBridge` wide, so two rings whose edges come within `bankBridge` of
  each other run across as one plate, flat at the bank's level. A plate's
  cover eases over a riser `bankSlope` of the run wide, never under 2.5
  texels. The floor is the highest of the platform and every plate over
  it, each easing from its level toward the platform, so a riser between
  two levels is the top of that ease: its foot is clipped by the plate
  below.
- **edges**: each bank's edge wanders on its own planar noise (salt 726,
  offset per bank, cells 0.3 of `bankSpread` across), by `bankWander` of
  its tread. Deeper
  levels wander less. No ring wanders farther than half the room between
  its riser and its neighbours', so rings keep their order.
- **moats**: an island cuts the plates of banks it is not in, from its
  coast out to `bankMoat` times its size (chart `Island.size`), by
  `bankMoatAmount` (0 none, 1 down to the platform), eased over the
  plate's riser. An island in no group so sits in a strait among others'
  plates.
- **the shore**: a coast's steepness is the depth of the shelf it stands
  on (the platform and the plates, not the fall past the platform's
  edge), eased from all sand at `shoreSandDepth` to all drop-off at
  `shoreCliffDepth`. Sand stands `shoreSandHeight` above the water at the
  coast and falls to sea level at the top silhouette, then curves down to
  the floor over `bankBeach`, wider by up to `shoreSmallSand` on islands
  under `shoreSmallSize`. In a bay the top silhouette closes over, the
  dry sand runs only `shoreCove` off the coast, then falls as a beach does
  to a lagoon at most `shoreCoveDepth` deep, shallow enough for the swell
  to break in, so a wide bay holds water. A drop-off falls from the coast to the floor over
  `shoreCliffWidth` instead. The land's rim rises from the shore's height
  at its coast. The paint map's alpha holds the steepness within
  `bankBeach` of each coast (1 a drop-off), for rocky coasts to come; on
  Foundry docs, lib, prompts and core are drop-offs, sandbox three
  quarters one, modules, workspaces and artifacts about a third, the rest
  beaches. The two depths are set where the levels' depths put those
  tiers: they move with `bankStep` and `bankTaper`.

Per texel, island i's distance is its own: the coasts map's layer i, read
bilinear. Where island i is the nearest, the full-resolution distance is
used instead, smoothed over an eighth of the larger of twelve runs and
the beach and exact at the coast. The two ease into each other across
the medial line. With `bankRun` 0, or a
chart with no groups, the floor is the platform alone, beaches and all.
The banks follow every island. Charts up to 64 islands retain the original
private-state height kernel. Larger charts use temporary storage in row
stripes sized to the GPU's storage-binding limit; the scratch is released
after the bake finishes. This work is paid when maps rebuild, not per frame.

**The open sea** (`sea/seascape.wgsl`, baked into `height` past the
platform's slope and into `seabed` past the frame): the floor out from the
archipelago, which only ever goes down from the deep floor the slope
reaches (the sink under it is never negative), so nothing out there stands
over the platform.

- **where it starts**: the seascape itself grows in from the calm (the
  spread, margin and `shelfWidth` from the nearest coast, about where the
  slope ends) over a further `shelfWidth`; short of it the sink is 0
  exactly. In the height map it also waits for the slope's end (`slopeEnd`,
  the escarpment's and the slope's width past the platform's edge), easing
  in over 0.6 of `shelfWidth` (`openShareOf` in `bathymetry.wgsl`), and it
  only sinks floor that has come down to the deep floor. So the platform,
  its banks, its escarpment and every ring of its slope, the last one
  wandering out past the end included, are the same texels, byte for
  byte, as with a flat open floor (`FLAT_OPEN_FLOOR` in `test-helpers.ts`,
  there for the tests), out to the frame's very edge: nothing flattens the
  floor there. Tested in `maps.test.ts`, "the open sea's floor": every
  texel the flat build stands over the deep floor on, r, g, b and a. The
  height map's a carries how far past the platform's edge the floor is
  (chart units, negative inside it, -1024 on land): the water reads how
  far the open floor has taken over from it, and the seabed map carries
  the platform's fall on past the frame from it.
- **the coasts it reads** (`openCoast`): its distance from the nearest
  coast and the way out from them come from the distance map's 16 × 16
  mip, a soft least over its points of their distance plus the way on to
  the point. That holds within the frame and past it alike, so the height
  and seabed maps read one field and meet without a seam, and the frame's
  square never shows in the fall. It is softened over 0.08 of a formation,
  which eases off the creases where the ways out from two coasts meet.
- **the fall**: `seascapeDescent` chart units of depth per unit out past
  the calm, so it falls away in the archipelago's outline and rounds off as
  it goes. It swings: its lines move in and out by up to 0.35 of a
  formation (at full `seascapeVeer`), so it changes direction across the
  formations; and sills, winding ridged crests about a formation apart,
  hold back up to `seascapeSills` of it, so the fall stalls and rises again
  toward the deep floor between basins, and a basin can be rimmed on its
  far side. Both only ever take from the fall.
- **the formations**, `seascapeScale` across and sinking it by up to
  `seascapeBasins` more: broad basins (two octaves) and long troughs along
  the zero lines of their own field, both warped (`seascapeVeer`); abyssal
  hills a third of a formation across (`seascapeHills` of `seascapeBasins`);
  sinkholes in a share of cells (`seascapePits`); and fault scarps, where
  the floor past a wandering line drops `seascapeFaults`.
- **the canyons**: they leave the archipelago's outline downhill. Each
  starts on the calm's line where a smooth field along it crosses zero
  (cells 0.7 of a formation), and runs out along the way out from the
  coasts, meandering sideways by up to 0.35 of a formation over runs of
  1.1, so now and then one swings well off its way. A tenth of a formation
  wide where it starts, it widens as the ways out fan apart (as from a disc
  the chart's size) and by 0.06 of its run, and deepens to
  `seascapeCanyons` over 0.35 of a formation. They fade out where the ways
  from two coasts meet. Salts 736–759 and 762–765 (`shaders/README.md`);
  `seascapeSeed` picks another seascape.
- **the steps**: whole steps of log depth from the deep floor, each
  `seascapeStep` times the depth of the one above, with a riser a third of
  the step: the slope's last step down is the first of them, and the gaps
  widen as the floor goes deeper.
- **the seabed map** (`shaders/maps/seabed.wgsl`, `rgba16float`, 1024 a
  side over `seascapeReach` frames across, centred on the frame; built from
  the distance and height maps): r the floor's height, g and b its normal,
  a how far the open floor has taken over. It runs the height map's own
  rules on past the frame: the platform's fall (`platformHeight`, with the
  height map's bathymetry and texel), then the open floor sinking what has
  come down to the deep floor. How far past the platform's edge a point
  is comes from the height map's a at the frame's nearest edge texel, run
  on by how much farther from the coasts the point is (`openCoast`). So
  where the fall runs into the frame's margin (Foundry's chart leaves only
  about 80 units above and below it), it carries on falling past the edge,
  ring by ring, and the open floor takes over past it as it does inside;
  the two maps meet at the edge to within a few hundredths of a unit on
  the whole. Across its outer band,
  half its reach past the frame, it eases onto the open depth, flat
  (`openFloorDepth` in `map-uniforms.ts`: the deep floor sunk by the
  descent across that reach, down to the next whole step). The terrain
  stands on it past the frame, coloured as the paint map colours the floor
  at its depth; the clipmap reaches its edge (as far as `MAX_LEVELS` takes
  it), and past the mesh the water's open floor lies at that same open
  depth, so the ground and the water meet there.
- **the water**: where the open floor has taken over, the deep calms its
  relief and rim less, by `seascapeRelief`, so its formations read; as it
  sinks from 1.2 to 1.8 deep floors deep, none of its relief shows, and the
  far sea is open water.

**The coasts map** (`shaders/maps/coasts.wgsl`, `r16float` 2D array, 512 a
side per world tile over the maps' frame): each island's exact signed
distance to its own coast, from its own segments only, its pieces culled
by their bounds. Small charts keep one layer per island. Large charts
pack up to 4×4 island fields per array layer, with clamped filtering inside
each cell. A new chart or world tile span rebuilds it; changing only the
map resolution leaves it intact.

**The flow map** (`shaders/maps/flow.wgsl`, `rgba16float`, built after
`height`): wave transport on the sea plane (r, g: chart x and y, chart
units per second), breaking 0–1 (b) and sediment 0–1 (a), for a swell
from far away. Only the surf zone, the sea shallower than the break depth
(1.3 times `swellHeight`), is computed; everything else holds zeros. Per
texel there:

- **arriving**: a march back toward where the swell comes from, like the
  light map's sun march, over the distance map. Each step reads the
  distance averaged over diffraction's edge at that range (half
  `sqrt(swellLength · range)`, from the distance mips through a B-spline)
  and lets through `0.5 + clearance / edge`; the least of them arrives.
  An island casts a shadow on its lee and its neighbours', soft at the
  edges; an islet smaller than the edge barely casts one.
- **refraction**: the swell feels the floor under half its length deep and
  turns toward the shallows (up the height map's slope) by Snell's law,
  its speed going as the square root of the depth.
- **breaking**: the arriving swell, times the cosine of its incidence on
  the shore (so swell running past a corner or away from a coast breaks
  there not at all), eased in from the break depth to full at half of it.
- **transport**: the refracted heading times breaking times the breaker's
  speed `sqrt(g · breakDepth)`; near the waterline its shoreward part
  turns along the shore, the swash.
- **sediment**: breaking times shallowness, averaged over four taps back
  along the transport, `sedimentDrift` long.

Nothing in the composite reads the flow map yet: it is built, tested and
shown in its view, for surf and the surface's swell to take up later.

### The props on the shallows

Pebbles, shells and now and then a sea stack, as real 3D instances
(`debris.ts`, `shaders/land/debris/`). A compute pass places them from the maps
whenever the maps or the densities change, before the film pass: one
jittered candidate per 1.25-unit cell over the maps' square
(`shaders/scatter/scatter.wgsl`, salts 800–806), kept by the ground it
finds and appended to a buffer of at most 65,536 through an atomic tally;
a one-thread pass then writes the indirect draws' arguments, so the CPU
never reads the count. On Foundry at the defaults: about 13,600, placed in
about 14 ms.

- **pebbles** on the beaches and the shallows to two and a half top
  levels down, `debrisPebbles` of the candidates on a lip and a third of
  that on flat floor, in patches;
- **shells** on the sand at the water's edge, `debrisShells` of the
  candidates there;
- **stacks** on shallow plates at least 8 off any coast, `debrisStacks`
  per thousand square units, standing 6 to 13 above the water;
- none on the land, and none along a drop-off coast (the paint map's
  steepness).

Each body is an icosphere from the vertex index (`geometry/icosphere.wgsl`,
240 vertices from 7 pixels across, 60 below), shaped by its kind (a
squashed lumpy stone, a ribbed dome, a tapering column), faceted, sized by
`debrisSize`, lit as the terrain lights the floor with the light map's
occlusion and shadow where it stands, and shrunk away between 0.45 and 1.3
pixels across. The water covers the ones under it as it covers the floor.
Each stack has a foam collar and two rings spreading from it
(`debrisRings`), drawn into the film just above the water, so the composite
passes them through as it passes land.

### Water

`shaders/scene/water.wgsl`, the composite, per pixel, in order: the plane hit at
`y = 0`; terrain nearer than the plane passes through; thickness from the
depth, or past the mesh from the open floor at the open depth the seabed
map eases onto at its edge (`openFloorDepth` in `map-uniforms.ts`), past
what the water shows;
refraction (`refraction`),
which moves the floor sample by the wave normal times the thickness, at
most `refractionReach` of it, and falls back to the unmoved one where it lands on terrain above the water;
a pale line at each sea step's lip (`seaLines`, `seaLineColor`) and
caustics on the shallow floor (`caustics`), both under the water (the
terrain gives that floor its own small things, sea/sand.wgsl: sand
ripples whose crests run parallel to the coast, bent and broken into
patches, `sandRipples` strong and `rippleSpacing` apart, and gold specks,
at most one in each `speckSize` cell, `speckDensity` of the cells on a
lip and a third of that on flat floor, `floorSpecks` strong in
`speckColor`; both on the shallows to about four top levels down, and
gone before they would alias);
per-channel absorption with the water's own colour building in the same
proportion (below); the water's own colour and the sky's reflection in the
land's shadow on the surface, all but `shadowAmbient` of them, from the
`shade` map at the plane hit; the shore (below); the sky by Schlick's
Fresnel; a sun glint, shadowed by the light map; haze over everything
below the horizon. It writes linear colour; the post adds the vignette
and encodes.

The absorption is in chart units of depth (`look.ts` `waterOptics`, the
same as `sea/surface.wgsl` `transmittance`). At `clarity` the floor is seen
at exactly `waterShallow`; at `visibleDepth` it still passes 10% in its
clearest channel, which sets the power the optical depth grows by with
depth (`(z / clarity)^p`, p about 0.49 at the defaults, where 1 would be
Beer–Lambert). The clearest channel's share is the floor's brightness;
the other channels' extra absorption is the tint, and it grows as that
power times `depthCurve`, so above 1 the hue holds above `clarity` and
turns fastest through it. `depthCurve` 1 is the mix before these terms.
The water's own colour, in the proportion the floor is lost, is the
chart's legend at the floor's depth, the depth of the point seen, not the
height map's, which up a wall spans the whole fall in a texel and would
saw the colour into teeth (`waterLegend` of it; `waterDeep` the
rest), as Spyglass's sea is: the bands' turquoise over the levels, cyan
over the platform, blue over the deep, each level one colour. The floor's
relief shades it (`seaRelief`, sea/surface.wgsl `floorRelief`) from the
light map: white on flat, open, sunlit floor, so the legend means what it
says; cool blue in the floor's shadows and on lee faces; a little warm on
faces turned to the sun; calmer in the deep. Each riser turned to the sun
catches a pale rim (`seaRim`, `riserRim`), so the rings read as steps from
any height. All of it applies to the thickness along the view ray.

Straight down on Foundry, at the defaults, the floor passes (r/g/b):

| Depth | Passes |
| --- | --- |
| top level, 2 | 16 / 53 / 59% |
| platform, 56 | 0 / 1 / 7% |
| deep floor, 80 | 0 / 0 / 4% |

So the floor's own light shows over the upper levels, and below them the
water's colour carries the picture: the legend's band at each level's
depth, so every level is a tint of its own, and the floor's relief shaded
through it, so every step casts its shadow.

The land's shadow on the water is narrow: the plates stand 6.6 high, so it
reaches about ten units into the lee at the default sun, nearer the land
than the floor's shadow by the depth times the sun's run over its rise.
With this palette it shows most over the straits and the deep, where the
water's own colour is most of what is seen.

Waves are `src/shaders/water/waves.wgsl`'s field, computed as slopes only,
both normals in one pass (`sea/surface.wgsl`), over the chart's own
spectrum (`look.ts` `chartWaves`). The shared spectrum is eight waves, one
an octave, sized for /pond; zoomed out only its longest two or three are
resolved, and they cross in a regular lattice that the sky's reflection
shows as a grid. So the chart takes its range of lengths (scaled by
`waveScale`, 12: about 3 to 46 units) as 32 waves instead: lengths evenly
filling the range in log, each jittered within its share; directions
spread `waveSpread` radians either side of the swell's heading,
stratified (R2 low-discrepancy steps, no random seed); each at the shared
amplitude for its length over the square root of how many share its
octave, so the slope variance, and with it the glint's width, stays the
shared spectrum's. With that many directions no few waves line up, and
the resolved ones read as wind-driven sea, not a tile (a broad spectrum
is what keeps a sum of sines from repeating: [GPU Gems 1, ch. 1](https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-1-effective-water-simulation-physical-models)).
Their domain is also bent by four long swells (about 150 units, sharing
no period). The waves are faded by
their length in pixels twice over. The shading normal (reflection,
refraction) keeps a wave until it is under 8–24 pixel footprints long. The
glint's normal lets it go well before that, under 16–48, and the slope it
carried widens the sun's lobe instead (Toksvig), so the glint is crisp up
close and a soft sheen far out. Kept down to a few pixels, the sun lit
every wave as a streak and covered the open sea in an even pattern.

The shore (`sea/shore.wgsl`), at the plane hit:

- **surf**: where the flow map's breaking channel says the swell breaks,
  so the windward beaches surf and the lee and the drop-offs barely do.
  Crests `surfSpacing` apart run parallel to the coast and roll ashore at
  the breaker's speed, turned by a swash noise: each a sharp shoreward
  front with a frothy tail behind it, broken into patches and froth, and
  fading out four spacings off the edge. A line of foam stands at the
  water's edge, measured off the edge by the depth over the floor's
  slope. Crests too close to resolve fade to their mean.
- **the beach's glow**: cream sand under the first units of water going
  to aqua, out to `bankBeach` off a coast, giving back a little light
  (`shoalGlow`). The paint map's alpha switches it off on drop-offs.
- **the wash**: where the swell meets a wall it does not break on the way
  in, so the surf leaves it bare. Instead the wall wears the sea stacks'
  foam: a crisp collar hugging the rock, and each swell, every
  `washPeriod` seconds, sends a ring of foam spreading off it parallel to
  the wall out to `washWidth`, thinning and fading as it goes. The swells
  arrive unevenly along the wall and the foam's edge wavers a little. A
  wall is wherever the water has deepened fast off the coast (depth over
  distance from it, 0.8 to 2), not the paint map's alpha, which only half
  marks some faces of a drop-off island.
- **the swash**: on a beach's dry sand, what is left of each broken wave
  runs up as a thin sheet tinted by the shallowest band, its edge laced
  with foam, and drains back, every `swashPeriod` seconds, arriving
  unevenly along the shore. It runs `swashReach` up the sand where the
  surf just offshore is full (the flow map's breaking, the most of six taps
  around) and about a third of that on a lee beach; none on drop-offs. The
  sand under it is wet (`wetSand` dark) and dries from the top as it drains.
  Drawn on the terrain the water passes through.

Haze is by distance in eye heights, past the first:
`exp(-haze · (distance / eyeHeight − 1))` of the colour is kept, the rest
goes to the haze, cool near the camera (`hazeNear`) and warm far off
(`hazeFar`, the sky's horizon). A view straight down stays clear, every
view fades the same way into its horizon, and where the distance runs out
the sea meets the sky without a line.

### Parameters

The frame's `renderScale` (1: the film's size against the canvas; the
composite upsamples), and the sea's, after the land's map parameters
(`map-params.ts`):

| Parameter | Default | What |
| --- | --- | --- |
| `shelfWidth` | 150 | The slope's width: past the escarpment the floor falls the rest of the way to the deep over this, in the deep's rings |
| `bankTop` | 2 | The highest level's depth: deeper than the swell's break depth (1.3), so the treads don't surf. The platform and the floor follow from it and the level count |
| `bankStep` | 4 | How far the bottom level stands above the platform |
| `bankTaper` | 0.96 | Each level's rise as a share of the one below, 0.4–1; 1 spaces them evenly. With 4 and 19 levels the stack is 54 deep, its top step 1.9; at 0.85 it would be 25.5 and its top step 0.2, too low to cast a shadow through the water |
| `bankDeep` | 24 | The drop from the platform to the deep floor: on Foundry the floor at 80 |
| `bankRun` | 3 | The narrowest tread, chart units (at least 2.5 texels): a stack reaches at least its ring count times this past its top silhouette. 0 for no banks |
| `bankSpread` | 80 | How far the platform's outline lies past the merged coasts before its lobes and notches: the room every stack shares out between its rings |
| `bankHull` | 0.35 | The top silhouette's smoothing, a share of the island's size; 0 for the coast itself |
| `bankBottomReach` | 2 | How far a bottom silhouette may run past its top, in platform reaches |
| `bankTopReach` | 0.2 | The share of the platform's lobes the top silhouette takes, and so the sand |
| `bankSlope` | 0.4 | A riser's width as a share of its run (at least 2.5 texels), the banks' and the deep's |
| `bankWander` | 0.25 | How far a ring's edge strays, as a share of its tread |
| `bankLift` | 0.3 | The share a step's rise grows by between broad rings, 0–1; less toward the top level, none at it |
| `bankLiftTread` | 30 | The tread, chart units, that takes all of the lift; crowded rings take next to none |
| `bankUndulation` | 0.4 | The undulation every level but the top rides, as a share of its own step (at most 0.45); 0 for none |
| `bankUndulationLength` | 80 | Chart units between the undulation's crests |
| `bankUndulationAngle` | 45 | The way the undulation runs, degrees from east toward south |
| `bankUndulationShift` | 0.45 | The share of a wave each level's undulation is shifted from the one below |
| `bankUndulationSteps` | 3 | The terraces the undulation climbs in from trough to crest; 0 smooth |
| `bankUndulationBend` | 0.6 | How far the undulation's crests meander like a current, in wavelengths; 0 straight |
| `bankBridge` | 40 | How close two members' rings come to join as one plate |
| `bankMargin` | 15 | How far the platform runs past its outline and every stack: a thin margin |
| `bankMerge` | 80 | The log-sum-exp's scale: islands join into one outline where the gap between them is under about twice the margin plus 1.4 times this |
| `bankRagged` | 0.6 | Lobes and notches in the platform's edge |
| `bankScarp` | 0.5 | The escarpment's share of the fall to the deep |
| `bankDeepRings` | 6 | The rings the slope descends in; 0 for a smooth slope |
| `bankBeach` | 16 | How far a sand beach curves down from the top silhouette to the floor |
| `shoreSandDepth` | 18 | A coast over a shelf at most this deep is all beach |
| `shoreCliffDepth` | 50 | A coast over a shelf this deep is all drop-off: with 18, Foundry's beaches, its mixed coasts and its drop-offs fall where they did on the shallower levels |
| `shoreSandHeight` | 0.8 | The sand's height above the water at the coast, falling to sea level at the top silhouette |
| `shoreCliffWidth` | 3 | How far a drop-off falls from its coast to the floor (at least 2.5 texels) |
| `shoreSmallSand` | 0.25 | A small island's extra beach, as a share of `bankBeach` |
| `shoreSmallSize` | 100 | The island size by which the extra beach is gone |
| `shoreCove` | 6 | How far dry sand runs into a bay before it dips under the water; 0 fills bays with sand |
| `shoreCoveDepth` | 0.75 | The most a bay's water is deep: shallow, so the swell breaks across it |
| `bankMoat` | 0.25 | The moat an island cuts in plates it is not in, as a share of its size |
| `bankMoatAmount` | 0.5 | How much of a plate the moat cuts |
| `seascapeDescent` | 0.035 | How far the open floor sinks per chart unit out from the coasts, past the slope's end |
| `seascapeBasins` | 40 | How far its basins, troughs, hills and sinkholes sink it further, at most; 0 for none |
| `seascapeScale` | 900 | Its formations' size, about a basin's width |
| `seascapeVeer` | 0.6 | How far the warp bends its formations and its fall swings; 0 not at all |
| `seascapeSills` | 0.6 | The most of the fall its sills hold back on their crests, 0–1, so it stalls and turns between basins; 0 for none |
| `seascapeStep` | 1.12 | Each step's depth against the one above; 1 for no steps |
| `seascapeHills` | 0.35 | The abyssal hills, a share of `seascapeBasins`; 0 for none |
| `seascapeCanyons` | 40 | How deep the canyons running downhill off the archipelago's outline cut; 0 for none |
| `seascapeFaults` | 12 | How far the floor drops past its fault lines; 0 for none |
| `seascapePits` | 0.3 | The share of sinkhole cells that hold one |
| `seascapeSeed` | 1 | Another seed, another seascape |
| `seascapeReach` | 4 | The seabed map's square, in frames across |
| `shadowBlur` | 0.002 | Radians the sun's penumbra widens a unit of depth on the floor: twice the sun's own radius on the platform, three times on the deep floor. 0 for the sun's own everywhere |
| `sandColor` | `#f3e8c7` | The beaches and the shallow floor |
| `siltColor` | `#66807f` | The floor in the deep, reached at the platform's depth |
| `floorTint` | 0.75 | How far the floor takes its depth's band colour |
| `sandRipples` | 0.6 | The sand ripples on the shallow floor, crests parallel to the coast; 0 for none |
| `rippleSpacing` | 4 | Chart units between the ripples' crests |
| `floorSpecks` | 0.8 | Gold specks on the shallow floor, thickest on the levels' lips; 0 for none |
| `speckSize` | 3.5 | Chart units of the specks' cells, at most one speck in each |
| `speckDensity` | 0.25 | The share of cells holding a speck on a lip; a third of it on flat floor |
| `speckColor` | `#f0c060` | The specks' colour |
| `bandShore` … `bandTrench` | `#d2f6e8`, `#4fd8cf`, `#1fb2c2`, `#11769c`, `#0c3f6f`, `#051a38` | The sea's colours: reached at the waterline, the top level, half the platform's depth (shelf), 40% of the way from the platform to the deep floor (slope), the deep floor, and twice its depth (trench) |
| `swellAzimuth` | 4.4 | Where the swell comes from, radians clockwise from north: west-south-west |
| `swellHeight` | 1 | It breaks under 1.3 units deep: within a few units of each coast, on its beach |
| `swellLength` | 40 | It feels the floor under 20 deep, the upper levels round each island (the platform is 56), so it wraps round each island's headlands; its shadows blur over `sqrt(40 · range) / 2` |
| `sedimentDrift` | 8 | How far the surf carries the stirred shoal |
| `waterShallow` | `#4fb3bf` | What the floor's light turns through `clarity` units of water |
| `waterDeep` | `#0b2550` | The colour the water builds to in the deep, where `waterLegend` leaves it |
| `waterLegend` | 1 | How far the water's own colour is the legend at the floor's depth rather than `waterDeep`, 0–1 |
| `debrisPebbles` | 0.35 | Pebbles on the beaches and the shallows: the share of candidates kept on a lip; 0 for none |
| `debrisShells` | 0.3 | Shells on the sand at the water's edge: the share of candidates kept; 0 for none |
| `debrisStacks` | 0.03 | Sea stacks per thousand square chart units of shallow plate; 0 for none |
| `debrisSize` | 1 | Multiplies every pebble, shell and stack |
| `debrisRings` | 1 | The foam rings on the water round each stack; 0 for none |
| `seaRelief` | 0.9 | How strongly the floor's relief shades the water's colour, 0–1 |
| `seaRim` | 1 | The pale rim on each riser where it faces the sun; 0 for none |
| `seascapeRelief` | 0.8 | How far the open floor keeps its relief and rim through the deep, 0–1; nothing on the platform or its fall |
| `clarity` | 3 | The depth at which the floor is seen at exactly the shallow colour: by the top levels, where the tint turns fastest |
| `visibleDepth` | 40 | The depth at which the floor still passes 10% in its clearest channel; below it the deep colour takes over. At 40 the platform passes 21% in blue and the deep floor 10% |
| `depthCurve` | 2 | The tint's curve: 1 grows it as the brightness does (the mix before it); higher holds it above `clarity` and turns it faster through and past it. 3 about doubles the top levels' steps but turns the platform the deep's hue |
| `waveAmplitude` | 1 | 0 is a flat, still sea: nothing animates |
| `waveSpeed` | 1 | |
| `waveScale` | 12 | Chart units per unit of the shared wave spectrum's lengths |
| `waveSpread` | 1 | Radians the 32 waves' directions spread either side of the swell's heading |
| `reflection` | 0.6 | The sky's reflection, by Fresnel |
| `specular` | 0.6 | The sun's glint |
| `refraction` | 0.6 | How far a unit of thickness moves the floor seen through the waves, per unit of slope |
| `refractionReach` | 18 | The most thickness the refraction moves the floor by: the shelf's depth before the rings grew, so the deep wavers as the shelf did |
| `seaLines` | 0.32 | The pale line at each sea step's lip (`seaLineColor` `#a6eef0`) |
| `caustics` | 1 | Light focused by the waves on the floor shallower than about four top levels; cells `waveScale` across |
| `surf` | 1.25 | The surf where the swell breaks; 0 for none |
| `surfSpacing` | 3 | Chart units between the surf's crests |
| `cliffWash` | 1 | The foam where the swell meets a wall of rock, and its splashes; 0 for none |
| `washWidth` | 6 | Chart units out from a wall the wash's rings spread to |
| `washPeriod` | 3.5 | Seconds between the swells that send a ring of foam off a wall |
| `swash` | 1 | The sheet of water running up a beach's sand and back; 0 for none |
| `swashReach` | 0.4 | How high up the sand it runs, chart units above the water, where the surf is full |
| `swashPeriod` | 5 | Seconds between swashes |
| `wetSand` | 0.8 | How dark the sand the swash wets is |
| `shoalGlow` | 0.4 | The glow of the sand under a beach; none on drop-offs |
| `shadowAmbient` | 0.45 | How much of the water's own colour and the sky's reflection survives in the land's shadow on the water |
| `haze` | 0.04 | Optical depth per eye height of distance past the first; 0 for none |
| `hazeNear`, `hazeFar` | `#b8ccdb`, `#ffd6a3` | The haze near the camera and far off; the far one is the sky's horizon |

The light's and the finish's, frame-side: `sunStrength` 0.78, `sunWarmth`
0.5, `skyFill` 0.58, `skyColor` `#93b2da`, `seaFill` `#6a8c9c`, `softLight`
0.45, `shadowStrength` 0.6, `occlusion` 1.6, `occlusionSun` 0.35,
`bounce` 0.9, `bounceColor` `#ffe0b0`, `rockColor` `#b08878`, `rockTint`
0.35. The post's: `bloom` 0.3, `bloomThreshold` 0.85, `bloomRadius` 1,
`antialias` on, `vignette` 0.36, `vignetteColor` `#c7b399`. The
selection's: `selection` on, `highlight` 0.4, `highlightOutline` 0.9, `highlightMembers`
0.5, `highlightDim` 0.3, `highlightColor` `#fff3cf`. And the paint's:
`palette` (order).

## Selection

A click chooses what is under the pointer: on land the building whose
footprint it falls on (its files, `view/building-at.ts`), else its island;
at sea the ring whose plate the floor stands on (a bank: the islands that
share the same dependencies). The pick keeps the chart point the click
landed on, read back with the rest, and the CPU tests only the picked
island's buildings against it; a building shows as its island chosen. The
pointer hovers islands and rings only, and Escape lets
go; `selection` off lets go and stops picking (the highlight costs
nothing then: the composite skips it with nothing chosen or hovered).
The debug panel's readouts name the chosen and the hovered in the
chart's own terms: an island by its name, a ring by its group's foundations (`zod`;
`ansi-regex, ansi-styles, balanced-match +9`), with the islands that
share it.

- **The rings map** (`r` of `rgba16uint`, written by the height kernel
  beside the height): the bank whose plate wins at each sea texel, its
  index in the global order + 1; and in `g`, `b`, `a` a bit for every
  bank whose plate covers the texel at all, under whatever stands on it
  for small charts. Larger charts bake all bank footprints into pages of
  128 bits, then `selection-cache.ts` resolves the chosen and hovered
  footprints into one ordinary 2D texture when selection or baked inputs
  change. A one-thread GPU check skips the resolve when IDs are unchanged.
  The water shader reads this cache instead of decoding pages per pixel;
  small charts allocate no cache or extra selection dispatches. Land,
  the platform and the deep hold 0 in the original rings map. Two rings
  textures at 2048² (the one on show and the spare) are 64 MB.
- **The pick** (`pick.ts`, `shaders/view/pick.wgsl`): one dispatch at the
  head of the next frame that reads the film's depth under the pointer as
  the last frame left it, rebuilds the ground there (under the water, the
  floor, unrefracted) and keeps the chosen and the hovered in a 16-byte
  buffer the water binds. A frame picks once however fast the pointer
  moves (a hover replaces the one waiting). The highlight follows in the
  same frame without a readback; the readouts read the buffer back, one
  read at a time and at most every 120 ms.
- **The highlight**, last in the water composite, over everything: the
  chosen's and the hovered's shares read bilinear from the islands and
  rings maps round the ground under each pixel, so their edges run smooth
  between texels. One read of each texel serves both; a map no one asks
  about is not read, and nothing is read off the maps' square. The
  chosen lightens toward `highlightColor` (`highlight`, a screen), the
  rest of the chart darkens by `highlightDim` while something is chosen
  (fading out past the maps' square, so the open sea meets the sky as it
  did), and an outline
  with a soft glow runs round the chosen and, fainter, the hovered
  (`highlightOutline`). A chosen ring's whole footprint lightens, the
  rings standing on it too, and its islands by `highlightMembers`; the
  outline runs round the footprint alone.

The renderer knows only indices; `selection.ts` reads what one stands
for from the chart, so the chart's data is attributed to a ring without
the maps knowing what a ring means.

## Debug views

`view` drapes one map over the same terrain in place of the lit paint,
without the water:

| View | Shows |
| --- | --- |
| `distance` | sea pale to deep blue, land pale to deep orange, contours every quarter of twice the shelf width, black on the coast |
| `islands` | each texel's owner in its placeholder colour, flat (nearest texel) |
| `coverage` | grey |
| `height` | sea navy at the floor to pale at sea level, land green to white at the top |
| `rings` | each bank's plate where it is on top in a hue of its own, the platform and the deep dark, land grey |
| `flow` | the surf's transport, hue by direction (east red, south green, west cyan, north violet) and brightness by speed; a white line where breaking begins; sediment as a sand hatch; land dark grey |
| `light` | occlusion times the sun's diffuse and visibility, grey |
| `shade` | the sun at the sea surface, grey; land a dim brown |
| `paint` | the paint, unlit |
| `files` | each module as a disc at its place, source amber, tests cyan, stories violet, the rest grey, frequently changed files larger and red, over the paint dimmed |
| `zoning` | reserved ground red, tree density green, shrub density blue, over the paint dimmed and lifted where the ground is open |

The coasts map has no view: it is one distance per island, which only
the height map reads.

| | | |
| --- | --- | --- |
| ![distance](shots/distance.png) | ![islands](shots/islands.png) | ![coverage](shots/coverage.png) |
| ![height](shots/height.png) | ![flow](shots/flow.png) | ![light](shots/light.png) |
| ![shade](shots/shade.png) | ![paint](shots/paint.png) | ![rings](shots/rings.png) |
| ![files](shots/files.png) | | |

## Files

The folder is one renderer behind one entry, `api/index.ts`, grouped by
concern. Its WGSL lives under `shaders/`, in folders that mirror the
TypeScript's. The tools run under Node and are never imported by the
renderer.

| Folder | What |
| --- | --- |
| `api/` | The public entry (`index.ts`): `<IslandsCanvas>`, its hooks, the Foundry adapter and the public types (`types.ts`); the engine behind the component (`islands.ts`) |
| `maps/` | The maps: their bake, parameters, uniforms and layout |
| `sea/` | The banks and the sea's parameters and settings |
| `land/` | The terrain mesh's layout and the props on the shallows |
| `world/` | The world plan and its layers: zoning, surfaces, structures and the town, foliage |
| `view/` | The camera, the pick and the selection |
| `scene/` | The frame: the scene, the look and the frame's uniforms |
| `post/` | The post |
| `tools/` | Headless shots, timings and their shader loading (Node only) |
| `test-helpers.ts` | Fixtures and readings the tests share (tests only; never synced) |
| `shaders/` | Every shader of the renderer's own, by the same concerns |

```tsx
import { chartFromFoundry, IslandsCanvas, useIslands, useIslandsFrame } from "…/gpu/islands/api";

<IslandsCanvas
  chart={chart} // replaced, the world is replanned and the maps rebuilt
  settings={{ waveAmplitude: 0 }} // over the defaults
  selected={id} // an island's, a ring's or a module's chart id; null lets go; left out, clicks decide
  view={orbit} // opens there (else fitted); a new value moves the camera
  controls={{ turn: false, keyboard: "canvas", reducedMotion: true }}
  debug={{ time: (name, ms) => {} }}
  label="What the canvas shows"
  onSelect={(described) => {}} // also onHover, onStats, onFrame, onError
  onReady={(islands) => {}} // the handle: frame, fit, setView, view, project…; null once disposed
>
  <Labels /> {/* drawn over the canvas, positioned by itself */}
</IslandsCanvas>;

function Labels() {
  const overlay = useIslands(); // { canvas, islands } once running, else null
  useIslandsFrame(({ canvas, islands }) => {
    // once a drawn frame: place labels with
    islands.project([x, y], islands.heightAt([x, y])); // { x, y, visible }, CSS pixels, always finite
    islands.pixelsPerUnit(); // CSS pixels a chart unit spans at the orbit's target
  });
  return null;
}
```

The handle (`Islands`, api/types.ts) also takes `frame(id)` (flies over
an island, a ring or a module; null is the whole chart), `fit()`,
`setView(orbit)` and `select(id)`. `onError` hands `{ kind, error }`:
`unsupported` (no WebGPU or adapter at start), `lost` (the device),
`runtime`. `onFrame` hands `{ cpuMs }`, the main-thread time to encode and
submit it, which `stats.frameMs` also carries. A module (a file) has no
highlight of its own: selecting one chooses its island on the GPU,
describes it as `kind: "module"`, and frames it.

The component starts the engine (`createIslands`, api/islands.ts) after
mount, hands prop changes to its setters and disposes it on unmount. The
engine is internal: `experiment.ts`, the /islands page, imports it from
api/islands.ts because the lab hands it a canvas; it loads the Foundry
fixture and passes the parameters panel on.

| File | What |
| --- | --- |
| `params.ts`, `sea/sea-settings.ts` | The settings. Map parameters carry `MapParams`' names, the sea's (`sea-settings.ts`) `SeaParams`' |
| `sea/banks.ts` | The groups as banks in one global order, their levels by first fit, and each island's rings by level. Pure |
| `sea/sea-params.ts` | `SeaParams` and its defaults, its key tables (`SEA_KEYS`, `SEA_COLORS`), which map each map-side one rebuilds, the depths the levels derive (`seaDepthsOf`), the swell's heading, break depth and surf speed. Pure |
| `scene/look.ts` | Settings to `SeaParams` and `MapParams` (`resolution` from a string, colours from sRGB hex), the wave spectrum at `waveScale`, and the frame's `Look`. Pure |
| `experiment.ts` | Title, card, readouts, and the host: the fixture, the parameters, the stats |
| `api/islands.ts` | The engine: build and the dirty-flag loop, the settings, the chart, the selection by id, the camera and the events |
| `api/types.ts` | The public types: options, stats, events, controls, errors and the `Islands` handle |
| `api/islands-canvas.tsx` | The renderer as a React component, with `useIslands` and `useIslandsFrame` for what it draws over the canvas |
| `view/selection-controller.ts` | Pointer gestures, queued picks, choices by id, readout throttling and teardown |
| `view/keys.ts` | Where the camera's and the selection's keys listen (window, canvas, nowhere) and the keys they leave alone: typed into a field or inside an open dialog |
| `view/framing.ts` | The circle of the chart an island's, a ring's or a module's id frames. Pure |
| `land/height-at.ts` | The terrain's height at a chart point on the CPU: the land's profile from the coasts, an approximation at sea. Pure |
| `maps/map-data.ts`, `maps/map-uniforms.ts`, `maps/uniforms.ts` | Pure chart packing, map frames and shared land/sun uniforms |
| `maps/bake-layout.ts`, `maps/height-bake.ts` | World tile layout, coast atlas packing and temporary height workspace |
| `view/selection-cache.ts`, `shaders/view/selection-*.wgsl` | Large-chart highlight resolution after GPU selection changes |
| `view/selection.ts`, `view/pick.ts`, `shaders/view/pick.wgsl` | The selection: what is chosen and hovered, kept on the GPU by the pick, and named from the chart. `selection.ts` is pure |
| `view/camera.ts` | The orbit, its reversed-Z view, `fit`, the projection and scale for hosts, framing and eased flights, and the input |
| `land/clipmap.ts` | The terrain mesh's layout and index buffers |
| `scene/scene.ts` | The film, the terrain draws, the props, the water composite, then the post |
| `scene/frame-uniforms.ts` | The terrain's, water's, props' and post's uniforms from the `Look` and `View`. Pure |
| `post/post.ts`, `shaders/post/` | The post: the bloom chain (`bloom.wgsl`), the finish (`finish.wgsl`: bloom, vignette, shoulder, encoding) and the anti-aliasing (`antialias.wgsl`) |
| `land/debris.ts`, `shaders/land/debris/` | The props on the shallows: their placement (`place.wgsl`), their bodies and the stacks' rings (`props.wgsl`), the instance layout they share (`instance.wgsl`) |
| `shaders/land/terrain.wgsl`, `shaders/scene/water.wgsl`, `shaders/land/views.wgsl` | The two passes; the debug ramps and the flow view |
| `shaders/land/land.wgsl`, `shaders/land/grass.wgsl` | The land's profile, pure: baked by the height map, rebuilt by the terrain's vertices; and the turf on it |
| `shaders/sea/` | The sea's layers, pure: bathymetry (the floor and the shore's shape), seascape (the open sea's floor), floor (bands, sand, silt), flow, surface, shore (surf, the beach's glow), sand (ripples, specks) |
| `maps/maps.ts`, `maps/map-params.ts`, `shaders/maps/` | The maps (their own lane); `maps/flow.wgsl` is the sea's flow kernel, `maps/coasts.wgsl` each island's own distance for the banks, `maps/height.wgsl` the height map and the rings map in one pass, `maps/spline.wgsl` a smooth read of a mipped map, `maps/light.wgsl` the light map and the shade map in one pass, `maps/files.wgsl` a disc per module, instanced, `maps/seabed.wgsl` the open sea's floor past the frame, and `maps/zoning.wgsl` the world plan's zones, rings and reserves, instanced (`world/zoning.ts` packs them; both tested in `maps/files.test.ts`) |
| `world/`, `shaders/world/` | The world plan and its layers (WORLD.md, TOWNS.md) |
| `tools/headless.ts` | Shader loading and a PNG writer for the tools |
| `tools/capture.ts`, `tools/bench.ts` | Shots and timings |
| `tools/sync-spyglass.ts` | The byte-for-byte copy in Foundry's Spyglass viewer: `check`, `push`, `pull`, naming the Spyglass app with `--target <dir>` or `SPYGLASS_APP` (no default; for example the `feat-spyglass-islands-renderer` worktree's `apps/spyglass`). The copy is everything `api/index.ts`, `params.ts` and `data/foundry.ts` reach through TypeScript imports, asset URLs and WGSL imports as vgpu resolves them, plus these notes; nothing outside `apps/web/src` or the copy's folder is read or written. `sync.json` lists the synced files that differed from the recorded commit, and `check` warns when there were any; `tsconfig.islands.json` (`bun run typecheck:islands`) checks the same files under Foundry's `noUncheckedIndexedAccess` |

## Shots and timings

```sh
bun src/gpu/islands/tools/capture.ts [shot…] [--dataset=foundry] [--out=dir]
bun src/gpu/islands/tools/bench.ts [--dataset=foundry] [--resolution=2048] [--distance=1] [--pitch=1.05]
bun test src/gpu/islands
apps/web/node_modules/.bin/vgpu check src/gpu/islands/shaders/<folder>/<file>.wgsl --require-validation
```

`capture.ts` writes `shots/`: `fitted` (also the card), `close`, `low`
(the fitted view at a pitch of 0.3, out to the horizon), `dry` (the shaded
terrain without water), `centre` (straight down on the centre cluster,
dry) and one per debug view, 1536×1024.

`bench.ts` times 2560×1600 frames: the terrain alone, then with the water
still, with waves, with waves and no bloom or FXAA, and with waves at
render scale 0.5. On an Apple M4 Max
(Foundry, maps 2048², fitted view) the terrain pass takes about
1.1 ms and the water composite about 3.3 ms (0.7 ms as a pass-through);
at a mid zoom (`--distance=0.12 --pitch=0.5`), 1.3 ms and 2.8 ms. The
cliff's fans and snapping are about 0.5 ms of the terrain's, the props
about 0.4 ms at the mid zoom. The post's bloom and FXAA cost less than the
bench can tell from noise at 2560×1600 (15.1 ms a frame with them, 15.4
without, medians); its passes are not timed one by one, since on Metal a
pass's timestamps take in the wait for the passes before it. Another tab
drawing on the GPU at the same time can double these.


The open sea's cost (Foundry, maps 2048², Apple M4 Max, headless; the
bake timings are medians of nine rebuilds and vary by a third or more
between identical runs, and browser frame rate was not measured):

- **clipmap levels** for the capture shots, before the open sea (8103d81)
  and with it: `fitted` 2 → 3, `close` 4 → 6, `low` 4 → 5, `dry` 2 → 3,
  `centre` 2 → 4, and each debug view 1 → 3, as the levels now reach the
  seabed map's square (`MAX_LEVELS` caps them).
- **rebuilds**: a seascape setting (`seascapeSeed`) rebuilds height and
  all it feeds plus the seabed map in about 80–90 ms, against about
  55–60 ms when the open sea first landed (b28840c, whose coasts came
  from the distance map alone) and 45–65 ms for a bank setting before it
  (8103d81). The difference is `openCoast`'s 256 taps for every texel
  past the slope's end, in both maps. A land-only setting (`plateHeight`)
  pays it too, about 65 ms against 40–45 ms, and now rebuilds the seabed
  map as well, which reads how far past the platform's edge the height
  map has the floor at the frame's edge. `seascapeReach`
  rebuilds the seabed map alone, about 11–15 ms. A first build is about
  150 ms either way.

## Scaling verification

`scaling.test.ts` bakes 500 islands and 500 banks on a native GPU, checks
that every land and bank ID survives, exercises high-index selection and
cache invalidation, renders and picks island 500, and checks a four-tile
bake through the existing 2D texture contract. Baking and memory costs
still grow with chart size and resolution; these checks do not establish
interactive rebuild times for every chart size.

The recovery comparison uses the same Apple Metal adapter, 1536×1024
canvas, camera and settings. Fitted and close views submit respectively
1,835,008 and 4,194,304 terrain triangles before and after the changes.
Twelve of fourteen baseline PNGs match byte for byte, including all debug
maps. The fitted and close PNGs differ in 14 and 3 channel bytes respectively,
by one out of 255. Warm Chrome samples measured about 118/120 FPS fitted
and 117/114 FPS close (before/after); timings vary with system load.


A separate native benchmark with 500 islands and 500 banks at 2048² maps
and 2560×1600 output measured a 57.9-second cold bake and a 7.24 ms median
steady frame with waves (GPU terrain 1.97 ms, water 3.54 ms). This confirms
steady rendering is decoupled from the costly bake; it does not make large
parameter rebuilds interactive. An alternate scratch layout took 79.0
seconds and was rejected. These synthetic-chart timings are not a matched
comparison against the Foundry chart.
