# Islands: the plan

What is built is in the [README](README.md). This file holds what comes
next and why the experiment is shaped the way it is.

## The rules

- **The data is static.** A chart is loaded and previewed, never authored
  here. Every source reaches a `Chart` (`src/data/chart.ts`) through an
  adapter.
- **The maps are the rendition.** The chart is baked into textures the
  frame only samples. Shaping costs bake time, never frame time: the frame
  holds 120 fps.
- **3D.** A displaced mesh, a free camera, real depth, water with real
  thickness.
- **Islands are shaped by their coast and their groups.** Nothing else
  feeds the picture yet: no hills, shallows, foundations or routes.
- **Organic, not clean.** Where stacks meet they may overlap roughly. What
  must hold is each stack's order and its depths.
- **Parameters, not constants.** A value that tunes the look is a
  parameter in `sea-params.ts` or `map-params.ts`, with a debug view where
  a map holds it.

## Next

In order.

1. **Rocky coasts, the rest.** Drop-offs already fall clean, wear the
   wash, and their rims are cliff rock. Left: the rock face itself, its
   colour varied and its strata, read from the paint map's alpha (1 a
   drop-off, 0 a beach).
2. **The in-between coasts.** Most islands are all beach or all drop-off.
   A few are mixed (on Foundry: sandbox 0.9; modules, workspaces and
   artifacts about 0.5). Each kind should get its own look: a beach broken
   by rock, or a sand apron under a low cliff.
3. **Round islets.** Foundry's coasts are polygons with few corners on a
   small island, and the distance map follows them, so a small islet
   stands as a faceted stack. Rounding the coast at bake time (a spline
   through the polygon, or easing the coast's own distance by the island's
   size) makes it a smooth cut. Bake time only.
4. **The flow map, used.** Of its four channels the frame reads only
   breaking; the transport and the sediment feed only its debug view.
   - **Sediment on the floor:** the floor layer tints the shoal by the
     sediment, lighter sand where the surf stirs it.
   - **The swell refracted on the water:** the surface turns its crests by
     the transport's heading, so the waves agree with where they break.
5. **Placements and corrections.** Each island's stack is already
   per-island values in the height kernel: its top silhouette, its bottom
   silhouette and its tread. Corrections need an input to hook into those:
   a per-island offset, stretch and turn of either silhouette; a joint
   between two neighbours' stacks that aligns them; and a pin that holds a
   ring's edge where art direction puts it. The input is data on the
   island (`BankIsland`), never code per island.

## Data on the chart

Selection is in (README, Selection): a click chooses an island or a ring,
and the readouts name it from the chart. The way data reaches the
picture follows from how that works:

- **The entities stay blind.** The maps and shaders know an island as an
  index and a ring as a bank's index, nothing more. Meaning is attached
  by id on the CPU side (`selection.ts` reads it from the chart), so any
  data keyed by an island's id, a group's id or a foundation's id can
  ride on them without a map changing.
- **A ring is a group is a set of shared dependencies.** Every island on
  a ring shares its group's foundations; the ring's name is theirs. So
  data about a dependency (its version spread, size, licence, CVEs, how
  many import it) attributes to its ring, and data about a package to
  its island, with no new geometry.
- **Attributes beside the chart.** A flat record per entity id, loaded
  with the chart through the same adapters and as static as it, never
  folded into `Chart` itself (the chart describes the workspace, not the
  data laid over it).
- **Shown through buffers, not maps.** A value per island or per bank
  goes to the GPU as a small buffer indexed like the selection's ids
  (the rings map already says which bank each texel stands on), so a
  ring or an island can be tinted, outlined or badged by a value without
  a rebuild.
- **Readouts first, then a panel.** What is chosen lists its attributes;
  later, a legend for whichever attribute colours the chart.

## The water's cost

The water composite is the frame's largest pass. Without touching its
look:

1. **Per-term bench toggles,** so each layer's cost is measured.
2. **Wave LOD:** fewer of the 32 waves where they can't be resolved.
3. **Bake the static floor terms** (lip lines, the floor's relief) into a
   map instead of reading the light map round each pixel.
4. **A sea-plane mask,** so pixels of land and sky skip the composite.
5. **Half-resolution water,** upsampled, if the above aren't enough.

## The detail pass, the rest

Each fades before it aliases, stays off the open sea's calm, and is a
parameter that can go to 0.

1. **Glitter.** Sparkles on the sun's path: single facets catching the
   sun, crisp up close and a soft shimmer far off, where the glint's lobe
   already widens.
2. **Whitecaps.** A few, short-lived, where the wind is strongest.

Then **the land's relief:** ridges and valleys on the caps and layered
rock in the cliffs, as Spyglass's islands have, instead of flat pastel
plates.

## The environment

Its own pass: the sea's life. A baked habitat map (reef, seagrass, the
fish's water, the shore's life) with its own debug view; the whole
archipelago as one sparse reef down to the platform, in scattered
patches, not a fringe on every coast; coral, seagrass and starfish as
instances; seaweed (kelp swaying in the deeper water); and a little
wildlife (schools of fish, reef fish, rays and turtles, crabs, birds),
moved by time alone. Every layer has its own density, kept low by default.
A first attempt is in the stash named `1`: a creature behind the eye must
be skipped, never sized up to stay visible.

## Parked

Each was considered and set aside until the items above are seen.

- **Satellite islets and the atmosphere.** Spyglass's little round rocks
  round the big islands, its clouds and its graticule: not wanted here.
- **Floor relief on the deep.** A little ridged relief on the open deep
  past the platform, so the deep is not one flat blue. (The levels and the
  platform already undulate.)
- **Carving the base.** Basins and crevices where the platform lies far
  from every stack.
- **Spread per island.** An anisotropic distance per island, so stacks
  lean and stretch instead of ringing their hull. Overlaps with
  corrections (Next, 5).
- **The sun in the sky.** A disc and glow where the glint points.
- **The floor out of the terrain pass.** The water's thickness from the
  height map instead of the film's depth.
- **Mesh or march.** A full-screen heightfield march in place of the
  clipmap. The test: the bench at 2560×1600 and 5120×3200 against the
  mesh. The maps don't change either way.

## Later

Not planned in detail:

- **Land:** hills and shallows as height terms, strata and per-stratum
  hardness, curvature and exposure maps, vegetation.
- **Relationships:** foundations as plates from their lobes, suppliers as
  basements, routes that land on the coast.
- **Finish:** paper and brush in texture space.
- **Reading the chart:** names placed from the distance and islands maps,
  a legend, a scale, a compass, a grid.
- **Infrastructure:** a preview resolution while a slider drags, render
  scale under motion, adapters for other sources and dropped files.

## The chart's names

The chart was shaped as a typed copy of Foundry's data. It should be named
for what the picture draws. Each field gets its map name when its layer is
designed:

- `groups` become `banks`: the islands that share dependencies, in the
  order the rings stack in.
- A map reads a chart field as one flat list, not a record it must
  interpret.

## Open decisions

- Whether paint gets its own, finer resolution once the brush lives in it.
- The placeholder colour rule: by island order, or by a hash of the id.
- The mesh-versus-march criterion, when the spike comes.
