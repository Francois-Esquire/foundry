# Islands: towns

The islands' tops carry towns. Each island is one small, quiet modern town,
and the town is built from its package's files and folders. The town is
meant to feel small and quaint. When part of the code is out of balance,
the town looks out of balance too: a tower stands among two-storey houses,
or one street is packed while the others are empty. That contrast is the
point of the design, so don't smooth it away.

This replaced the huts, a ladder of medieval structures (cottage,
longhouse, keep). The town keeps their human scale, their instanced part
shapes, their ground shadows and their lighting (town-parts.ts).

## The look

A small modern town, after a Japanese country town but not tied to one
place. The things that give it its character:

- Narrow streets with no pavements, their edges marked by white lines.
  Lanes so tight two people can just pass.
- Two-storey detached houses packed close together, each on its own
  small lot. Low walls or hedges in front, and a parking space the width
  of one car.
- Roofs: hipped or gabled, in grey or blue-grey tile, with some flat
  roofs on the newer boxes. Walls: off-white, beige, pale grey, with the
  odd one in timber or corrugated metal.
- Balconies with laundry rails on the upper floor.
- Small walk-up apartment buildings: two storeys, the outside stairs at
  one end and an open corridor along the front, doors in a row.
- Apartment blocks (beige tile, balconies on every floor) where there are
  many people, nearer the middle of town.
- Utility poles along every street with their wires sagging between them.
  Vending machines, a convenience store with a lit sign at a corner.
- A shrine in a small grove at the edge, a school with its sports ground,
  gardens and small fields where the town runs out.

The palette is muted and low in contrast: whites, beiges and greys, with
the roofs and a few signs carrying the colour. Nothing glossy or neon
except the convenience store and the vending machines, which are lit in
the evening.

## Scale

The human scale doesn't change: one chart unit is about four metres. A
door is half a unit and a storey three quarters. The cliffs (six units)
stand about eight storeys tall, so a town of mostly two-storey houses
sits low on its plateau.

| Thing | Chart units | Metres |
| --- | --- | --- |
| Door / storey | 0.5 / 0.75 | 2 / 3 |
| Lane / street / main road, wall to wall | 1 / 1.5 / 2.5 | 4 / 6 / 10 |
| House lot | about 3 × 3.5 | 12 × 14 |
| Detached house footprint | about 2 × 2.25 | 8 × 9 |
| Walk-up apartment building | about 2.5 × 5 | 10 × 20 |
| Cliff (`plateHeight`) | 6 | 24 |

Files sit 3 to 5 units apart on the chart, about one house lot each, so
a town at this scale fills about the land its files cover today.

## The rules

### 1. One file is one household

Every file is one unit someone lives or works in: a house, a flat, a
shop. A building holds as many units as it has files, and its size comes
from that count alone. Never scale a building up to show size. Add units:
more floors, more flats along a corridor, more buildings.

### 2. Folders are streets

The folder tree is the street network:

- The island (the package) is the town.
- The package root's folders (`src`, `scripts`, ...) are the town's
  districts. Each has a main road through it. Test folders are the
  exception: their files become grounds beside the streets they test
  (rule 5), so a `test` folder makes no district of its own.
- Each folder below them is a street that branches off its parent
  folder's street. A deeper folder is a narrower street: main road, then
  street, then lane. Past the third level every folder is a lane.
- A folder's files are the lots along its street. Files of one street
  stand together, and walking down the street walks through the folder.

A folder with one file is a single house at the end of a short lane. A
folder with no files of its own (only subfolders) is a junction: its
street exists only to join its children's.

The town is planned from the folder tree, not from where the chart's
source placed the files. The plan fits the island's land: the main roads
run through the middle of the plateau, streets branch off them in the
order their folders sort, and the tree's shape decides the town's shape.
The files' chart positions are not used. So a building's file is the one
its street and lot say, and everything that finds a file on the land
(picking, highlights, the files map) asks the town, not `Module.at`.

### 3. Crowded streets build up

A street has room for a certain number of lots, about one lot for every
four units of its length. When a folder has more files than its street
has lots, they no longer fit as houses, so they stack into apartments.
The building type comes from how many files share one lot:

| Files on one lot | Building |
| --- | --- |
| 1 | Detached house, two storeys |
| 2–3 | A pair of semi-detached houses, or a house with a shop below |
| 4–8 | Walk-up apartment building: two or three storeys, outside stairs, an open corridor |
| 9–24 | Apartment block: three to five storeys, balconies on every floor; only in the dense core |
| Over 48 in one folder | The island's one tower: up to ten storeys of six flats |

A street holds at most 40 lots for a main road, 24 for a street and 14
for a lane, fewer on an island whose town would otherwise take more than
two fifths of its land. Past that, the street's homes stack into as few
bigger buildings as hold them, standing first along it, nearest its
mouth and the town's middle. Each island has at most one tower, for the
folder so crowded that blocks nearby could not take it (more than 48
homes), and it stops at ten storeys; what it can't hold becomes more
blocks beside it. A flat folder of 145 files becomes a ten-storey tower
and four blocks among two-storey houses. It should still look wrong,
because it is: the structure says this folder wants splitting. Don't
hide the tower; the cap keeps it one deliberate signal rather than a
skyline.

### 4. What a file is shows in what it's used for

The building type comes from how many files share a lot. What kind of
place each unit is comes from the file:

| File | Place |
| --- | --- |
| Source | A home. The ordinary fabric of the town. |
| Test | Not a home: a ground where the town's facilities are put through their paces. See rule 5. |
| Config | Utilities: a substation box, a water tank, a pump house. Small and grey. |
| An index (role `aggregator`) | The convenience store at its street's mouth, where the street meets its parent's. |
| Heavily imported (high `fanIn`) | A public building: a post office, a clinic, a school. The town's most imported file is its station, on the main road. |
| Changed often (`change.frequent`) | Under construction: scaffolding and netting, a small crane over the bigger ones. |

When a building holds units of mixed kinds, its main kind sets its
type: an apartment block over a row of shops, for instance.

### 5. Tests are grounds where things perform

Tests are part of the facility they test, not homes and not a separate
district. They are open grounds where things are tried out in front of
an audience, built next to the street whose files they test (the folder
their test files import from most). A test folder mirroring `src/lib`
stands beside `src/lib`'s street, not off in a `test` district.

The ground's size comes from how many test files it holds:

| Test files | Ground |
| --- | --- |
| 1–3 | A playground: swings, a slide, a sandpit |
| 4–12 | A training ground: a practice pitch, nets, a small clubhouse |
| 13–40 | A sports ground: a running track round a pitch, low stands on one side |
| 41 and over | A stadium: stands all round, floodlights, as big as it needs to be |

Each test file is one marked lane, net or seat block in its ground, so a
ground grows by one place for each file, as a building grows by one
flat. A street with no ground next to it is a street nobody tests, and
that should be easy to see from above. A stadium beside a single small
street means a lot of testing for little code; also worth seeing.

The grounds are where the town performs. Later they can come alive:
figures running the track, a match on the pitch, the floodlights on.
Build them so that motion can be added without replanning: a track's
lanes, a pitch's markings and the stands' seats are laid out as places,
not just painted.

### 6. Neighbourhoods share a look

A district in the chart's sense (a group of modules that belong
together) is a neighbourhood. Its buildings share a roof colour and a
wall material, so it reads as a patch of town built at one time.
Streets cross neighbourhoods freely: the folders and the districts are
two different groupings, and seeing where they disagree is useful.

### 7. Imports are the wires

Every import is a wire. The utility poles stand along every street, and
an import's wire runs from the importing building to the imported one
along the streets between them, pole to pole, never in a straight line
over the roofs. Where many imports share a stretch of street, the poles
carry many wires: a busy road between two neighbourhoods sags with
cable, a quiet lane carries one line.

- A wire's path is the street path between the two buildings, through
  the folder tree: up to the streets' common parent, then down. Imports
  between far branches of the tree cross the town on its main roads, so
  a tangle of cross-town wiring shows as heavy main roads.
- Type-only imports (nothing of them runs) are thin telephone lines.
  Imports that run are thicker power lines.
- A building imported by many others has a transformer on its nearest
  pole, bigger the more wires reach it.
- Imports to other islands (`Import.crossing`) leave the town along its
  main road to the coast and go down into the sea as a cable: the chart's
  routes between islands already show where those go.

### 8. The town edge

