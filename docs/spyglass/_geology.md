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
| Shallows | 5–50 m | −0.03 to −0.14 (`shelfTop`) |
| Shelf | 50–200 m | −0.14 to −0.35 |
| Slope | 200–1,000 m | −0.35 to −0.6 (`basementTop`) |
| Deep ocean | 1,000–3,000 m | −0.6 to −1 (abyss) |
| Trenches | 3,000 m+ | −1 to −1.25 |

The mapping is piecewise linear between those knots, so equal steps of
elevation are not equal metres. Land reads as 600 nominal metres at full
height. Every field shares the structural terrain's grid, and
`sampleGrid` reads any of them bilinearly between cell centres.

## Primitives

| Module | What it gives |
| --- | --- |
| `world-terrain.ts` | The world field: sea cells from the structural terrain plus seabed contributions and a seeded detail pass, land cells from a landform, and the owning island of every land cell. Coasts are the islands' own: no cell changes sign. |
| `noise.ts` | Deterministic value and gradient noise, fBm, ridged fBm and domain warp, from an integer hash a shader can mirror. |
| `landforms.ts` | Island anatomy (beach lip, terraces, escarpments, summit plateau) and six formations. |
| `seafloor-features.ts` | Ridges, channels, seamounts and trenches, each named and kept as its own seabed contribution. |
| `contours.ts`, `scene/contour-lines.ts` | Contour levels by depth band, a baked contour coordinate with every level on an integer, and an anti-aliased line node. |
| `layout/water-optics.ts`, `scene/water-optics.ts` | Depth-based absorption and in-scatter over the seabed, calibrated to the legend, as a CPU model and its TSL port. |

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

- **Ridge:** related neighbours, by a route of weight 8 or more or a shared
  shelf group. The crest follows the shallowest crossing and stays in the
  slope band, well under the shelves.
- **Channel:** unrelated neighbours in one archipelago. The trough follows
  the midline between the coasts. A channel shows only where shelves or
  basements would otherwise join the two seabeds.
- **Seamount:** a former package, a drowned island, under its wreck.
- **Trench:** the midline between two workspace frames.

A feature blends the seabed toward its own crest or floor and never adds
a fixed bump, so overlapping features do not stack past their targets.
Summing every contribution is exact; isolating one that overlaps another
is approximate.

## Water

Water colour is Beer–Lambert transmittance over the seabed plus in-scatter,
on a compressed optical depth: true metres in the first twenty, then a
power of depth, so the shallows are clear, the shelf still shows the
seabed and its contours, the slope shows a little, and deep water none.
`seabedVisibility` fades contour lines and seabed detail by the same law.
Below 3,000 m a twilight term darkens the water toward navy; it is a chart
convention, not optics.
