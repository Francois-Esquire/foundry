# Spyglass geology

Maintainer note, excluded from the Blume site. Dated 2026-10-19. This note
records the primitives the geological atlas is built from: one continuous
terrain under and above the water, the islands as its exposed peaks. The
structural terrain beneath them is described in `_terrain.md`.

## Contract

`apps/spyglass/src/lib/visualization/geology.ts` holds the one vertical
convention every primitive shares. The structural terrain's levels are
kept: the water level is 0, the open abyss is −1, and land rises toward 1.
Carved features may reach `trenchFloor`, −1.25. Nominal metres exist only
to read a level as a chart prints it, never to compute:

| Band | Nominal depth | Elevation |
| --- | --- | --- |
| Shoreline | 0–5 m | 0 to −0.03 |
| Shallows | 5–20 m | −0.03 to −0.12 |
| Shelf | 20–100 m | −0.12 to −0.3 |
| Slope | 100–1,000 m | −0.3 to −0.75 (500 m at −0.5) |
| Deep ocean | 1,000–2,000 m | −0.75 to −1 (abyss) |
| Trenches | 2,000 m+ | −1 to −1.25 (4,000 m) |

The mapping is piecewise linear between those knots, so equal steps of
elevation are not equal metres. No band boundary sits on a structural cap:
`shelfTop` reads about 27 m and `basementTop` about 700 m, because
structure approaches its caps asymptotically and a contour on one would
wander over flat seabed. Land reads as 600 nominal metres at full
height. Every field shares the structural terrain's grid, and
`sampleGrid` reads any of them bilinearly between cell centres.

The default map draws the islands' surveyed coasts and the structural
terrain's signed distance as they are. The geology preview's world field
stands on its own coasts instead, cleaned and sculpted from the surveyed
ones, and its signed distance is a true distance rebuilt from them; see
"Coasts and lagoons". A landform is 0 at the coast and at most full land
height. Atoll lagoons and their inlets are the one place inside a coast
that goes below the water: the world terrain's own landform carves them,
so cells inside a coast there are negative and keep their atoll as owner.

## Primitives

| Module | What it gives |
| --- | --- |
| `world-terrain.ts` | The world field, composed in order: the structural sea, the archipelago platform, seabed contributions, a terrace pass and a seeded detail pass; cells inside a coast from a landform, and the owning island of each. By default the coasts are the islands' surveyed ones and no cell changes sign; the preview asks for its own coasts and lagoons. |
| `coasts.ts` | The preview's coasts: each surveyed coast with its pools filled, its islets joined by sandbars or grown into cays, and its outline moved a little out and in by seeded noise, traced back into polygons; and each piece of land's depth. |
| `lagoons.ts` | Atoll lagoons and their inlets, planned over the preview's coast distance and carved into the landform, so the world grid and the preview's fine lattice read one lagoon. |
| `archipelago-platform.ts` | One shallow platform under each workspace frame, with a sandy apron round every island and a benched escarpment down to the abyss. |
| `archipelago-hull.ts`, `scene/ocean-emanation.ts` | One smooth outer hull per workspace frame, and the gradient and rings that emanate from it across the whole sea. |
| `noise.ts` | Deterministic value and gradient noise, fBm, ridged fBm and domain warp, from an integer hash a shader can mirror. |
| `landforms.ts` | Island anatomy (beach lip, terraces, escarpments, summit plateau) and six formations. |
| `seafloor-features.ts` | Ridges, channels, seamounts and trenches, each named and kept as its own seabed contribution. |
| `contours.ts`, `scene/contour-lines.ts` | Contour levels by depth band, a baked contour coordinate with every level on an integer, and an anti-aliased line node. |
| `sea-stacks.ts`, `scene/sea-stacks-mesh.ts` | Sea stacks off a coast, one for each runtime third-party dependency only that package relies on. They are instances over the world field, never seabed contributions. |
| `layout/water-optics.ts`, `scene/water-optics.ts` | Depth-based absorption and in-scatter over the seabed, calibrated to the legend, as a CPU model and its TSL port. |

## Platform and terraces

