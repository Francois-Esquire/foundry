---
title: Explore the map
description: What the map shows, how to move around it, and what selecting a place reveals.
---

```sh
spyglass serve /path/to/workspace
```

The viewer opens on the whole spyglass. Position expresses dependency layer and
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
  the responsibilities its files serve. Each kind of file has its own ink:
  source, test, story, config, and other. At overview every file is a dot; closer in, test files
  are open boxes and stories half-discs, and the other kinds are small
  blocks.
- **The legend**, opened from the bottom bar, shows where north points, the
  file kinds, the lines for a selection and a coast, and departures with
  their totals. It explains each optional layer, drawn as the map draws it.
- **Departures are drawn with Routes.** A file, folder, or package used
  mostly from one other package (at least 60% of the modules that use it,
  counting its own package as one) departs: a magenta notched ring marks
  it, and a magenta dash-dot line runs from its folder to that package's
  coast. A package used by only one other package is marked once, as a
  whole. Lines are grouped by folder and target, ranked by how dominant
  the other package's use is, drawn only when at least two modules there
  use the place, and at most three run into one package; the legend says
  how many places depart and how many lines are drawn. While anything is
  selected, its own lines replace the departure lines. A departure is an
  observation, not a defect.
- **Folders show closer in.** On an entered island faint violet-grey lines
  part its folders, and their names stand in italics with a trailing slash
  ("web/"), so "lib/" the folder never reads as "lib" the district. Deeper
  folders' lines come in as you zoom closer.
- **Proximity shows closer in.** On an entered island a slate dotted tie
  runs from a file to its responsibility's folder when the file sits
  apart from it; a slate dashed tie joins two files in different folders
  that change together; and two slate arcs set apart, "( )", mark a folder
  whose files serve responsibilities that nothing relates. A few ties show
  on each island, and all of a selected file's.
- **Dependency is otherwise drawn on selection.** How far apart two
  islands sit means nothing. Selecting an island draws its imports and
  importers; sea trade routes are an optional layer in the chart settings:
  switched on, they connect each package to its leading consumers, and a
  selected island shows its own trade instead.
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

Drag to pan and scroll to zoom towards the cursor. The app bar's buttons
zoom in and out and return to the **Whole spyglass**. Clicking a place
selects it: a label, a file, a district, or the island itself. Hovering
previews. **Escape** backs out one level at a time: the file, then the
district, then the island.

## Chart settings

The app bar extending left from the compass holds zoom out, overview, zoom
in, and development FPS. The bottom bar holds the Belonging/Files map-mode
switch and the legend. These work without opening settings.

The top-right compass opens **Chart controls**, a tabbed sidebar with global **Reset visualization** above its controls.
**Map** shows measured layers. These each draw something the scan measured, and all start off: sea
trade routes between each package and its leading consumers, district
streams, recorded change, and topographic lines over the summits. Turning a
layer on or off moves no island. **Rendering** contains atmosphere controls for rim waves and cloud
shadows, which start on and carry no data. **Reset visualization** restores
the defaults. Settings are not saved between visits.

On the Vite development server, **Layers** contains connecting land and roads,
layout boundaries and spacing. **Rendering** also includes renderer quality
and lighting. **Stats** shows the live scene composition directly, without an accordion. FPS is always visible in the app
bar during development; clicking it opens the settings sidebar.
The FPS readout counts submitted map frames, so an idle map reads zero.
Production builds omit these tools; `?dev` cannot enable them.

Drag the sheet's handle down to dismiss it, or activate the handle, press
**Close**, click the backdrop, or press **Escape**. The sidebar closes with
its close button or **Escape** and leaves the map and app bar usable while
open. Both return focus to the control that opened them.

Under a reduced-motion preference, focus jumps instead of travelling, and
regions appear without fading in.

## History

After a scan with `--history`, packages that existed at an earlier
checkpoint but are gone now appear as wrecks. See
[history](/spyglass/guides/history).

## When the map will not open

The viewer needs WebGL. Without it, the map reports that it could not open. A missing dataset shows
`Could not load <file>. Run spyglass scan to generate the dataset.`
