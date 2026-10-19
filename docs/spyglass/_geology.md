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

## Primitives

| Module | What it gives |
| --- | --- |
| `world-terrain.ts` | The world field, composed in order: the structural sea, the archipelago platform, seabed contributions, a terrace pass and a seeded detail pass; land cells from a landform, and the owning island of every land cell. Coasts are the islands' own: no cell changes sign. |
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
ridged fBm for spurs reaching toward neighbours. The interior sits about
26 m down and deepens by up to 44 m into basins away from the coasts;
round every island an apron of 5–16 m banks varies in reach and edge, and
blends into the platform with a smooth maximum, so no island wears a ring
at a constant offset. The rim steps down through benches at 175, 375, 875
and 1,750 m, the middles of contour spans, to a flat foot at the abyss.
Frames never join, and no apron stands past the bisector between frames.
Shelves and basements stand on the platform rather than the abyss: a
cell's share of the structural column is filled again between the
platform floor and the apron's edge. The platform never lowers a cell,
never rises above 5 m, and never makes a coast. Seabed features are
measured on the platformed seabed, so channels carve basins into it.

The terrace pass steps the seabed at the contour levels themselves:
treads sit halfway between neighbouring levels and risers on the levels,
so every contour line and every shaded plate edge falls on a riser. A
riser is 12 map units wide, three cells of the grid so its edges follow
the seabed rather than the cells, at most 45% of a narrow span and at
least 6% of a broad one. Water shallower than 5 m or deeper than 3,000 m
is untouched.
Beyond the platform the detail pass raises sparse abyssal hills on a plain
settled just below 2,000 m, streaks gullies down the escarpment along
each slope's downhill line, and spreads sediment fans at its foot.

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

The preview no longer draws the rings: they only step the water's
darkening. The Wireframe layer, a developer's layer that is off in every
preset and reached from the layer list, draws them as a transparent sheet
at the water level over the same emanation field. On the CPU,
`hullRings` traces each ring as a polyline in map units, the level set of
the field's ring coordinate at each integer, with its index and its
`ringOffset`. A ring can come in several pieces, and the sea's edge leaves
open pieces where it cuts a ring. `chartHull(...).rings()` traces them once
per hull and returns the same array after that.

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

The plates read as cut paper. Each tread sits on a half-integer of the
contour coordinate, filtered from the world field, so the plate's parts
are read from it on screen: a pale lip just below the tread, ending
crisply at least a pixel and a half down the riser, then the riser,
darker turned from the sun and lighter facing it. A tread keeps its
light. The plate term multiplies the lit seabed before the optics, so
the water fades it with depth; it grows to twice its swing between 100
and 500 m, which keeps the escarpment's first steps legible through
the slope's water. Past about 500 m the water leaves too little of the
seabed for any relief to show. Albedo moves from sand to sediment with
depth and into hollows, and to rock on steep risers and lips below the
shoreline.

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
full land, so an atoll's lagoon is low land, not water: it sits at the
beach bench and reads as a flat of pale sand inside the rim.

Every formation is built on the same island anatomy, from the coast in:

- **Beach:** a flat bench 4 map units deep at 0.04 of full land. Its
  seaward face rises over the first 40% of that; the rest is level sand.
- **Terraces:** two or three steps. Each opens with an escarpment at least
  3 map units wide, then holds a tread that climbs gently. Fewer, taller
  steps keep the treads wide enough to read at the overview zoom.
- **Summit:** a plateau from the formation's reach inland. A volcano's
  cone, an atoll's rim, a ridge's crest and a cluster's knolls cap how
  far up the steps any point climbs.

In the geology preview, sand covers the bench and the escarpments' feet.
Escarpments go toward a pale sandstone, which the sun from the northwest
lights on the near faces and leaves in shade on the far ones. Treads take
the island's pigment, deepened away from the chart's paper wash into a
pastel. Land contours fall every 25 nominal metres: a tread's climb
carries a line or two up close, and on a riser the levels crowd and fade.

## Seafloor features

Two islands are neighbours where their nearest-island regions touch.
Ridge crests sit at 300–650 m, channel floors at 1,050–1,700 m, trench
floors at 2,650–3,350 m and seamount crests at 600 m.

- **Ridge:** related neighbours, by a route of weight 8 or more or a shared
  shelf group. The crest follows the shallowest crossing and stays in the
  slope band, well under the shelves.
- **Channel:** unrelated neighbours in one archipelago. The trough follows
  the midline between the coasts. A channel shows only where shelves or
  basements would otherwise join the two seabeds.
- **Seamount:** a former package, a drowned island, under its wreck. On a
  seabed shallower than its crest it still rises `rise` above it.
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
shows the seabed and its contours, the slope shows a little, and deep
water none. `seabedVisibility` fades contour lines and seabed detail by
the same law. Red is absorbed six times faster than green and blue, so
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