Every package in a workspace shares the workspace, so a frame's islands
stand on one platform. Its extent is the frame's distance to the nearest
coast, blurred so near islands join without a waist, out to `reach`, and
displaced past the aprons by seeded noise: warped fBm for bays and lobes,
ridged fBm for spurs reaching toward neighbours. Every island stands on
its own pale bank: an apron of 5–16 m within about 18 map units of its
coast, its reach and edge varied by noise, falling over about 36 more to
the platform and blended into it with a smooth maximum, so no island
wears a ring at a constant offset. Between the banks the platform drops
into basins: from about 45 m it sinks by up to 160 m over 60 map units
past the aprons, broad noise making some basins deeper than others, so
the interior steps from the shelf into the 100–250 m plate. Its rim lies
at 90 m. Related islands' banks merge along the ridges raised over the
basins (see Seafloor features). The rim steps down through benches at
175, 375, 875 and 1,750 m, the middles of contour spans, to a flat foot
at the abyss. Each riser wanders within its step by its own mix of two
noise fields, so the benches widen and narrow independently and no
contour runs parallel to the rim; the last riser keeps to its step's
start, so the open abyss is untouched.
Frames never join, and no apron stands past the bisector between frames.
Shelves and basements stand on the platform rather than the abyss: a
cell's share of the structural column is filled again between the
platform floor and the apron's edge. The platform never lowers a cell,
never rises above 5 m, and never makes a coast. Seabed features are
measured on the platformed seabed, so channels carve basins into it.

The terrace pass steps the seabed at the contour levels themselves:
treads sit halfway between neighbouring levels and risers on the levels,
so every shaded plate edge, and the contour drawn on it, falls on a
riser. A riser is 12 map units wide, three cells of the grid, at most 45%
of a narrow span and at least 6% of a broad one. Water shallower than
5 m or deeper than 3,000 m is untouched. The preview never cuts an edge
from the stepped field's own values: a tread is all but level, so a
threshold just off it follows the 4-unit cells and draws a stair. Plates,
contours and the water's depth step are read from the step coordinate
instead (see Light).
Beyond the platform the detail pass raises sparse abyssal hills on a plain
settled just below 2,000 m, streaks gullies down the escarpment along
each slope's downhill line, and spreads sediment fans at its foot.

## Coasts and lagoons

The surveyed coasts are density contours of the files: smooth blobs, with
the odd pool inside and specks of islet beside them. The preview cleans
and sculpts them on a 2-unit raster of each island before the world field
is built. Enclosed water under 400 square map units is filled. An islet
is a piece under 900 square map units, its cells joined edge to edge, so
an islet touching larger land only corner to corner is still an islet.
Across at most 4 map units of water it joins the nearest larger piece of
its island by a broad sand saddle: its waist 90% of the islet's radius
across each side, half as wide again at either shore, and blended into
both shores over 8 map units so its flanks curve in, a tombolo rather
than a thread. Across wider water it stays a cay. Every islet is grown to
a disc of at least a 7-unit radius, set back from the nearest other land
so it stays round, and round it the coast moves out by at most 2 map
units, so a cay never trails a tail. Between a cay and the nearest other
land at least 60% of the surveyed water, and never under 3 map units,
is kept open, its shores rounded where it trims them, so the coast's
movement never draws them into a thin neck. Within 16 map units of water
a submerged sand bank runs from the cay to the larger land: a seabed
feature raising the floor toward a crest 3.5 m down (the seabed's
ceiling holds it at about 3 m), 10 map units across at its waist and
broader at either shore. Then seeded noise, per island, moves the coast:
warped fBm for bays and headlands, a finer field biting rounded coves, and
ridged noise drawing the odd spit, rare and only a few map units long.
The coast moves out by at most 6 map units and in by at most 4, or 30% of
a small piece's depth, and never within 3 map units of a file, so no file
is drowned. No island grows
within 14 map units of another's surveyed coast, so islands never merge
and no coast crosses toward another frame. The field is traced back into
polygons in the surveyed coasts' own shape, island-local map units, so
the world grid and the fine lattice rasterise the same coasts. The coasts
and banks are built once per content of the islands and settings and
reused, so the chart reads the banks and the world terrain the coasts
from one build. On the
world grid the signed distance is measured again from them, by the
structural terrain's half-cell convention, so `inland` is a real
distance; water opened where the surveyed coast held land takes a floor
from 1 m at the new coast to the apron's 5 m eight map units out. Every
landform sample carries its piece depth, the deepest inland of the piece
of land it stands on, so an islet is not shaped as its island's summit.

