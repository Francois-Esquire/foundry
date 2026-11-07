# Islands: references for the towns

This file collects the references behind the towns described in TOWNS.md
and turns them into rules we can check a render against. It covers the
look we are aiming for, how to lay a town out, how to split the world
into baked layers, foliage and signs of life, crisp roads, and a one-page
goal at the end.

Every link was opened and returned a page when this was written. GDC
Vault pages load for everyone, but their videos need a membership. The
slides linked next to them do not.

One chart unit is about 4 metres. Sizes below are given in both.

## 1. Look target

### Candidates

1. **Tomonoura, Hiroshima (aerial photograph).**
   [Wikimedia Commons photograph](https://commons.wikimedia.org/wiki/File:Tomonoura08bs3200.jpg),
   and [Little White Lies on Tomonoura and Ponyo](https://lwlies.com/articles/tomonoura-ponyo-studio-ghibli/).
   An old fishing port seen from the hill above, at almost exactly our
   camera angle. We take the density of roofs, the share of green against
   built area, how the town thins out along the shore, and the haze over
   the sea.
2. **Manazuru, Kanagawa (street photograph).**
   [Wikimedia Commons photograph](https://commons.wikimedia.org/wiki/File:Manazuru_Kanagawa_street_-_2023_July.jpeg),
   [Manazuru on Wikipedia](https://en.wikipedia.org/wiki/Manazuru,_Kanagawa).
   A modern seaside town street from about one storey up. We take the
   street kit: dark asphalt, a white edge line, the pale green school-route
   strip, concrete block walls, utility poles with sagging wires, low grey
   and green metal roofs, and garden trees spilling over walls.
3. **Ine no Funaya, Kyoto.**
   [Wikimedia Commons photograph](https://commons.wikimedia.org/wiki/File:Funaya_in_Ine_Town,_Yosa_District,_Kyoto_Prefecture_001.jpg),
   [Ine on Wikipedia](https://en.wikipedia.org/wiki/Ine,_Kyoto).
   One row of timber boathouses with their gable ends to the water,
   dark grey roofs, and dense evergreen forest straight behind. We take
   this as the model for isolated files: a single row of small dark
   buildings at the shore, not a town.
4. **Onomichi, Hiroshima.**
   [Onomichi on Wikipedia](https://en.wikipedia.org/wiki/Onomichi,_Hiroshima).
   A hillside town of narrow stepped lanes and temples above a strait.
   Our plateaus are flat, so we take only the temple-in-a-grove and the
   lanes that bend around lots instead of cutting through them.
5. **Townscaper (Oskar Stålberg).**
   [Steam page](https://store.steampowered.com/app/1291340/Townscaper/),
   [how Townscaper works, Game Developer](https://www.gamedeveloper.com/blogs/how-townscaper-works-a-story-four-games-in-the-making),
   [Boris the Brave on the Townscaper grid](https://boristhebrave.com/docs/sylves/1/articles/tutorials/townscaper.html),
   [MCV interview](https://www.mcvuk.com/business-news/when-we-made-townscaper/).
   We take the rendering vocabulary: thick roof overhangs with deep shadow
   under them, one flat colour per face, bevelled edges that catch light,
   and silhouettes that read from a long way off. We do not take the
   palette. Stålberg calls it "a rainbow palette plus two extra greys and
   white", and it is far louder than our brief.
6. **Tiny Glade (Pounce Light).**
   [Steam page](https://store.steampowered.com/app/2198150/Tiny_Glade/),
   [80 Level interview with Anastasia Opara and Tomasz Stachowiak](https://80.lv/articles/exclusive-tiny-glade-developers-discuss-bevy-proceduralism-publishers-cozy-games).
   We take the foliage and the light: round soft tree crowns, grass that
   runs right up to walls and paths, a low warm sun, soft shadows with
   wide penumbrae, and strong bounce light under eaves. Its medieval
   buildings and its depth of field are not ours.
7. **Natsu-mon: 20th Century Summer Kid (Millennium Kitchen).**
   [Steam page](https://store.steampowered.com/app/2839280/).
   The closest game to our content: a rural seaside Japanese town in three dimensions,
   with fields, a shrine, utility poles and a station. We use it to check
   which props carry the "Japanese country town" reading.
8. **Ryo Takemasa, illustrations of Tokyo suburbs.**
   [Spoon and Tamago on his Musashino covers](https://spoon-tamago.com/musashino-ryo-takemasa/).
   Flat-colour illustrations of Japanese suburban streets. We take the
   idea that a muted palette still needs one or two warm accents per view
   (a red post box, a lit sign, a persimmon tree).
9. **Ponyo and Kiki's Delivery Service (Studio Ghibli).**
   [Ponyo on Wikipedia](https://en.wikipedia.org/wiki/Ponyo),
   [Kiki's Delivery Service on Wikipedia](https://en.wikipedia.org/wiki/Kiki%27s_Delivery_Service).
   Ponyo's town is Tomonoura in paint. Kiki's town is European (Visby and
   Stockholm), so we take only its sense of a town on the sea seen from
   the air, not its buildings.
10. **A Short Hike, Islanders, Mini Motorways, Animal Crossing New Horizons.**
    [A Short Hike](https://store.steampowered.com/app/1055540/A_Short_Hike/),
    [Islanders](https://store.steampowered.com/app/1046030/ISLANDERS/),
    [Mini Motorways](https://store.steampowered.com/app/1127500/Mini_Motorways/),
    [Animal Crossing New Horizons](https://animal-crossing.com/new-horizons/).
    How small things read from far. Islanders keeps each building type to one
    silhouette and one colour. Mini Motorways draws roads as flat clean
    ribbons with no texture. A Short Hike shows that a few large
    shapes plus outlines beat detail at a distance. Animal Crossing shows
    soft shadow and contact occlusion holding small props to the ground.
    All four are more saturated than we want.

### The three that define the goal

- **Tomonoura and Manazuru photographs: the content.** They are real,
  modern enough, and taken from our two camera heights. They settle what
  is in a town and how much of each. When a render and these photos
  disagree on density, colour or the share of green, the photos win.
- **Townscaper: the shapes and shading.** It solves the problem we
  failed at: small houses that read as houses from far away. It does
  this with overhangs, occlusion, and a few big planes, not texture.
- **Tiny Glade: the foliage and light.** It makes vegetation and
  buildings feel like one place, with soft shadows and warm light. Our
  first attempt had no foliage at all, and Tiny Glade is the clearest
  example of how much the soft green carries.

### Art rules from the chosen references

The colour values are design targets set against the photographs. They
are not measured pixel values: photographs carry haze and camera colour
grading, and the town is lit by our own sun. All values are standard RGB
(sRGB) hex.

**Walls.** Off-white `#e8e4da` to `#f2efe8`, beige `#d8ccb2` to `#e0d6c0`,
pale grey `#c4c4be` to `#d2d2cc`. About one house in ten breaks the rule:
dark timber `#5a4636` to `#6e5644`, or corrugated metal siding
`#8e969c` to `#a4aaae`. Concrete block garden walls `#b8b4aa`.

**Roofs.** Grey tile `#5a5e64` to `#7a7e84` for most houses, blue-grey
`#4c5a6a` to `#5e6c7c`, dark slate `#3a3d42`, and painted metal in green
`#5f8a7a` to `#74998a` (clearly visible in the Manazuru photograph) or
rust-brown `#7a4a3a`. Roughly: 60 percent grey, 20 percent blue-grey or
slate, 15 percent green metal, 5 percent brown. No orange roofs.

**Roads.** Asphalt `#45474a` to `#55575a`, a little darker than the roof
greys so the network separates from the roofs. White edge line
`#e6e6e0`. School-route strip, pale green `#7fb58a`, on a few lanes near
the school only. Concrete gutter covers along lane edges, `#a8a69e`.
Yellow centre line `#d9a640` only on the one main road.

**Foliage.** Broadleaf evergreen in shade `#2e4630`, in sun `#5e7d44`.
Pines darker and cooler, `#2a3a2e` to `#3a4c3a`. Lawn and open grass
`#7f9a56`. Summer rice paddy `#86b04e`. Vegetable plots alternate bare
earth `#7a6650` with rows of green.

**Density and spacing.** Lot about 12 × 14 metres (3 × 3.5 units), house
footprint about 8 × 9 metres (2 × 2.25 units), so a house covers about
40 percent of its lot. The gap between neighbouring houses is 1 to 2
metres (a quarter to half a unit), never a full house width. The gap
between a house front and the lane is 1 to 3 metres: a wall or hedge and
a parking space.

**Roof to wall.** Two storeys, about 6 metres to the eaves. Hipped or
gabled roofs at about 22 to 27 degrees rise 2 to 2.5 metres, so the roof
is a third to two fifths of the wall height. Eaves overhang 0.4 to 0.6
metres. From the island camera, the roof is nearly all you see, so roof
colour and shape matter more than walls.

**Green against built.** In the Tomonoura aerial, the dense core is
about one part green to two parts roof. At the town edge it flips to
about two parts green to one part roof. The whole island should read as
at least 40 percent green.

**How roads read.** Lanes are 4 metres (1 unit) wall to wall, streets 6
metres, the main road 10 metres. No pavements. Edges are marked by the
white line and the gutter covers, not by a kerb. From far, roads are thin
dark gaps between roofs; they never look like wide grey bands.

**Distance reading.**
- Far (whole island): roof clusters as blocks of grey and blue-grey,
  dark green masses for groves and pines, light fields at the edge, one
  pitch or school ground as a large pale rectangle.
- Middle (street level from 30 metres up): individual roofs and their
  ridge lines, lanes with white edges, poles and wires, single trees,
  hedges, cars parked in lots.
- Close: windows, balconies and laundry, vending machines, bikes,
  people.

**Lighting.** Late morning or late afternoon sun at 25 to 35 degrees
elevation, warm `#fff0d8`. Cool sky fill `#b8c8dc`. Strong ambient
occlusion under eaves, between houses, and where walls meet the ground.
Soft shadows with a visible penumbra. Light haze over the sea, as in the
Tomonoura photograph, that greys and blues distant islands.

## 2. Procedural town layout

### Techniques considered

- **Emilien, Bernhardt, Peytavie, Cani and Galin, 2012, "Procedural
  generation of villages on arbitrary terrains".**
  [Paper](https://perso.liris.cnrs.fr/egalin/Articles/2012-villages.pdf),
  [HAL record](https://hal.archives-ouvertes.fr/hal-00694525).
  Small villages grown house by house. Each new house picks a spot from
  an interest map, is then connected to the road network by a shortest
  path, and the new road changes the interest map for the next house.
  This is the one we build on (details below).
- **Parish and Müller, 2001, "Procedural modeling of cities".**
  [Paper](https://cgl.ethz.ch/Downloads/Publications/Papers/2001/p_Par01.pdf),
  [SIGGRAPH history entry](https://history.siggraph.org/?p=116923).
  L-system road growth driven by population and terrain maps, with rule
  sets for grid, radial and hill-following streets. Built for cities.
  Its growth idea is right,
  but it draws roads first and fills blocks after, which gives the comb
  of long straight roads we already got.
- **Chen, Esch, Wonka, Müller and Zhang, 2008, "Interactive procedural
  street modeling".**
  [Project page](https://www.sci.utah.edu/~chengu/street_sig08/street_project.htm).
  Streets traced along a tensor field. Good for cities with districts of
  different orientation. Too much machinery for a village of a few
  hundred houses, and lanes in a village follow lots, not a field.
- **Vanegas, Kelly, Weber, Halatsch, Aliaga and Müller, 2012,
  "Procedural generation of parcels in urban modeling".**
  [Paper](https://www.cs.purdue.edu/cgvlab/papers/aliaga/eg2012.pdf).
  Splits city blocks into lots by oriented bounding box subdivision or
  straight skeletons. We use its oriented bounding box split only for the
  dense core, where apartment blocks sit on larger rectangular lots.
- **Townscaper's irregular grid.** See the Boris the Brave link above.
  Hexagons split into quads, then relaxed. Gives organic cells with no
  roads at all. A good fallback for lots that have no lane (rare
  coastal files) or for filling a plaza.
- **Watabou's generators.**
  [Village Generator](https://watabou.itch.io/village-generator),
  [Medieval Fantasy City Generator](https://watabou.itch.io/medieval-fantasy-city-generator).
  Not papers, but the best working examples of the result we want from
  above: houses packed along winding roads, fields and orchards beyond.
  Use them as a visual benchmark for the plan view.
- **Space colonisation road growth.**
  [Runions et al. 2007](https://algorithmicbotany.org/papers/colonization.egwnp2007.html).
  Branches grow toward attraction points. It makes good tree-like lane
  networks, but it has no loops and no idea of lots. Emilien's method
  does the same job and adds both.

### What Emilien et al. do, concretely

- **Interest map.** For each candidate spot, a weighted sum of criteria,
  each in [-1, 1], clamped at zero, and impossible if any criterion is
  -1. The criteria: sociability (an attraction-repulsion function of
  distance to other buildings: too close is bad, a short distance is
  best, far is neutral), worship (attraction to a temple or church),
  accessibility (a bell curve on distance to the nearest road with a
  preferred distance and hard limits), slope, water, and geographic
  dominance.
- **Seeding.** Sample a random position, accept it with a probability
  given by the interest, retry on failure.
- **Roads.** Right after a house is placed, connect it by a shortest path
  whose cost sums slope, curvature, water and crossing buildings. Existing
  road segments cost less (a reuse weight below one), so new roads join
  old ones instead of running parallel. Then a cycle step looks for the
  nearest road node in a cone ahead and adds a second connection if it
  is not too close to the first. That makes loops.
- **Parcels.** Three passes on a grid. Road conquest: each house claims
  road frontage on both sides of its projection onto the road. Corner
  conquest: the first parcel to reach a junction takes the corner.
  Anisotropic conquest: parcels spread away from their frontage with a
  cost that uses the infinity norm along and across the road for houses
  (giving near-rectangular lots) and Euclidean distance for fields
  (giving rounder ones). Then the outline is simplified.
- **Footprints.** A quad starts at the road edge of the parcel, oriented
  to the road, and grows until it reaches the type's maximum size or
  touches the parcel edge. Snapping to the edge gives terraced rows.

### Mapping it onto packages

- The package root seeds the town centre: a small square, the station or
  the convenience store. The test suite seeds the school and its pitch
  (or a stadium for a large suite). The shrine grove goes where the
  interest map scores lowest for houses but still within reach of a lane.
- Each folder is a street. It grows from its parent folder's street, so
  the network's branching matches the folder tree.
- Each file is a household. Sociability gets an extra attraction toward
  files it imports or that import it, so imports pull neighbours
  together. Accessibility prefers a spot about half a unit to one unit
  from its own folder's street.
- A distance-to-centre term scores high in the middle and falls off, so
  the centre is compact and the edge loosens. Beyond the last houses,
  leftover land goes to fields (Euclidean conquest), not to more houses.
- Order matters for stability: place files sorted by path and draw random
  numbers from a hash of the path, so changing one file moves only its
  own neighbourhood.

### Keeping it organic on a flat plateau

Emilien's lanes wind because of terrain slope. Our plateaus are flat, so
the path cost needs its own reasons to bend:

- a low-frequency noise cost field (features about 15 to 30 units
  across) so paths drift gently,
- a curvature cost so they bend smoothly, not in zig-zags,
- a maximum straight run of about 15 to 20 units (60 to 80 metres)
  before the cost encourages a bend,
- existing lots cost a lot to cross, so lanes bend around houses that
  are already there.

Run the path search on a grid of half-unit cells. A 1 kilometre island is
500 × 500 cells, which is small enough to bake on the main thread when
the chart changes, or in a worker.

### Recommendation

Use Emilien et al. as the main algorithm: seed a household, connect it,
try a cycle, update the maps, repeat. Use Vanegas's oriented bounding box
split only for the dense core. Use the Townscaper grid for the rare lots
that sit off the network. Use watabou's maps as the visual check for the
plan view. Skip tensor fields and L-systems.

## 3. Layered world and land use

### How production games do it

- **Horizon Zero Dawn, procedural placement on the graphics processor
  (Jaap van Muijden, GDC 2017).**
  [Guerrilla article](https://www.guerrilla-games.com/read/gpu-based-procedural-placement-in-horizon-zero-dawn),
  [slides, portable document format](https://www.guerrilla-games.com/media/News/Files/GDC2017_VanMuijden_GPUBasedProceduralPlacementInHorizonZeroDawn.pdf).
  Artists write placement rules as graphs over world data maps. The graphics processor
  turns each rule into a density map, then into placed instances, in
  real time around the player. From the slides' outline, layered dithering
  handles collisions: layers are placed in order, and each layer's footprints suppress later
  layers. We copy the order and the footprints, but bake once per chart
  change instead of every frame.
- **Ghost of Tsushima.**
  [Procedural Grass (Eric Wohllaib, GDC 2021)](https://gdcvault.com/play/1027214/Advanced-Graphics-Summit-Procedural-Grass),
  [Blowing from the West: Simulating Wind (Bill Rockenbeck)](https://gdcvault.com/play/1027124/Blowing-from-the-West-Simulating).
  From the talk descriptions, grass is generated on the graphics processor from terrain data rather than stored as
  instances, and the wind is a shared field that drives grass, trees and
  cloth. We take both: grass reads a baked height channel where zero
  means none, and laundry, trees and grass share the existing wind.
- **Far Cry 5 (Etienne Carrier, GDC 2018).**
  [SideFX talk page](https://www.sidefx.com/learn/talks/procedural-world-generation-far-cry-5/),
  [GDC Vault](https://gdcvault.com/play/1025215/Procedural-World-Generation-of-Far).
  Houdini tools build biomes, terrain textures, freshwater networks and
  cliffs from the terrain, and vegetation follows conditions such as
  humidity and sunlight. We take the idea that every scatter input is a
  derived map, never hand painting.
- **Ghost Recon Wildlands (Guillaume Werle and Benoit Martinez, GDC
  2017).**
  [GDC Vault](https://gdcvault.com/play/1024029/-Ghost-Recon-Wildlands-Terrain),
  [80 Level on its procedural world building](https://80.lv/articles/procedural-world-building-in-ghost-recon-wildlands/).
  Roads come from a pathfinding tool with costs for slope and tight
  turns and a discount for following existing roads. The road is then
  stamped into the terrain. This is the same shortest path as Emilien,
  at production scale. We take the stamping: roads write into the land
  layer before anything else is placed.

### The layer stack for the islands

Each layer is baked when the chart changes and is read by later layers
and by the frame. Texel sizes assume a plateau up to 1 kilometre across.

| Layer | Built from | Baked product |
| --- | --- | --- |
| 0. Landform | chart | height, coast distance, cliff mask (exists today) |
| 1. Plan | files, folders, imports, landform | road graph, lots, building seeds (central processing unit, kept as arrays) |
| 2. Zoning | plan | `rgba8unorm`, 1 metre per texel. Red: zone id (sea, beach, cliff edge, open, field, grove, lot, road, plaza, pitch). Green: lot-edge distance for walls and hedges. Blue: building footprint coverage. Alpha: reserved |
| 3. Road field | road graph | `rg16float`, half a metre per texel. Red: signed distance to the road edge. Green: road class |
| 4. Buildings | lots, seeds | instance buffer: position, rotation, footprint, storeys, roof type, wall and roof colour index, seed, window light flag |
| 5. Density | zoning, road field, coast distance | `rgba8unorm`, 1 metre per texel. Red: tree density. Green: shrub and hedge density. Blue: grass height. Alpha: flowers and crops |
| 6. Trees and shrubs | density | instance buffers per species, placed largest first |
| 7. Street furniture | road graph, lots | instance buffers: poles, wire spans, walls, vending machines, signs |
| 8. Life | road graph, lots, buildings | instance buffers: parked cars, bikes, laundry, people and moving cars (path index plus phase) |

### How terrain and grass leave reserved areas

- The zoning layer is computed before the final terrain pass. The height
  bake reads it: lots are flattened to a pad, roads are lowered a few
  centimetres, pitches are levelled. So the terrain is shaped for the
  town rather than painted over afterwards.
- The ground shader picks its material from the zone id first (asphalt,
  gravel, garden, field, beach), then blends with the road field.
- The density bake multiplies everything by "not reserved". Grass height
  is zero on roads, under footprints, on pitches and plazas. It ramps up
  over one or two metres from a road edge or wall, so grass meets edges
  in a soft line as in Tiny Glade, not a hard cut.
- Trees are placed in priority order, as in Horizon's layered dithering:
  shrine grove, coastal pines, garden trees, hedges, shrubs. Each placed
  tree writes its crown footprint into a scratch mask, and later layers
  skip masked cells.

### Draw budget

One ground draw. One grass draw. One instanced draw per mesh kind for
buildings, trees, poles, wires and props, issued as indirect draws if the
counts change. Lights are emissive values in instance data plus bloom,
not real lights. That stays around 20 draws for a whole island.

## 4. Foliage and life

### Placement method

- **Blue noise from density.**
  [Bridson 2007, fast Poisson disk sampling](https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph07-poissondisk.pdf).
  Use Poisson disk sampling with a radius that varies with density:
  `radius = minimumRadius / sqrt(density)`. Run it once per species at
  bake time, on the central processing unit or a worker; a few thousand
  trees take milliseconds.
- **Competition.**
  [Deussen et al. 1998, Realistic modeling and rendering of plant ecosystems](https://algorithmicbotany.org/papers/ecosys.sig98.html),
  [Konstanz project page](https://graphics.uni-konstanz.de/publikationen/Deussen1998RealisticModelingRendering/index.html).
  Plants are given sizes, and where two overlap the weaker one is
  removed or shrunk. Repeating this thins a dense seeding into natural
  clumps with clearings. We run two or three rounds of it after the
  Poisson pass, so groves have big trees in the middle and smaller ones
  at the edge.

### Species and rules

- **Shrine grove.** Dense, tall, dark evergreens, 15 to 25 metres
  (4 to 6 units), packed so crowns touch. One per town, at the edge,
  with a short approach path and a torii gate.
- **Coastal pines.** Japanese black pine along the beach top and the
  cliff edge, leaning slightly away from the prevailing wind. A single
  broken line, not a solid wall. Tomonoura and Ine both show dense green
  right behind the shore.
- **Garden trees.** One or two per lot at most, at the corner of the lot
  or behind the wall, 4 to 8 metres tall: pruned pines, persimmon, maple.
  Many lots have none. Their crowns hang over lane walls.
- **Hedges and walls.** Along the lot edge facing the lane: concrete
  block wall or clipped hedge, about 1.2 metres, broken by the parking
  space and the gate.
- **Street trees.** Rare. Only on the main road and around the school.
  Small country towns do not line lanes with trees.
- **Fields.** At the edge, where the plan left land unclaimed. Rice
  paddies in flat rectangles with low earth bunds, vegetable plots in
  rows, a citrus orchard in dotted rows on any slope near the cliff
  edge.
- **Open land.** Long grass with patches of shrubs, so the plateau
  beyond the fields is not a bare lawn.

### Signs of life, ordered by cost

| Item | Rule | How |
| --- | --- | --- |
| Lit windows at dusk | about 40 percent of houses, chosen by hash | one flag and a hue per building instance, emissive in the wall shader |
| Vending machines | at about one in four lane junctions and outside the shop | one instanced box, emissive front |
| Convenience store sign | one per town, on the main road | emissive band on a building variant |
| Utility poles and wires | one side of every lane, about every 8 to 12 units (tune against the Manazuru photograph) | pole instances, wire spans baked as catenary ribbons in one buffer |
| Parked cars | one per house lot in the parking space, about 70 percent occupied | instanced boxes with a few colours, mostly white, silver, black |
| Bikes | by the door of about a third of houses | one small instance |
| Laundry | on the balconies of about a third of houses, more on apartment blocks | instanced quads, moved by the shared wind in the vertex shader |
| Moving cars | a few per town on streets and the main road | instance holds a road path index and a phase; the vertex shader evaluates position from time. No per-frame central processing unit work |
| People | small figures walking lanes, sitting at the shrine, playing on the pitch | as moving cars, along lane paths, with a two-frame bob |
| Boats | at quays, bobbing on the sea surface | instances that sample the existing wave function |

Everything here is a static instance or a time-driven instance. Nothing
needs simulation, and all of it can be baked with the plan.

## 5. Roads that look crisp

### Options

- **Geometry ribbons.** A mesh strip per road, laid on the terrain.
  Crisp edges at every distance, but they fight the terrain where it is
  not flat, need a depth bias, and add a draw. Mini Motorways and
  Islanders can do this because their ground is flat. Ours is flat on
  the plateau too, but not where roads reach the beach or a ramp.
- **Projected decals.** Boxes that project the road onto whatever is
  below. Flexible, but every decal adds overdraw, and many short
  segments mean many boxes.
- **Baked colour mask.** What we tried. Blurry at street level unless the
  texture is huge, and edge lines vanish.
- **Baked signed distance field.** Store the distance to the road edge,
  not the colour. Linear filtering keeps the zero crossing sharp at any
  magnification, so the edge stays crisp even when texels are larger
  than pixels.
  [Green 2007, Improved alpha-tested magnification for vector textures and special effects](https://cdn.akamai.steamstatic.com/apps/valve/2007/SIGGRAPH2007_AlphaTestedMagnification.pdf).
- **Analytic distance per pixel.** Evaluate the distance to nearby road
  segments in the ground shader.
  [Inigo Quilez, 2D distance functions](https://iquilezles.org/articles/distfunctions2d/).
  Exact at any zoom, but needs a per-tile list of segments.

### Recommendation

Bake the road field (layer 3) as signed distance to the road edge at half
a metre per texel. In the ground shader:

- road coverage = `smoothstep(-w, w, -d)` with `w = fwidth(d)`, which
  gives a one-pixel antialiased edge at any distance,
- the white edge line from the same field: `abs(d + inset) < lineHalfWidth`,
  with an inset of about 0.3 metres and a half width of about 0.07
  metres, antialiased the same way,
- gutter covers as a band just outside the edge,
- the yellow centre line on the main road from a second distance, to the
  centreline, packed in the class channel or a second texture.

Sharp corners round off slightly at junctions, which suits lanes. If we
ever bring the camera low enough that the half metre texel shows, switch
the close tiles to analytic segment distance, using the same shader
logic. It stays one ground draw.

## 6. The goal

### Look references

- Tomonoura aerial and Manazuru street photographs: what is in the town
  and how much of it.
- Townscaper: how small houses are shaped and shaded so they read from
  far.
- Tiny Glade: foliage, grass meeting edges, warm soft light.

### Art rules to judge renders against

1. Walls are off-white, beige or pale grey. At most one house in ten
   breaks this.
2. Roofs are mostly grey, then blue-grey and green metal. No orange, no
   saturated colour.
3. Roofs have overhangs with visible occlusion beneath.
4. Houses are two storeys, roof about a third of wall height, set 1 to 2
   metres apart, each on its own lot.
5. Apartment blocks appear only in the dense core, and a tower is a
   deliberate imbalance signal, never filler.
6. Lanes wind gently. No straight run longer than about 80 metres, and no
   comb of parallel dead ends.
7. Roads are dark, narrow, edged with a crisp white line, and sharp from
   every camera distance.
8. The town is compact in the middle and loosens toward fields at the
   edge.
9. The island reads as at least 40 percent green; the core about one part
   green to two parts roof, the edge the reverse.
10. Grass never grows through roads, lots or buildings, and meets them
    with a soft edge.
11. There is one shrine grove, a line of coastal pines, and fields.
12. Utility poles and wires line the lanes.
13. Warm low sun, cool fill, soft shadows, haze over the sea.
14. One or two warm accents per view: the shop sign, a vending machine,
    lit windows at dusk.
15. Isolated files sit as a small dark row at the shore, like Ine, not as
    lone boxes in a field.

### Screenshot review checklist

**Whole island.**
- Does it read as a town on an island, not a city?
- Are roofs grouped in clusters with green between them?
- Is there a visible compact centre and a softer edge with fields?
- Are the grove, the pines and the pitch identifiable as shapes?
- Is the palette muted next to the sea, with no single loud colour?

**Street level from 30 metres up.**
- Are lanes narrow, winding and crisp-edged with white lines?
- Do houses sit close with walls, hedges and parking in front?
- Are poles and wires present and spaced evenly along lanes?
- Do garden trees break the roofline here and there?
- Does grass stop cleanly at roads and walls?

**Close.**
- Do windows, balconies and laundry give scale?
- Are there bikes, cars, vending machines, a few people?
- Do eaves and wall bases have contact occlusion?
- Does anything look like a plain box with no roof, overhang or door?
