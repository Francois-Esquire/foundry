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
| `noise.ts` | Deterministic value and gradient noise, fBm, ridged fBm and domain warp, from an integer hash a shader can mirror. |
| `landforms.ts` | Island anatomy (beach lip, terraces, escarpments, summit plateau) and six formations. |
| `seafloor-features.ts` | Ridges, channels, seamounts and trenches, each named and kept as its own seabed contribution. |
| `contours.ts`, `scene/contour-lines.ts` | Contour levels by depth band, a baked contour coordinate with every level on an integer, and an anti-aliased line node. |
| `sea-stacks.ts`, `scene/sea-stacks-mesh.ts` | Sea stacks off a coast, one for each runtime third-party dependency only that package relies on. They are instances over the world field, never seabed contributions. |
| `layout/water-optics.ts`, `scene/water-optics.ts` | Depth-based absorption and in-scatter over the seabed, calibrated to the legend, as a CPU model and its TSL port. |

## Platform and terraces

Every package in a workspace shares the workspace, so a frame's islands
stand on one platform. Its extent is the frame's distance to the nearest
coast, blurred so near islands join without a waist, out to `reach`. Its
depth follows the rim, not the islands: about 30 m in the interior,
deepening to 85 m at the rim, then three benches down to the abyss. Each
island keeps an apron from 5 to 18 m over 30 map units. Frames never join.
Shelves and basements stand on the platform rather than the abyss: a
cell's share of the structural column is filled again between the
platform floor and the apron's edge. The platform never lowers a cell,
never rises above 5 m, and never makes a coast. Seabed features are
measured on the platformed seabed, so channels carve basins into it.

The terrace pass steps the seabed at the contour levels themselves:
treads sit halfway between neighbouring levels and risers on the levels,
so every contour line and every shaded plate edge falls on a riser. Water
shallower than 5 m or deeper than 3,000 m is untouched, and steps fade
where a tread would be narrower than 16 map units.

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
full land, so an atoll's lagoon is low land, not water.

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
  reaches. It stands on the package's shelf ring, taller, broader and
  nearer the coast the more of its files import it; the most relied upon
  break the surface.
- **Trench:** the midline between two workspace frames.

A feature blends the seabed toward its own crest or floor and never adds
a fixed bump, so overlapping features do not stack past their targets.
Summing every contribution is exact; isolating one that overlaps another
is approximate.

## Water

Water colour is Beer–Lambert transmittance over the seabed plus in-scatter,
on a compressed optical depth: true metres in the first ten, then a power
of depth, so the shallows are clear, the shelf still shows the seabed and
its contours, the slope shows a little, and deep water none.
`seabedVisibility` fades contour lines and seabed detail by the same law.
From 400 m down a twilight term fades the water toward navy over 800 m;
one scatter colour cannot tell 500, 1,000 and 2,000 m apart, so the term
is a chart convention, not optics. The scatter keeps green above red at
every depth, so deep water reads ultramarine rather than violet.