An atoll's lagoon lies inside its coast, past the rim its landform
raises: from 70% of the way down the rim's fall inland, its shore
wandering a few map units either way. Its floor is 1.5 m deep past a
7-unit bank and reaches 8 m by 60% of the way to the deepest point, with
a metre of seeded relief, and a few patch reefs rise to 0.6 m. The rim
meets the water through an inner beach: a lip up to the beach bench, 4
map units of level sand, then a gentle climb to the rim. One inlet, or
two through a lagoon of 9,000 square map units or more, takes the bearing
from the lagoon's deepest point whose coast opens on the clearest water,
away from other islands, at the least cost of rim to cut. It is 14 map
units across at its throat, half as wide again at its mouth, meandering,
its banks widening by up to 30% here and there so neither runs straight. Its floor runs from the lagoon's depth to 6 m
where it crosses the coast, then fades into the seabed over 36 map units
past it, cutting the apron only where the apron is shallower. The
lagoon's and the inlet's cells inside the coast keep a negative signed
distance and their atoll as owner, so the terrace and detail passes,
which touch sea cells only, leave them as carved.

## Outer hull

Each frame's islands are enclosed by one smooth, simplified outline: the
coast distance blurred broadly, cut at the lowest level that keeps every
coast `padding` inside it and joins every island into one loop, then
simplified and rounded. It is much smoother than the platform, nearly
convex. Beyond it the open sea carries rings, offset curves of the hull
that widen outward as the old open-sea steps did (60 map units, then 20
more each ring), rounding as they go so far rings carry no creases. A
gradient runs from 0 at the hull to 1 at the sea's edge and reshapes the
depth the water's optics read, stepping at each ring: on and inside the
hull, water past 500 m keeps only 30% of its depth beyond that, so the sea
round the islands reads lighter than at the edge yet darker than any
shelf, and outward the compression lifts and 1,200 m more darken the edge.
The seabed's own plates and contours keep their depth. Where two frames'
fields meet, the nearer hull wins and the rings stay continuous.

The world grid is smaller than the sea: the preview's lattice carries the
seabed from the grid's edge to the sea's on one ring of long quads, each
drawing its edge cell's values some 2,000 map units outward. The
abyssal hills there would streak along those quads, so past the grid the
material reads a level open abyss instead, blended in over 64 map units
inside the grid's edge. The distance to the sea's edge that the gradient
reads is a smooth minimum over the four edges, so the gradient carries
no crease along the diagonals in from the corners.

The preview no longer draws the rings: they only step the water's
darkening. The Wireframe layer, a developer's layer that is off in every
preset and reached from the layer list, draws them as a transparent sheet
at the water level over the same emanation field. On the CPU,
`hullRings` traces each ring as a polyline in map units, the level set of
the field's ring coordinate at each integer, with its index and its
`ringOffset`. A ring can come in several pieces, and the sea's edge leaves
open pieces where it cuts a ring. `chartHull(...).rings()` traces them once
per hull and returns the same array after that.

### Ring waves

The rings carry swells. A wave is a short arc of one ring, from ring 1 out
to ring 10. It travels inward to the next ring over about 22 seconds,
building, folding and breaking on the way. It then rests unseen for half
a crossing and starts again from its ring. Each wave has its own stagger
and a tempo within 18% of the mean, so they come and go one at a time;
the seeded hash ends in a full avalanche, so neighbours on one ring never
share a stagger and pulse together. The rings themselves are never drawn.
The waves show only with the geology preview, so the default chart never
builds them.

`ringWaves` chooses them once on the CPU. It cuts each ring into stretches
of about 4 ring gaps, starting from a seeded origin. Each stretch takes
its most convex point, a headland of the ring, weighed against seeded
noise. A crest spans two ring gaps of arc, between 80 and 420 map units.
Each of its 17 points is carried down the ring coordinate's steepest
descent to the ring inside. It refuses a site if a point wanders too far
on the way, or if the crest folds or fans out, as it would across the
crease where two frames' fields meet. The same field and seed give the
same waves.

A wave's life, as shares of its crossing (`life` in the settings):

1. **Swell.** It fades in by 0.12. It is a band of water, not a line:
   0.15 of the ring gap either side of the crest in map units, never under
   3 px, and held to 0.17 of the shown arc's half length. A gentle lift
   sits behind the crest, a steeper face ahead, and a darker trough
   further behind, so it reads as water pushed forward. The band narrows
   by 30% as it builds.
