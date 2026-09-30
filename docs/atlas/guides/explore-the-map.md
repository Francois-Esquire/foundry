---
title: Explore the map
description: What the map shows, how to move around it, and what selecting a place reveals.
---

```sh
atlas serve /path/to/workspace
```

The viewer opens on the whole atlas. Distance expresses relationship, not
physical scale.

## What you are looking at

- **Islands are packages.** Islands sit in rows by dependency layer: the
  packages nothing depends on are furthest south, the foundations furthest
  north, and packages that depend on each other are drawn towards one
  another. An island's size grows with its file count.
- **Settlements are files.** Files are placed within their island by what
  they import and the concepts they share, so files that work together sit
  together. Marks differ for source, test, and story files.
- **Dependency is placement.** By default no lines are drawn between
  islands; the rows and the distances carry the relationship. Sea trade
  routes are an optional layer in the chart settings: switched on, they
  connect each package to its leading consumers, and a selected island
  shows its own trade instead. A selected file can trace its imports.
- **Districts are responsibilities.** Inside an island, files that the
  internal analysis groups under one responsibility share a region.

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
the map. A **Map layer** control switches the island lens between belonging
and files.

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
shows what the survey measured. Evidence is loaded when you ask for it, and
if the dataset changed since the map loaded, the panel asks you to reload.

## Chart settings

The **Chart settings** button opens the panel's **Chart** section. Every
optional layer is off by default: connecting land between related islands,
a road network over it, houses, forests, and sea trade routes. Boundary
overlays, topographic contours, water pigment, and a map filter such as
graphite or parchment are there too, with a **Reset visualization**. Water,
wind, and waves animate only when you press play, and a separate
**Decorative atmosphere** toggle in the header adds currents and coastlight.
Settings are not saved between visits.

Under a reduced-motion preference, the map paints still frames: focus jumps
instead of travelling, and playback stays paused.

## History

After a scan with `--history`, packages that existed at an earlier
checkpoint but are gone now appear as wrecks, listed in the panel's
**Wrecks** section. See [history](/atlas/guides/history).

## When the map will not open

The viewer needs WebGL. Without it, the map reports that it could not open
and **Find a place** still works. A missing dataset shows
`Could not load <file>. Run atlas scan to generate the dataset.`
