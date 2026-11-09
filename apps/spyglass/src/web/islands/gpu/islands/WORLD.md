# Islands: the world's layers

The islands' tops are built as a stack of layers. Each layer owns its
part of the land and renders it itself. Nothing is painted over another
layer: the terrain leaves the ground that roads, lots and buildings
reserve, and those layers draw their own surfaces there. The rules for
what goes where are in [TOWNS.md](TOWNS.md); the look we judge against is
in [REFERENCES.md](REFERENCES.md) ("The goal").

Everything a layer needs from the chart is worked out when the chart
changes and kept: on the CPU as a plan, on the GPU as baked maps and
packed instance buffers. The frame samples and draws. No layer lays out,
searches or scatters per frame (AGENTS.md).

## The stack

| Layer | Made when | Kept as | Drawn by |
| --- | --- | --- | --- |
| 0. Landform | the chart or land parameters change | height, coverage, light maps (maps.ts) | terrain.wgsl |
| 1. Plan | the chart changes | `WorldPlan` (world.ts), CPU arrays | nothing: every other layer reads it |
| 2. Zoning | the plan or the map frame changes | the `zoning` map (rgba8, map resolution) | nothing: terrain and foliage read it |
| 3. Surfaces | the plan changes | packed road ribbons and ground pads | world-surfaces.ts |
| 4. Structures | the plan changes | packed instanced parts (buildings, walls, hedges, poles, wires) | town-draw.ts and its kit |
| 5. Foliage | the plan, zoning or height changes | an instance buffer filled by one compute pass | world-foliage.ts |
| 6. Life | later | flags and small instance buffers (parked cars, lit windows, laundry, people) | later |

Each layer depends only on the layers above it in the table. A change
rebuilds the layer it touches and the ones below it, nothing else.

## 1. Plan

`planWorld(chart): WorldPlan` (world-plan.ts) is the only place that
decides where things go. It grows each island's town the way Emilien et
al. grow villages (REFERENCES.md section 2): a centre seeded from the
package root, streets grown from their parent street as paths with a
gentle wind, loops where they fit, parcels claimed along the road
frontage first, then corners, then away from the road. Files are
households, folders are streets, imports pull neighbours together
(TOWNS.md). It returns everything the other layers need: roads, parcels,
buildings, zones, planned trees, poles and the shore row. The plan is
deterministic and stable: a changed file moves only its own
neighbourhood.

## 2. Zoning

One rgba8unorm map at the maps' resolution, baked from the plan by one
instanced draw pass (roads, parcels and zones as soft-edged shapes):

| Channel | Holds | Read by |
| --- | --- | --- |
| r | reserved: 1 where a road, parcel, plaza, pitch or building owns the ground, easing to 0 over about one unit | terrain: grass, soil band, sheen and wind stop there |
| g | tree density, 0 to 1 (groves, coastal pines, gardens, field edges) | foliage scatter |
| b | shrub and garden density, 0 to 1 | foliage scatter |
| a | open ground: 1 on meadow and field, 0 on built land; how far the town has let the island stay wild | foliage scatter, later grass height |

The map is coarse (about 0.85 units a texel on Foundry), so it carries
only soft fields. Anything with a crisp edge (a road's white line, a
kerb, a parcel's wall) is drawn by its own layer as geometry.

## 3. Surfaces

Roads are ribbons of real geometry along each road's centreline,
draped on the baked height, with the asphalt, the white edge lines and
the centre line drawn in the fragment from the ribbon's own coordinates,
so they are sharp at every distance. Parcels, plazas, pitches and
fields are draped pads with their own materials. One or two instanced
draws in all, built once per plan.

## 4. Structures

The part kit (town-parts.ts) and its draw (town-draw.ts): buildings on
their parcels, boundary walls and hedges, utility poles with sagging
wires. Five or six draws whatever the town's size. Ground shadows stay,
because the light map is baked without the town.

## 5. Foliage

One compute pass, run only when the plan, zoning or height changes,
scatters trees and shrubs on a jittered grid from the zoning densities,
keeps them off reserved ground, and appends them to one instance buffer
drawn indirectly. Trees the plan names (street trees, the shrine grove,
the coastal pines) are appended from the plan. Shapes are low-poly
trunks under soft crown clusters (Tiny Glade), lit by the light map.

## 6. Life

Not built yet. The plan already says where it goes: parcels have
parking, buildings have windows, roads have lanes. Life adds instance
buffers and flags, never layout.

## Frame budget

On Foundry: terrain, water and post as today; surfaces 1 to 2 draws;
structures 5 to 6; foliage 1 indirect draw; their shadows 1. Under
twenty draws for the whole archipelago, and no per-frame CPU work that
grows with the number of files.