Past the last lot, the town turns into gardens, small fields and trees
before it reaches the cliff. A shrine and its grove go at the edge, where
the most empty land is. Keep a margin clear of the cliff's lip. Files
that stand alone (nothing imports them and they import nothing) are not
scattered round the rim: they share a short dark row of boathouses at
one stretch of shore, like Ine's funaya, and one of them keeps the
island's single lighthouse on its most exposed point.

## Where things go

The planner (`world-plan.ts`, `planWorld`) follows these. It grows each
island's town after Emilien et al. (REFERENCES.md section 2) rather
than laying out a grid; the numbers below are its settings.

**What the chart's placement says.** The source places files by their
imports first. Two files where one imports the other sit 20 units apart
on average, against 65 for any two files of one island, and closer even
than two files of one folder (23). Folders cluster as a side effect: two
thirds of the files have a file of their own folder as their nearest
neighbour, but the chart's districts are spread out (their files sit 55
units apart on average), and only two in five imports stay inside one
folder. So the town keeps the folders as streets (rule 2) and uses the
imports to order things along them. The chart's own positions are not
used.

**The package root.** The root is the deepest folder holding every file
that lives on a street. A root with no files of its own and one folder
below it hands the town to that folder: `apps/works` holds only `src`
(its `test` folder is grounds), so `apps/works/src` is the root. Any
other folder with nothing of its own and one folder below it is only a
corner: its child branches straight off the grandparent's street.

**The middle.** The town's middle is the buildable cell nearest the
middle of the island's land that still has room round it for the core
(about half the town's reach clear of the coast). The plaza stands
there on one side of the root's street, and the station (the island's
most imported source file) across from it. The root's street runs both
ways through it along the island's long axis.

**Streets grow.** Every other street grows from its parent's, a unit at
a time, weighing a fan of gentle turns: its own wind (smooth noise keyed
by its folder's path), what lies ahead (the coast's margin, other roads,
claimed ground, room for a lot on both sides), a lean toward open land
for its first ten units, and, past halfway out, a pull back along the
town rather than out of it. A street may not cross a parcel or come
within a hair of another road, and it may not run straight: any stretch
of 15 units must stray at least a unit off its chord, so no stretch
longer than about 16 units stays within half a unit of its own (rule
6). Where a street can neither bend nor go on, it ends. When a street's
end comes within 12 units of another road ahead and meets it well
across, it runs on to that road's centreline: a loop.

**Mouths first, then lots.** Before any lot is laid, each branch gets
its mouth, kept free on its parent's frontage at its place in the
street's order, on the roomier side, with a corridor no lot may take.
Lots then fill both sides from the mouth outward, each the next free
stretch on the side that has gone least far. Every sixth lot a lane's
width is left open, where a street that finds no other room may branch
later. Lots are rectangles fronting the road a kerb's width off its
edge: a house lot 2.6 along by 3.5 deep, the house 2 by 2.25 on it, so
houses stand about 2 metres apart. In the middle they stand shoulder to
shoulder; past about half the town's reach the gaps open up to 1.8
units (rule 8).

**Order along a street.** The stores stand first, at the street's
mouth. After them comes a chain: each next lot, ground or branch is the
one with the most imports to or from the one before it, then to
everything placed so far, then the most connected, then the folders'
own order. Neighbours in the chain stand next door or across the street
from each other, so files that import each other are neighbours and
sibling streets that import each other branch off side by side.

**Crowding.** See rule 3 for the caps. Stacked buildings come first in
a street's order, so they stand near its mouth. An apartment block that
would stand further out than 0.6 of the town's reach is built as
walk-ups side by side instead, so blocks gather in the core.

**What doesn't fit.** A street that runs out of room before its units
do grows an overflow lane of the same folder from the roomiest free
frontage near it, and the planner tries again a few rounds while each
round houses something. A ground that fits nowhere at its size makes do
with the next size down. Files that still find nothing (31 of Foundry's
1931, on three small islands whose streets ran short) move in with the
homes nearest their street, a few to each, turning a house into a pair: crowding
builds up rather than any one building swallowing them.