2. **Bow.** The crest's ends lag its apex, by up to 0.4 of the gap and
   0.26 of the shown half length, so it bows forward into a soft crescent
   that deepens over the crossing. The ends lag rather than the apex
   leading, so every point stays on open sea.
3. **Build-up light.** Light comes through the steepening face: a
   turquoise glow (`#4fe8d6`) ahead of the crest, added to the water,
   never covering it. It peaks at 0.46, just before the fold, and turns
   most of the lifted band to light as it does.
4. **Fold.** The lip pitches forward into a bright near-white line, about
   1.4 px, brightest at 0.62. It starts at the apex and peels out to the
   ends 0.12 of a crossing later.
5. **Crash.** By 0.78 the lip is whitewater: a bright broken front that
   runs forward and widens, with softer foam left behind it, broken by
   gradient noise along the crest. The glow is gone. The foam dissolves
   into patches and fades to nothing on the inner ring.

`ringWaveLife`, `ringWaveBow` and `ringWaveLocalPhase` give each phase's
channels, the bow along the crest, and the peel; the shader computes the
same.

The scene draws all the waves as one ribbon mesh, just over the water and
the wireframe's rings. Each crest is drawn on a Catmull-Rom curve
through its samples, 4 points per span, so the bow stays
smooth at close range, where only a few samples show. Each vertex holds
its point at both ends of the crossing, the crest's direction there, and
the wave's stagger and tempo. The shader moves and bows the crest and
inks the band in premultiplied light: the glow adds, the trough darkens,
the lip and the foam cover. On screen the arc shown is held to 320 px. A
wave fades in as the gap it crosses opens from 60 to 200 px, so at the
overview only a few outer waves show, faintly. A resting wave folds to no
width and draws no pixel. Per frame the CPU writes two uniforms, the
scale and the camera's squash; the time is the scene clock's. Under
reduced motion the clock holds, and the waves hold with it. The tunables
are `defaultRingWaveSettings`; the band, bow, life, look and timing are
uniforms.

## Light

The preview lights the seabed before the water sees it, so depth
attenuates relief: a warm key from the scene's sun in the northwest with
a wrapped response, a cool sky ambient, baked cavity occlusion over three
radii, and a baked horizon toward the sun for self-shadow. Light is
normalised on level open ground, so level sand keeps the albedo the water
is calibrated over. Seabed slopes are exaggerated for light alone, more
than land's, since real seabed slopes barely tilt a normal, and the
seabed's rise is doubled again for the horizon, so a riser turned from
the sun casts its shadow past its foot onto the tread below.

