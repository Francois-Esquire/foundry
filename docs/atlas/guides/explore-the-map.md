---
title: Explore the map
description: What the map shows, how to move around it, and what selecting a place reveals.
---

```sh
atlas serve /path/to/workspace
```

The viewer opens on the whole atlas. Position expresses dependency layer and
folder, not physical scale; how far apart two islands sit means nothing.

## What you are looking at

- **Islands are packages.** Islands sit in rows by dependency layer: the
  foundation, the packages that depend on no other, furthest south, and each
  layer that builds on the ones below it further north. The latitude scale
  in the right margin numbers the layers; a package the graph could not
  place sits with the foundation, and its caption says "no layer". Along a
  row, islands run west to east in folder order, so packages in one folder,
  such as `apps/` or `packages/`, sit side by side. Which packages depend on
  each other is drawn by the lines a selection shows, not by distance. An
  island's size grows with its file count.
- **Marks are files.** Files are placed within their island by folder:
  each folder takes a patch of its own, beside its sibling folders, so a
  package's `src` and `test` lie side by side. What files import does not
  move them. The colours drawn over an island closer in are its districts,
  the responsibilities its files serve; Place names a file's folder and,
  once the island is read, its district. Each kind of file has its own ink: source, test, story,
  config, and other. At overview every file is a dot; closer in, test files
  are open boxes and stories half-discs, and the other kinds are small
  blocks.
- **The legend** at the lower right is always open: where north points, the
  file kinds, the lines for a selection and a coast, and departures with
  their totals. Its **Map key** explains each optional layer, drawn as the
  map draws it.
- **Departures are drawn by default.** A file, folder, or package used
  mostly from one other package (at least 60% of the modules that use it,
  counting its own package as one) departs: a magenta notched ring marks
  it, and a magenta dash-dot line runs from its folder to that package's
  coast. A package used by only one other package is marked once, as a
  whole. Lines are grouped by folder and target, ranked by how dominant
  the other package's use is, drawn only when at least two modules there
  use the place, and at most three run into one package; the legend says
  how many places depart and how many lines are drawn. While anything is
  selected, its own lines replace the departure lines. Place says, for a
  selected file, symbol, or package, where it is used: "placement: departs
  toward …", "fits", "spread", or "used by no other package". A departure
  is an observation, not a defect.
- **Folders show closer in.** On an entered island faint violet-grey lines
  part its folders, and their names stand in italics with a trailing slash
  ("web/"), so "lib/" the folder never reads as "lib" the district. Deeper
  folders' lines come in as you zoom closer.
- **Proximity shows closer in.** On an entered island a slate dotted tie
  runs from a file to its responsibility's folder when the file sits
  apart from it; a slate dashed tie joins two files in different folders
  that change together; and two slate arcs set apart, "( )", mark a folder
  whose files serve responsibilities that nothing relates. A few ties show
  on each island, and all of a selected file's; Place lists the rest.
- **Place names how a place is nested and what domain it is in.** A file
  reads its folder and path region, an island its path regions and the
  strongest seams between them, the imports from one region into another.
  When the workspace declares domains, a place reads its domains, and a
  departure inside a domain reads as two: the placement departure, toward
  the package that uses it most, and the domain departure, how many of its
  consumers share its domains; or that it shares them with every consumer.
- **Dependency is otherwise drawn on selection.** How far apart two
  islands sit means nothing. Selecting an island draws its imports and
  importers; sea trade routes are an optional layer in the chart settings:
  switched on, they connect each package to its leading consumers, and a
  selected island shows its own trade instead. A selected file can trace
  its imports.
- **Districts are responsibilities.** Inside an island, files that the
  internal analysis groups under one responsibility share a region.
- **Natural features carry meaning.** A lake is a shared module that many
  responsibilities draw on. A marsh is a module the analysis could not
  place in one responsibility, with dotted drains toward the ones it could
  join. With **District streams** switched on in the chart settings, a
  stream is the imports from one responsibility into another, wider where
  there are more, and a ringed dot marks where streams meet at a
  composition junction. These describe roles, not quality.

Zoom reveals detail in steps. From the overview, islands are shapes with
labels. Closer, districts fade in. Closer still, individual files appear
with their names, and at the closest range a file's declarations can be
shown. Labels are budgeted to the viewport so they never overlap.

## Moving around

Drag to pan and scroll to zoom towards the cursor. Every control sits in
the header: buttons zoom in and out and return to the **Whole atlas**, and
a **Side panel** button opens the one panel that holds everything else. On
narrow screens the header collapses into a **Menu**. Clicking a place
selects it: a label, a file, a district, or the island itself. Hovering
previews. **Escape** backs out one level at a time: the panel's search,
chart, or evidence first, then the file, then the district, then the island.

**Find a place** opens the panel's **Find** section, a search that matches
island names, and, inside a selected island, its districts,
responsibilities, and file paths. It is the keyboard route to any place on
the map. A **Map layer** control switches the islands between belonging and
files.

## What selecting reveals

The panel's **Place** section describes the selection: a file's kind and
its incoming and outgoing import counts, or a region's member count, with
the place under the pointer noted beneath it. **Trading partners** lists what
the file imports from and what it supplies, with a **Visit** link to each.
**Trace imports** draws a dashed line for every import edge into or out of
the selected file; the lines follow real directed imports.

**Evidence & alternatives** expands the architectural evidence for the island
below the place:
its districts and how they relate, any file's composition by declaration and
who consumes each one, and, where the analysis found credible alternatives,
the scenarios it compared, their measured effects, what each preserves, and
the limits of the evidence. Nothing here is a recommendation; the panel
shows what the scan measured. Evidence is loaded when you ask for it, and
if a scan has replaced the dataset since the map loaded, the panel asks you
to reload Atlas.

## Chart settings

The **Chart settings** button opens the panel's **Chart** section. Its
**Layers** each draw something the scan measured, and all start off: sea
trade routes between each package and its leading consumers, district
streams, recorded change, and topographic lines over the summits. Turning a
layer on or off moves no island, and **Reset visualization** turns them all
off again. The chart is still: nothing on it moves unless you move the
view. Settings are not saved between visits.

Adding `?dev` to the address opens a developer session, with a
**Developer** section beneath the layers: connecting land and roads, which
draw package dependency again; the layout's boundaries and spacing; and the
renderer's quality, tone mapping, exposure, occlusion, bloom, and a stage
view.

Under a reduced-motion preference, focus jumps instead of travelling, and
regions appear without fading in.

## History

After a scan with `--history`, packages that existed at an earlier
checkpoint but are gone now appear as wrecks, listed in the panel's
**Wrecks** section. See [history](/atlas/guides/history).

## When the map will not open

The viewer needs WebGL. Without it, the map reports that it could not open
and **Find a place** still works. A missing dataset shows
`Could not load <file>. Run atlas scan to generate the dataset.`