**Tests.** A test file is one in a `test`, `tests` or `__tests__` folder,
or of kind test. Tests form one ground per test folder, cut one level
below the test folder (`test/lib/fixtures/deps/...` is part of
`test/lib`'s ground), and colocated tests one ground per folder. The
ground stands on the street of the folder its tests import most; with no
imports into town, on the street its name mirrors, else its nearest
folder above. Its size comes from rule 5 but a town has to carry it: a
stadium (16 by 12) only beside a town of 120 buildings or more, a
running track (13 by 9.5) beside one of 60 or more, otherwise a training
pitch (9 by 7.2) at most. Its stand runs along the ground's back and
holds its files as seats. The island's biggest ground has the school
beside it.

**Public buildings.** The island's most imported source file is its
station, at the plaza. Any other source file imported by 20 files or
more is a public building: 57 of Foundry's 1097 source files, about the
top twentieth (half are imported by 2 or fewer, nine tenths by 12 or
fewer).

**The edge.** The shrine goes where the land is emptiest at the town's
edge (4 to 22 units from anything built, well inside the coast), on a
footpath to the nearest road, in a grove of about 8 units. Farm paths
run on from the outermost dead ends, with fields along them, up to
about an eighth of the island's buildable land. A garden strip lies
behind each house where the land is free, a third of them with a tree.
Pines grow in a band along a quarter of the coast away from the shore
row. Street trees line the main roads; utility poles stand on one side
of every road but the footpaths, 8 to 12 units apart.

**The shore.** The files that stand alone, on Foundry 170 of them
(`@foundry.sh/marbles` 51, `@foundry.sh/spyglass` 46, test fixtures
mostly, `@foundry/works` 42, `@foundry/docs` 21), share boathouses three
to a house, in one row along the smoothest, emptiest stretch of rim
that holds them, away from the shrine, doors to the sea, with a path
behind them to the town. One of them keeps the lighthouse on the rim
point farthest from the town's middle. A config file never counts (the
tools read it, not the code), and a file whose only imports cross to
other islands doesn't either.

**Stability.** The plan is ordered by path and drawn from hashes of
paths, never `Math.random`. The town's reach and its land share move in
steps, so one file more or less leaves them, and every street steered
by them, where they were. Streets grow depth first, so a changed file
moves its own street and the ones grown after it on its island; adding
a file to `apps/spyglass/src/web/view` leaves nine in ten of spyglass's
buildings where they were (one to `packages/models/src/fal`, four in
five of models'), and every other island untouched.

## How it's built

These follow the folder's rendering principles (`AGENTS.md`):

- The town is laid out on the CPU when the chart changes
  (world-plan.ts, the world plan of WORLD.md layer 1): the streets, the
  lots, the buildings and the edge. The frame only draws it.
- Streets are painted into a baked map so the terrain draws them with
  no extra geometry: tarmac, the white edge lines, the plots' ground
  under houses. Poles, buildings, walls and vending machines are
  instanced 3D parts (town-draw.ts).
- A building is a few instanced parts from a small kit (a wall box, a
  hipped or gabled roof, a flat roof with a parapet, a balcony strip, an
  outside stair, a corridor), all at the one human scale. Doors, windows
  and balcony rails are painted on in the fragment shader at a fixed
  size, never scaled.
- Every building, pole and street stands on the baked ground and is lit
  by the light map, the sun, the sky and its own ground shadow.
- Picking reads the town's buildings, not `Module.at`, since the town is
  replanned. The files map (a baked disc for each module at its chart
  position) and anything else built on `Module.at` has to follow the
  town's lots or go.
- Wires are routed on the CPU along the street tree when the chart
  changes, and drawn as instanced segments between poles, sagging in a
  curve, so they cost the frame no searching.
- Layout is deterministic: the same chart gives the same town.

## Order of work

1. The town plan: the street tree from the folders fitted to the land,
   drawn as flat lines, to check that it reads as a town before any
   building goes up.
2. Detached houses and walk-up apartments along the streets, and
   picking moved onto them.
3. Apartment blocks and towers, so the imbalances show.
4. Test grounds beside the streets they test.
5. Poles, and the imports wired along them.
6. The other kinds: utilities, the store, public buildings,
   construction.
7. Vending machines, fields, the shrine, neighbourhood palettes.
8. The grounds performing.

## Decided

- **Replanned, not placed.** The town is planned from the folder tree to
  fit the island, and the files' chart positions are dropped. A tidy plan
  matters more than matching the source's placement.
- **Tests stand beside what they test**, as performance grounds, not
  homes and not a district of their own.
- **Imports are wired in**, along the streets.