The plates read as cut paper. Their parts are read on screen from the
step coordinate, a 32-bit texture over the world grid: each level's line
is traced through the stepped field by marching squares, on the steep
middle of its riser where the trace is sure, and each cell takes the
share of the way across its span from its lower line to its upper one,
by distance. The coordinate is an integer on every riser's middle and
smooth everywhere, so edges cut from it stay smooth at any zoom. Around
each integer lies the riser, the share of its span the terrace pass gave
it, darker turned from the sun and lighter facing it, by the baked
downhill direction. No pale lip is drawn on the tread's edge: the step
reads from its light alone (the lip's strength is 0, kept as a setting). A tread
keeps its light, and spans the terrace pass left unstepped draw no plate.
The plate term multiplies the lit seabed before the optics, so the water
fades it with depth; it grows to twice its swing between 100 and 500 m,
which keeps the escarpment's first steps legible through the slope's
water. The vertices are too coarse for a riser, so the light reads the
seabed's slope softened over a cell either side, and on the shelf the
riser's step in the water's depth is redrawn per pixel from the step
coordinate, the rest of the seabed's relief kept from the vertices. The
redraw eases out by 110 m, where the detail pass roughens the seabed
after the terrace pass. Albedo moves from
sand to sediment with depth and into hollows, and to rock on steep risers
and lips below the shoreline.

Land reads as cut paper too. The light flattens a tread's slope and
steepens an escarpment's from the crisp edge where it begins, so the
shading steps at the escarpment's edge rather than rolling over it, and
a soft fill lifts land's shade a share of the way back to level ground,
so a face turned from the sun stays a readable pastel. The seabed takes
no fill.

## Formations

Each island's formation comes from what is measured about its package,
in this order; the first that holds wins:

1. **Seamount:** ten files or fewer. The package barely breaks the surface.
2. **Cluster:** three coast pieces or more. Knolls sit on the hub files.
3. **Ridge:** a principal-axis ratio of 1.6 or more. A crest runs the axis.
4. **Atoll:** three hubs or more, set out toward the rim. The middle is low.
5. **Volcanic:** a hub whose fan-in is at least 1.8 times the next. A cone
   with a crater lip stands near it.
6. **Plateau:** anything else. A broad top with escarpment edges.

A hub is a high fan-in file. A landform is 0 at the coast and never above
full land. An atoll's rim falls inward to the beach bench, so where the
coast carves the lagoon below the water, a margin of pale sand meets it.

Every formation is built on the same island anatomy, from the coast in:

- **Beach:** a flat bench up to 4 map units deep at 0.04 of full land. Its
  seaward face rises over the first 40% of that; the rest is level sand.
  On a small piece of land the bench is at most 28% of the piece's depth,
  so a cay or islet keeps pastel land behind its sand. An islet's land
  rises only as far as its own depth carries it, so it stands one step
  or none: a knoll, not a copy of the island. A piece less than 12 map
  units deep is sculpted less, so a speck of land stays a low cay.
- **Terraces:** one to three steps. Each opens with an escarpment at least
  3 map units wide, then holds a tread that climbs gently. Fewer, taller
  steps keep the treads wide enough to read at the overview zoom.
- **Summit:** a plateau from the formation's reach inland. A volcano's
  cone, an atoll's rim, a ridge's crest and a cluster's knolls cap how
  far up the steps any point climbs.

The steps are cut from a sculpted relief, not from the distance inland
alone, so no escarpment is a copy of the coast. Seeded by the island's
id, the inland distance swells and narrows by up to 70% of itself in
broad lobes about 40 map units across, so a tread is wide on one side of
an island and pinches out on another, and every escarpment wanders by up
to 6 map units, so it runs out in spurs and back in re-entrants. Where
the beach is pushed in, a wide strand opens; where the first escarpment
is pushed out, it stands almost at the waterline. All of this happens
before the steps, so treads stay level and escarpments stay crisp.

Valleys then cut the relief toward the sea. Each runs from a head on the
high ground down past the coast, deepening and widening over its upper
reach, a V in section, and meandering by a few map units. It takes a
share of the relief away, so the escarpments bend upstream where it
crosses them and its floor steps down the terraces. Bays in the coast,
measured as the coast's furthest reaches in from its convex hull, draw
the first valleys, so ravines open into the bays. Only a few valleys cut
each island, so they stay readable at the overview zoom.

Each formation shapes its relief in its own way:

- **Plateau:** a broad top broken into mesas where the summit falls one
  terrace, cut by three trunk valleys from the middle, one toward each
  bay first, each joined halfway down by a tributary.
- **Ridge:** a crest along the principal axis, broad on top and steep on
  its flanks. It wanders from side to side, throws out spurs down each
  flank in turn, dips through saddles and tapers at both ends; gullies
  run down both flanks.
- **Volcanic:** a lobed cone with a crater lip and a parasitic cone down
  one end of the principal axis. Six barrancos radiate from below the
  summit's tread to the sea, each opening and cutting its own way.
- **Atoll:** a single step of rim, broken into motus: islets where a
  noise field of islet-sized blobs stands high, joined by saddles of sand.
- **Cluster:** knolls on the hubs, lobed, over a low base; where knolls
  meet, the ground between them is a saddle. Two valleys run toward the
  largest bays.
- **Seamount:** a single low knoll.

In the geology preview, the land is cut per pixel, finer than the height
grid, and reads only elevation, slope and position, never how many
terraces an island has. Sand covers the bench and the first escarpment's
foot, ending crisply on a level line just over the bench, and darkens to
wet sand toward the waterline; a lagoon's shore is sand the same way, and
its water goes through the optics. Escarpments begin at a crisp edge on
the slope and go toward a pale sandstone, laid in soft beds at fixed
elevations, the pale beds slightly rose. Treads take the island's
pigment, deepened away from the chart's paper wash into a pastel, richer
in hollows, paler on exposed ground, warmer facing the sun and cooler
turned from it. A fine relief tilts the normal for light alone: rills
running downslope and rock grain on escarpments, a gentle swell on
treads. Each layer fades before it is a few pixels across, so nothing
shimmers as the camera draws back. Land contours fall every 25 nominal
metres: a tread's climb carries a line or two up close, and they fade
out on escarpments by slope.

## Seafloor features

Two islands are neighbours where their nearest-island regions touch.
Ridge saddles sit at 30–55 m, over the platform's basins; channel floors
at 250–400 m at the narrows, under them; trench floors at 2,650–3,350 m;
seamount crests at 175 m. Every line feature meanders by seeded noise,
its ends held.

- **Ridge:** related neighbours, by a route of weight 8 or more or a shared
  shelf group. The crest follows the shallowest crossing, rises toward
  each island and undulates along its length: a spine on broad shoulders
  that lift the basin either side, so the two banks merge along it.
- **Channel:** unrelated neighbours in one archipelago. A sinuous trough
  along the midline between the coasts, deepest at the narrows, shoaling
  to half that depth toward its ends and widening and narrowing as it
  runs. It carves only where the seabed is shallower than its floor.
- **Seamount:** a former package, a drowned island, under its wreck: a
  flat-topped guyot on broad, lobed flanks that cross every deeper level,
  so the terrace pass steps them. On a seabed shallower than its crest it
  still rises `rise` above it.
- **Canyon:** up to four, cut down the platform's rim. Each heads on the
  rim's lip at least 70 map units from any coast, ranked by how near an
  island stands to the edge, cuts back up into the platform and follows
  the escarpment's fall to its foot, its floor 0.09 in elevation below
  the slope it cuts, fading out on the lower slope. A basin's edge inside the platform heads nothing,
  because its trace never reaches the foot.
- **Spur:** up to three ribs raised down the same fall, headed by seeded
  chance. Every head, canyon or spur, stands at least 150 map units from
  the others, so the escarpment keeps its benches between them.
- **Sea stack:** a package's own runtime dependency, one no other package
  reaches. It stands on the package's shelf ring, 3.5 to 8 map units
  across and up to 150 nominal metres above the water, taller, broader and
  nearer the coast the more of its files import it; the most relied upon
  break the surface.
- **Trench:** the midline between two workspace frames.

A feature blends the seabed toward its own crest or floor and never adds
a fixed bump, so overlapping features do not stack past their targets.
Summing every contribution is exact; isolating one that overlaps another
is approximate.

## Water

Water colour is Beer–Lambert transmittance over the seabed plus in-scatter,
on a compressed optical depth: true metres in the first fifteen, then
close to a logarithm of depth, so the shallows are clear, the shelf still
shows the seabed, the slope shows a little, and deep water none.
`seabedVisibility` fades seabed detail by the same law. Red is absorbed six times faster than green and blue, so
pale sand reads as clear Caribbean water: pale turquoise over the sand in
the first metres, vivid aqua by 20 m, saturated teal on the shelf. From
440 m down a twilight term fades the water toward navy over 700 m; one
scatter colour cannot tell 500, 1,000 and 2,000 m apart, so the term is a
chart convention, not optics. Over the palette's sand the stops are:

| Depth | Colour |
| --- | --- |
| 2.5 m | `#a8dfd2` |
| 5 m | `#7ad6ce` |
| 20 m | `#27b6be` |
| 100 m | `#1e89a9` |
| 500 m | `#1d6f9b` |
| 1,000 m | `#18547b` |
| 2,000 m | `#14395d` |

Transmittance can only dim the seabed, never brighten it, so the
shallows are only as luminous as the sand beneath them. The waterline is
read through 1.5 m of water, so a pale halo rings each island before the
aqua. The scatter keeps green above red at every depth, so deep water
reads ultramarine rather than violet.

No contour lines are drawn, over the water or on the land: the plates'
steps and the terraces carry the levels as relief, not as ink. The
bathymetric and land contours remain as settings at strength 0, should a
line ever be wanted on purpose. Past the depth the water
hides the seabed at, a faint hillshade of its relief lightens slopes
facing the sun and darkens those turned from it by up to 18%, as far as
the optics hide the seabed, so seamounts, canyons and the escarpment read
in the twilight while level deep water keeps its ultramarine.
