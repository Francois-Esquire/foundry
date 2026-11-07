---
name: Codebase Spyglass
description: Foundry dependency geography rendered as a navigable paper spyglass.
colors:
  paper: "#f1ead9"
  paper-edge: "#bba785"
  seawater: "#c8d1c3"
  shallows: "#c3cebd"
  selection: "#361b05"
  departure: "#681049"
  departure-line: "#5e0d42"
  label: "#665e50"
  coast: "#7a6a50"
  hover: "#be8430"
  index-active: "#dfd5bc"
typography:
  display:
    fontFamily: "SpyglassDisplay, serif"
    fontSize: "46px"
    fontWeight: 400
    lineHeight: 1.02
    letterSpacing: "-0.025em"
  body:
    fontFamily: "SpyglassBody, sans-serif"
---

# Codebase Spyglass design

The map is the product's starting point. It fills the viewport beneath a floating
bar containing Spyglass and Legend. The bar is centered, capped at 480px on
desktop, and sits 24px above the bottom safe area. Mobile uses 12px side and
bottom margins. Spyglass retains its wordmark; Legend uses an icon with text
and an accessible button name. Grid column letters sit 18px from the top edge,
and row numbers sit 18px from the left edge, at every zoom. The compass at the
top right opens Chart controls, a modeless sidebar. No header, search, Place
panel, architectural inspection, or import-tracing workflow is present. Map
pan, zoom, island selection, and file focus remain renderer interactions; they
never open an inspection panel.

Spyglass and Legend each open a modal bottom sheet. Native dialog behavior traps
focus and makes the map inert while a sheet is open. Close and Escape dismiss
the sheet and restore focus to its opening button. The sheet scrolls within
80 percent of the viewport, includes mobile safe-area padding, and respects
reduced motion. The Spyglass sheet is an empty starting point for future features.

Legend says what the map draws: islands are packages, shallow banks are shared
dependencies. It is never painted over the map. Chart controls holds Rendering
(the camera's angle and the sea's waves). Development builds add Stats (the
renderer's status and the map's composition, with update times) and the
frame-rate counter in the app bar; production builds omit them, and no query
parameter enables them.

Sheet changes do not reopen the map. Rendering settings reach the live map;
only a new spyglass opens it again, at the camera it had. Late readings feed the
labels without reintroducing inspection workflows.

## The renderer

The map is drawn by Islands, a WebGPU renderer kept as a synced copy in
`islands/` (owned by another repository; its README says how it is synced, and
nothing here edits it). The viewer reaches it through one bridge:

- `ui/` (React chrome, panels, sheets, settings) mounts `ui/islands-map.tsx`,
  which keeps the DOM labels and the chart chrome over the canvas;
- `islands-host/` is the bridge: `islands-api.ts` is the one module that
  imports the renderer and its dataset adapter, `chart.ts` reads the dataset
  into the adapter's inputs, and `map-view.ts` turns Islands' camera,
  `project`, `pixelsPerUnit` and `heightAt` into what the labels and chrome
  read (`InkView`), and Islands' picks into the viewer's selection;
- `islands/` is the renderer: WebGPU, its shaders and its camera, reached only
  through its API (`createIslands`, `select`, `frame`, `project`, events);
- the data side is `layout/load-spyglass.ts`, which lays the territories out
  from the dataset's map and keeps that map on the frame, and the adapter
  (`chartFromFoundry`, re-exported as `chartFromDataset`), which makes the
  Islands `Chart` from the same map, so the chart and the labels share
  coordinates.

The camera is held north-up (Islands' `turn: false`): the labels and the chart
chrome read the view unturned. A browser without WebGPU sees a message saying
so in place of the map.

## Dropped with the three.js scene

The three.js scene and everything only it used were removed when Islands
became the map. These viewer features have no Islands counterpart yet:

- trade routes (sea lanes and roads over connecting land);
- wrecks of retired packages and the wreck dive;
- the old weather and atmosphere: drifting foundation light, clouds, ring
  waves, sea ripples, ocean emanation and water optics (Islands keeps its own
  waves);
- contour lines and topography;
- the composition view: responsibility overlay, composition squares and
  scenario routes;
- sea stacks, seafloor features, the geology preview and terrain inspection,
  the screen-terrain clipmap, the SDF trial and connecting land;
- the belonging layer (regions, landmarks, marshes, streams, volcanoes for
  frequent change) and the Files/Belonging switch; Islands draws districts and
  per-file change its own way;
- chart marks: proximity ties, departures, declared-dependency crossings,
  selected-package dependency lines, traced imports, domain outlines, folder
  cuts and folder names, file role glyphs, the hover band, the in-scene
  graticule, coast ink and island pigments;
- the paper look and its post stages (occlusion, indirect light, selection
  outline, bloom, grading) with their Rendering controls;
- developer tools of the old scene: layer solo/hide and presets, boundary
  overlays, the landmass relayout sliders and the Map and Foundations panels;
- collections: the Islands chart is one workspace's map, so the viewer's
  commands (`spyglass`, `serve`, `export`) take one path, and a data root
  serving several workspaces (the library's `serve.collection`) is refused
  with a message. `scan` still reads a collection.

The analysis, saved datasets, and their public APIs are unchanged; the CLI
changed only in the viewer's commands taking one workspace.
