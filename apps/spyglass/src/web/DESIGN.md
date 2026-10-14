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
bar containing Spyglass, Legend, and Rendering. The bar is centered, capped at
480px on desktop, and sits 24px above the bottom safe area. Mobile uses 12px
side and bottom margins. Spyglass retains its wordmark; Legend and Rendering
use icons with text beside the selected icon and accessible button names. Grid column letters sit 18px from the top edge, and
row numbers sit 18px from the left edge, at every zoom. No header, sidebar, search,
Place panel, architectural inspection, import-tracing workflow, or wreck dive
is present. Map pan, zoom, island selection, and file focus remain renderer
interactions; they never open an inspection panel.

Each bottom bar button opens a modal bottom sheet. Native dialog behavior traps
focus and makes the map inert while a sheet is open. Close and Escape dismiss
the sheet and restore focus to its opening button. The sheet scrolls within
80 percent of the viewport, includes mobile safe-area padding, and respects
reduced motion. The Spyglass sheet is an empty starting point for future features.

Legend contains file-kind marks and the map's ink key. It is never painted over
the map. Rendering contains camera controls, the Files/Belonging layer choice,
all reader layers, connecting land and roads, layout and boundary controls,
and the entire rendering pipeline's controls and status. These controls are
available in ordinary sessions, without a developer query parameter.

Sheet changes do not rebuild the scene. Rendering settings configure the live
scene; geometry changes retain the camera and rebuild only after the existing
300ms layout debounce. Late readings and island internals still feed the map's
rendering without reintroducing inspection workflows.

The established paper, package pigments, original folder-anchored file
composition, force-settled connected islands, and irregular offshore placement
remain intact. Disconnected islands use seeded angles, angular separation,
varied offshore distances, and coast-aware clearance. Collections keep each
workspace's own composition and a separate archipelago.

The renderer retains all terrain, water, coast ink, grid, type, responsibility,
file, route, boundary, and pipeline implementations. This change replaces the
application chrome and deletes its former UI components and action handlers.
The analysis, CLI, saved datasets, and their public APIs remain separate.
