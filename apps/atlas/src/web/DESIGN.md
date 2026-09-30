---
name: Codebase Atlas
description: Foundry dependency geography rendered as a navigable paper atlas.
colors:
  paper: "#f1ead9"
  paper-edge: "#bba785"
  ink: "#4a4233"
  amber: "#875222"
  seawater: "#d5dbca"
  shallows: "#c3cebd"
  ochre: "#efcf88"
  sage: "#b4d5a5"
  clay: "#edb59d"
  mineral-green: "#a3d6bc"
  sand: "#ead6a5"
  mauve: "#cab6df"
  lichen: "#d6dda0"
  index-active: "#dfd5bc"
typography:
  display:
    fontFamily: "AtlasDisplay, serif"
    fontSize: "46px"
    fontWeight: 400
    lineHeight: 1.02
    letterSpacing: "-0.025em"
  body:
    fontFamily: "AtlasBody, sans-serif"
---

# Codebase Atlas design

## Overview

This record applies only to `/atlas`. It does not define the documentation
site or Studio. The established direction is a paper atlas with mineral
pigments, engraved labels, amber ink and shallow relief. Exploration starts on
the map; search and architectural evidence open in optional paper drawers.

The implementation reads the existing semantic snapshot when Astro serves or
builds the page. Development reloads pick up regenerated survey and history data;
static deployments need a rebuild. Evidence checks the map's survey identity before
displaying. Live agents and historical playback are future work.

Initial load shows separate islands at the established positions. Connecting land,
roads, houses, forests, sea trade routes, topographic lines, all six boundary
overlays and decorative atmosphere start off. Current playback retains its existing
default. Features below are opt-in where noted.

The overview retains the older chart's dense file marks, pale sea, fine grid,
dark labels and layered coast ink while keeping today's relief and map-first
navigation. File marks give scale, not a new quality score.

When history data exists, package IDs observed at a completed checkpoint but
absent from the current survey appear as subdued submerged wrecks. The ledger
shows the last observed checkpoint, not a removal date. Selecting a wreck opens
an orbitable underwater 3D scene; it does not change the current survey or provide
historical playback. The brig rests among seabed rocks and scattered timbers, with
muted teal fog, suspended particles and faint shafts of light. The brig model is
CC0, with provenance in `public/atlas/MODEL.md`.

## Colors

Amber marks focus and navigation. Brown ink sits on warm paper. Desaturated
seawater and shallows separate the package territories. The seven mineral
pigments derive from stable package identifiers; colors can repeat and carry
no quality ranking. Package names provide identity alongside color. Muted
paper edges distinguish the raised land from the sea sheet.

Ocean pigment follows distance to the nearest land across all
territories. A 640-pixel longest-axis land mask feeds a separable Euclidean
distance field. Water blends subtly from pale sage `#dce0cf` to `#d5dbca`,
reaching full depth at 40 map units. The narrow brightness range avoids white
coastal halos. Nearby islands keep channels
lighter; holes and disconnected coasts contribute to the same field. Existing
shallows remain visible. This is geographic shading, not a semantic metric.

A convex hull spans the outermost coast points of all packages with 90-unit
padding, rebuilt after package settlement. Edges subdivide into segments of at
most 20 units before tangent-continuous Bezier rounding. A muted dashed line
marks that archipelago rim. The gradient uses the same curved mask.
Beyond it, the water darkens over 1100 units toward `#d1d6c5`, with a smooth curve
that eases in and out so the envelope does not read as a border. This gradient is independent of
individual coastal bands. It is a cartographic boundary, not a dependency claim.

Optional inner dashed convex hulls use 32-unit padding around dependency-connected groups
of two or more packages. Grouping unions positive analyzed module dependencies
with current workspace manifest dependencies, devDependencies, peerDependencies
and optionalDependencies. Either direction connects transitively; declared edges
retain their kind and affect grouping only, never module counts or trade weights.
Self-links do not connect packages, and weak-bridge filtering is not implemented.
Standalone islands have no group outline. Concave and convex outlines remain
available as optional overlays. Accessible coastal
pockets can contain unrelated islands without changing group membership.
Optional connecting land adds continuous sage ground within each group; isolated packages remain
offshore. Original package relief and local file geometry remain intact. The
combined continental and island coast drives water shading and sea contours.

## Typography

Local Abril Fatface is registered as `AtlasDisplay`; local regular Calibre as
`AtlasBody`. Both come from `packages/design/src/fonts` with font swapping.
The scene waits for their font loads before painting labels.

Abril Fatface sets the page title, section headings and territory names.
Calibre sets navigation, paths, counts and inspection text. Georgia marks
computed neighborhoods; italic Georgia sets the sea caption. Map typography is painted onto
a transparent ink texture on a parallel plane 0.02 map units above the raised
paper. Labels and routes remain continuous across relief and share the map's
tilt. Visible ink repaints at viewport resolution during pan, zoom and camera
travel, with device pixel ratio capped at two and texture dimensions limited by
the renderer. Label sizes remain bounded as the camera approaches.

## Layout

The atlas fills 100dvh with no permanent sidebar or outer gutter. A single
header row holds the breadcrumb, the map layer selector, Find a place, and the
map controls: zoom out, whole atlas, zoom in, decorative atmosphere, chart
settings, and the side panel toggle. The world below it holds the canvas, a thin
inset frame around the map, and one 360px paper side panel on the right with
Place, Find, Chart and, when history exists, Wrecks sections. Only one section
shows at a time; Place stays mounted so loaded evidence survives switching.
There is no bottom bar; the pointer readout lives in the Place section and in a
polite live region.

The painted sea extends well beyond the package chart. At wide zoom, panning can
move most of the archipelago out of frame while water still fills every edge.
Land and shallows use a separate chart-sized texture, while the grid redraws at
viewport resolution, so the larger sea does not soften close detail. The opening
overview keeps the full archipelago visible on desktop; narrow screens retain
their closer, pannable crop.

From 1100px the canvas makes room for the open panel; below that the panel
overlays the map. At 760px and below, the header keeps the breadcrumb and a
Menu button whose dropdown lists the layer selector and every control with a
label, and the open panel covers the whole map area until closed.
Narrow viewports start on a centered, closer crop of the chart so islands and
their marks remain legible; pan and zoom still reach the full atlas.

## Elevation & Depth

Three.js uses an orthographic camera with a fixed 0.7-radian tilt. Coastlines
remain unchanged while a triangulated surface rises from a 0.4-unit shoreline.
A Gaussian file-density field with 22-unit bandwidth controls height, bounded
below 18 additional units. Smooth coastal taper spans 28 units. Analytic slope
normals smooth the lighting across triangles. There are no stacked contours.
Height means concentration, never quality or activity. File placement stays fixed.
Cartographic ink stays on its original overlay plane, rendered above terrain.

Source settlements retain brown ink. Tests use blue walled proving grounds;
stories use rose semicircular theaters; configuration uses ochre buildings.
Unknown kinds stay neutral. These marks preserve mixed neighborhoods rather
than splitting islands by classification. Finer source
roles remain unclassified. File specks remain visible across every island at
overview, recede to 20% as regions take focus, then give way to full file marks
between 3 and 5 pixels per map unit. File marks stay visible at closer zoom.

Matte solid pigments use roughness 0.96 without grain, bump maps or hatching.
The 90-unit coordinate grid is mapped onto the displaced terrain through world
coordinates, so it bends with slopes. Coastal trade adds raised ports and dashed
sea routes; file and declaration connections require an explicit trace.

Engraved topography is generated once per scene from existing height and distance
fields. Land levels at 3, 6, 9, 12 and 15 units use two-unit sampling; their ink
projects at the corresponding elevation. Seven coastal rings sit 2, 3.5, 5.5, 8,
11.5, 15.5 and 20 units from land. Seven outer rings sit 3, 4.5, 6.5, 9.5, 13, 17
and 22 units beyond the archipelago rim. Their spacing increases and ink fades
outward; the coastal reach stays capped at 20 units. A finer 1280-pixel distance
mask resolves the close rings. These sea lines express
proximity, not measured bathymetry. The palette and coastlines remain unchanged.

Major lines show at overview. Intermediate lines fade in from 1.1 to 2.3 pixels
per map unit. Land ink is warm brown; sea ink is muted teal. Contours are solid,
with slightly stronger major lines; boundaries and dependencies retain dashes.
Three-pixel crowding suppression and four-pixel label clearance protect reading.

Neutral ambient fill and a warm directional light illuminate the paper. Raised
land casts soft shadows onto the sea sheet. The static shadow map is generated
once and cached. The overview current animates the sea material at at most 30 fps.
The full-screen sheet has no outer border or CSS shadow. Paper drawers and the
selected-place inspector use `0 8px 26px #584a3328` to separate them from the map.

The hit plane follows the raised paper height. Scene teardown releases both
canvas textures, all materials and geometries, the light's
shadow resources, controls and renderer.

Decorative coastlight follows projected coastline contours on a transparent
canvas above the scene, including holes and disconnected islands. Warm amber
strokes soften outward. The layer ignores pointer input and stays below the
fixed margin controls. The same bounded clock updates the sea shader. Atmosphere
fades between 0.8 and 2.8 CSS pixels per map unit. Reduced motion uses a static
composition. Hidden tabs and offscreen maps cancel pending wind and animation. Teardown
removes the canvas, timers, frames, visibility listeners and observer.

## Shapes

The sheet and controls use square edges; search swatches are small circles.
Files appear as tiny rectangular settlements, with a ring around the selected
file. Density contours form irregular coastlines, shallows and hills, including
holes and disconnected islands.

Package radius follows file population's square root. Dependency layers guide
north/south placement; module-import counts influence package attraction.
Directory-derived anchors and actual imports arrange files, with the original
collision pass and density
thresholds of 0.18, 0.5 and 1.8. No coastline noise, connection-modulated threshold,
landmark solver or final point packing remains.

After the package force layout, padded group hulls and standalone islands act as
collision bodies. The group with the largest sum of squared package radii keeps
its hull's bounding-box center pinned at the origin. Other groups occupy evenly
spaced angular slots with a stable identifier-based phase, at hull-support distance
plus 90 units. Separating-axis resolution moves those groups toward the selected
island clearance, default 45 units, without pushing the main group. Symmetric map
bounds preserve its center.
Relative positions within each group, coastline shapes and local file geometry
stay fixed. Trade routes and ports use the settled world positions.

Singletons then try exterior-accessible pockets inside the main convex hull and
outside its concave footprint. A 4-unit grid combines original package coastlines
with shortest center-distance spanning-tree corridors of 12-unit half-width.
These corridors construct geography, not dependency routes. Dilation by 120 units,
erosion by 120 minus the coastal buffer and exterior flood fill close narrow gaps
and enclosed holes. The default buffer is 32 units.
Every multi-package group receives this concave outline.

Pocket access must accommodate the singleton's padded-hull bounding circle,
the selected island clearance and a two-cell sampling guard. Inside-pocket
candidates come first, then accessible water nearest a pocket mouth within the
padded island radius plus 120 units. Main-center distance and coordinates break
ties; other groups must retain the selected clearance. With no safe candidate,
the singleton keeps its initial exterior position. Original coastlines and local
file geometry remain unchanged.

Computed neighborhoods remain available for inspection and labels but do not
control file placement. Local file spacing retains the original behavior,
without the later file-clearance guarantee. Coordinates and contours
remain disposable presentation data; temporal stability is not guaranteed.

## Components

- Experimental layers in Chart settings offers Connecting land, Road network,
  Houses, Forests and Sea trade routes, all off initially. Roads and forests
  require connecting land. Layer changes rebuild rendering and coast masks at the
  exact existing island positions; camera, playback and preferences survive while
  selection clears. Reset visualization turns every experimental layer, boundary,
  topographic line and decorative atmosphere off.
- When enabled, continental ground shares the paper material and persists through focus repaints.
  Deterministic physical forest groves leave shore, settlement, label and overview
  trace clearances. Pitched-roof settlements use villages below 40 files, towns
  from 40 and cities from 300. Their bounded building counts express package scale,
  not individual files. Buildings fit original land with roof clearance.
  Trees and settlement props fade between 1.1 and 2.9 pixels per world unit and
  disappear during internal inspection; continental ground remains.
- Optional sea trade shows the six largest consumer packages by total module dependencies,
  each linked to its strongest supplier. Island selection shows its six strongest
  incoming or outgoing trades. Fine static dashed routes vary slightly in width
  with module-edge counts. Dashes measure arc distance from the nearer endpoint
  so both harbor approaches start with ink. Direction is stated in Trading
  partners, not animated.
- Ports follow the participating consumer and resource file endpoints. Missing
  endpoints fall back to package geography, disclosed in Trading partners.
  Routing retains the original package-coast masks. Exterior-water flood fill
  excludes those islands and enclosed water. Coast-distance
  regions share a cell-edge vertex graph, with the bounded map edge supplying
  an outside region. Ports join their nearest visible vertices in a common
  component. A lane is one continuous curve: across open water it is a
  single gentle arc between the two harbors, tried at increasing bulges until
  every sample keeps its clearance. Where land blocks every arc the route
  follows that graph, drops each waypoint a clear straight run can skip, and
  runs a spline through the corners that remain, tightening per segment until
  it clears. Lanes bend only where land forces them and never cross it. Same-continent relationships use persistent
  roads and suppress sea traces; an unavailable land route has no fallback through
  water. The inspector reports mapped-route availability or no safe mapped path,
  with consumer/resource endpoint counts; it does not label roads as sea routes.
  Three.js ports have raised paper-colored warehouses, amber pitched roofs,
  stone foundations, timber piers and a coastal beacon. Warehouse footprints
  must fit on land and clear other warehouse footprints; foundations span the
  sampled terrain heights. Resource ports use larger warehouses where they fit.
  Connected-package harbor props retire inland; offshore ports retain this treatment.
- When enabled, continental roads retain every routable measured package relationship, independent
  of the six-partner inspector limit. Stable anchors lie inside settlements.
  Dijkstra routing uses a 12-unit grid over the 4-unit land mask, with 10-unit
  shore clearance checked every 2 units. Distance and slope determine cost;
  shared edges cost 0.55 times their distance to encourage common roads.
  Merged edges accumulate module weights; width follows that evidence. Shared runs
  use 64 constrained midpoint-relaxation passes within 36 units of the original
  corridor, rejecting local height-variation increases above 0.12. Three corner-cutting
  subdivisions follow; every accepted segment retains land clearance. Junctions
  and settlement terminals stay fixed, including degree-two terminals. No random
  displacement is added; straight stretches and angular junctions can remain.
  Ochre roads follow terrain height. Forests and buildings clear the rendered
  curves. Opacity decreases with zoom.
  Declared-only dependencies add no roads or weights; file roads and terrain
  grading remain unimplemented.
- Internal exploration hides roads, ports and sea traces. Routes do not animate.
- Trading partners starts collapsed in the selected-island inspector, scrolls
  within 26vh, and uses native disclosures and buttons. Imports from and Supplies
  state direction; partner visits and exact consumer/resource file paths provide
  keyboard navigation. Internal-place and file focus hide trade routes and this
  disclosure. The [trade contract](../../../../docs/designs/codebase-atlas-trade.md)
  separates this implementation from future trade behavior.
- Selecting an island automatically loads basic belonging evidence. Selecting a
  file loads its composition even while the evidence drawer is closed. Evidence &
  alternatives opens the detailed V13.3–V13.5 inspection. The source-module index and map selection share the same
  selected file. Scope groups expose declaration roles and measured consumers;
  shared infrastructure and composition junctions are not treated as defects.
- Close zoom unfolds a local declaration drawing inside the existing coast.
  Rows and Compact clusters offer two arrangements of the same membership;
  switching arrangement resets tracing progress without proposing a source change.
  Independent scope-group layout precedes a separate land/clearance fit. Unplaced
  declarations remain listed with an explicit display-capacity count. This is
  experimental per-file detail, not a new district layout. Cursor-directed zoom
  is enabled; the existing reduced-motion camera behavior remains in effect.
- Scenario families retain the current baseline, individual effects and certainty,
  required companions, blockers, and preservation requirements. A tracing slider
  reveals outlined copies without removing the current drawing; target positions
  are an illustrative local decomposition, never invented destination modules.
  Scenario IDs and exact affected declarations remain inspectable in the margin.
  Review lookup uses both the scenario ID and family identity because IDs can repeat
  across families. See the [V13 work log](../../../../docs/designs/codebase-atlas-v13.md)
  for the verification record and experiment limits.
- District relationships can be inspected independently of files. Selecting a
  relationship frames both sets of members. Teal retains current affected-consumer
  connections beneath amber proposed connections, capped at 64 per layer with
  totals disclosed. Open endpoints denote proposed responsibility surfaces, not
  fabricated modules. File redirects and collapsed-indirection targets retain
  their actual mapped identities. The current-arrangement option preserves the
  baseline relationship drawing.
- The compass hit region and the header Chart settings button open the side
  panel on its Chart section. Escape closes the panel's Find, Chart and Wrecks
  sections, or collapses evidence, before changing selection, and returns focus
  to the header button that opened it. Controls use native sliders, selects and
  buttons.
- The collapsed Display boundaries section contains Coastal buffer, 0–64 in steps of
  4, default 32, and Island clearance, 8–80 in steps of 1, default 45. Changes wait
  300ms before rebuilding layout, boundaries, scene, water and routes from original
  data. Package world positions and connecting ground change; original relief and
  local file geometry stay fixed. Repeated edits do not accumulate drift.
  Camera target and world scale, visual preferences, the open drawer and independent
  playback clocks, pause states and speed survive. Selection and architectural
  inspection clear. Reset layout restores only these two controls; Reset visualization
  restores all chart settings.
- Six independent boundary checkboxes have
  stroke swatches: Atlas hull, Group hulls, Landmass outlines, Coastal pockets,
  Package clearance and Coastlines. All six start hidden. Geometry is computed
  once per scene; toggles repaint viewport ink
  immediately without changing placement or the ocean pigment. Package clearance
  shows 32-unit padded hulls; Coastlines retains every original ring. Pocket rings
  show potential space, not a guarantee that an island fits. Checkboxes and focus
  use amber.
- The master timeline supports play, pause, speed and explicit seeking. Current,
  Wind and Waves each have a local clock and independent pause. Global resume
  preserves track pause states; a seek realigns every track and pauses playback.
  Reduced motion keeps the composition static but permits seeking. Reset restores
  parameters, playback speed, track states and time zero. Nothing is persisted.
- Wind direction is a bearing toward which water travels. Two precomputed coastal
  wind bases mix with the dependency field. The Wind clock moves a fine ripple
  pattern; pausing it does not remove steady wind force. Wave arrival times follow
  water paths, slow in shallows and use upwind shelter to reduce lee-side crests.
  This is a lightweight wavefront approximation, not a flooding simulation.
- Settings expose wind direction/strength; current speed and dependency/wind
  influence; wave amount, wavelength and strength; water contrast and topographic
  lines. Only wind-direction changes rebuild arrival times, debounced 180 ms.
  Contour changes repaint ink; other controls update shader uniforms.

- The header pairs an Atlas/island/district/responsibility/file breadcrumb with a Belonging/Files
  selector, Find a place, and the map controls. Belonging is the initial layer. Search lists
  islands at overview, districts within an island, responsibilities within an
  entered district, and exact members of an entered responsibility. A typed query
  also finds files within the current island or district. Direct file selection
  recovers available ancestry; shared files retain the entered parent when valid.
  Choosing a result switches the panel to Place and focuses that tab.
  Escape closes search first; empty searches report no matches.
- Selecting an island frames graph-derived composite districts. Recorded module
  edges and symbol flow determine grouping; displayed coordinates do not. Each
  district takes its name from its most connected responsibility and marks an
  anchor with an inspectable connectivity reason. Independent responsibilities
  and unresolved belonging remain searchable collections without district washes.
- Entering a district exposes only its responsibilities; entering a responsibility
  exposes its exact files. Parent outlines and anchors remain, with neighboring
  district contours as passive context. Hover previews the eligible child after
  90ms dwell, strengthens ink over 180ms, and never enters it. Entry reveals child
  ink over 240ms. Reduced motion makes both ink transitions immediate.
- Responsibility footprints union compact influence fields around displayed member
  coordinates and clip to existing land, including holes, and the entered district.
  Exact outlier marks retain members beyond that district outline. Disconnected
  patches share identity and pigment; enclosed nonmembers remain nonmembers.
  Broken outlines mark unresolved belonging without assigning files to a candidate.
  Neither footprints nor evidence change the coastline. The inspector retains
  Frame members, Browse members, Evidence & alternatives, and Trace imports.
- Architectural focus uses the same footprint treatment for matched members,
  related and unresolved files, and file endpoints in relationship previews.
  Exact evidence identities determine these marks. Composition progressively
  replaces the footprint at close zoom; proposed tracing retains its baseline.
- Selecting a file frames its settlement and reports incoming and outgoing import
  counts. Trace imports explicitly reveals recorded connections; changing selection
  clears that trace. Belonging loading, retry, and survey-mismatch messages appear
  in the inspector; composition has its own retry in the evidence drawer.
- Drag pans; wheel or pinch zooms. Named zoom buttons provide another control.
  Open-water clicks leave the overview alone; from an island they return to the
  opening chart frame.
  Breadcrumbs return to the named ancestor. Escape closes the panel's search,
  chart or wrecks section, or collapses evidence, first, then leaves one level:
  file, responsibility, district, island, overview. The Atlas breadcrumb, Clear selection and Whole atlas restore the
  overview. Zoom preserves entered ancestry. Selection moves
  the camera over 650ms; reduced-motion preference makes that move immediate.
- Keyboard users select islands, regions and files through search. Inputs have labels,
  controls have accessible names, focus uses a 2px amber outline, and inspection
  updates use a polite live region. Search remains usable if WebGL fails to
  initialize. Without JavaScript, the page links to the atlas guide; a missing
  survey produces an explanatory page.
- Hover and selection light the territory's coast. Leaving hover
  restores the selected territory's emphasis or fades the coastlight away.
  Reduced motion applies the same emphasis immediately and suppresses wind.
- A one-second pointer pause over clear water can trigger three curved engraved
  wind strokes. The gesture lasts 2.4 seconds, with a 12-second cooldown from its
  start. Placement checks coasts, shallows, labels, dependency routes, compass,
  sea caption and viewport edges; file detail suppresses wind. Camera movement
  cancels it. Neighborhood bustle remains a candidate.
- The sea current blends directed cross-package file imports into a prevailing
  vector and smooth local influences. Logarithmic edge counts weight influence;
  an obstacle-aware pressure solve redirects it around the actual coast masks.
  A 256-cell flow texture
  advects pigment in the ground material, leaving land and ink unchanged. No
  extra wave symbols remain. See the atmosphere spec for direction conventions.
- The independently controlled "Decorative atmosphere" toggle defaults off and
  exposes its state through `aria-pressed`. Scene initialization applies the
  latest toggle value after fonts load. Effects communicate exploration only,
  never agent activity or survey changes.
- Territory names lead the overview. Zooming near an island loads its Belonging
  regions without selecting it. Island clicks frame the region scale; further
  zoom reveals files. Belonging suppresses computed neighborhood
  labels on the selected island. District and responsibility names have a stable
  screen-area budget of two to six, with parent priority, collision and viewport
  checks. Hover preserves that label set. Collections have no map labels; child
  names retire as composition reaches half opacity while parent names remain.
  Selected responsibility members use 5px ink marks and 16px filenames. Ordinary
  file marks appear at 3–5 CSS pixels per map unit on every island in view. With
  composition loaded, declarations appear at 6–8 while file marks remain. File interaction enters at 4.2
  and exits below 3.6; declaration interaction enters at 7 and exits below 6.2.
  These separate thresholds prevent detail flicker. Ordinary file labels require 5;
  only the selected file's name remains while that file is in view. Selecting a
  group limits file labels to its members. Labels outside the view or
  colliding with earlier labels are omitted; crowded file names may stay hidden.
  Visible labels are selectable. Search retains omitted files and regions,
  and exact file paths remain available in the margin.
- File focus reaches 10 CSS pixels per map unit on every viewport; the close-up
  limit is 24. Resizing preserves selected-file detail. Ordinary names have a
  screen-area budget and prefer connected files. Relationship previews restrict
  names to their evidence, while unrelated marks recede. Composition names sit
  above the declaration drawing. Panning away restores the local file layer.
- File and declaration connections require an explicit trace action.
  Selecting a responsibility alone does not draw its entire dependency graph.
  Drawing explanations, map keys, and alternative comparisons start collapsed.

## Color controls

Chart settings → Appearance offers a water pigment picker and Original,
Treasure parchment, Graphite, and Faded pigments filters. Water pigment changes
the ground shader while preserving depth variation and motion. Filters apply to
the map alone, including land and ink, never the controls or drawers. Monochrome
treatments intentionally remove package color distinctions. Initial load and Reset
use water pigment `#c6e6e2`, RGB 198/230/226, and water contrast `0.3`.
Settings last only for the mounted atlas.

Filters are graded inside the render pipeline as the last stage, after
exposure and tone mapping, so occlusion and bloom never operate on an
already-tinted image. The CSS filter on the map element is the fallback: it
applies only when the pipeline is off or failed and the scene draws directly.

## Rendering pipeline

Chart settings → Rendering controls one pass graph shared by the chart and
wreck dives: scene → coastlight and wind overlay → ambient occlusion → indirect
light → bloom → exposure and tone mapping → grade. The defaults reproduce the
chart as drawn before the pipeline existed; every stage is a toggle so the
aesthetic stays under control. Quality tiers (Low, Medium, High) only trade resolution and filtering
for speed and never hide a control. **Off** is the direct draw: no passes, CSS
filter restored. If a device cannot compile the graph, the viewer falls back
to the direct draw on its own and the panel says so.

Occlusion on the chart is engraved rather than screen-space: the land
geometry carries a per-vertex concavity term computed from its own mesh
(valleys and the foot of hills, never ridges), and the paper material darkens
with it under the Occlusion strength control. It shades on the direct draw as
well, and it is the only occlusion the flat paper visibly receives, since the
screen-space term finds little to occlude in relief this shallow. In wreck
dives the screen-space stage is the real contribution. Its reach is a screen
size, in pixels, converted to world units each frame from the camera: on the
chart from the zoom, in a dive at the fog limit so the far seabed never falls
below what the sampler can resolve. Reaches under about eight pixels span a
texel or two of the half-resolution buffer and band across the tilted paper.
Indirect light (screen-space GI) needs a perspective camera, so it applies to
wreck dives and not the top-down chart.

Sliders are uniforms and change nothing in the graph; quality, toggles, tone
mapping, filter, and stage view rebuild it. Stage modules load on first use.
When the device reports GPU frame times, a sustained frame over budget steps
the tier down one level, never to Off, and the panel says so; choosing a
quality again clears the cap. The Show stage select replaces the image with a
single stage's output for tuning.

## Do's and Don'ts

The [internal architecture foundation](../../../../docs/designs/codebase-atlas-internals.md)
serves v13/v13.1/v13.2 evidence separately from the map. Architectural inspection
adds member rings, unresolved-ownership diamonds, path-disagreement notches, and
selected import links. Evidence and its limitations remain in the margin;
structural disagreement is not a quality score. It does not change current
neighborhoods or geometry. Later placement must consume geography without feeding
settlement coordinates back into coastline generation.

The [V13 work log](../../../../docs/designs/codebase-atlas-v13.md) tracks composition
and alternative studies. Its optional district arrangement changes drawing positions
only: semantic membership is planned first, then fitted into existing land with
clearance and capacity checks. Rendering, selection, and framing share those positions;
canonical file and symbol identities remain intact. Local declaration marks and their
tracing-paper copies are selectable. Role marks describe commons, junctions, mixed
scope, and unknown scope without implying quality. The V13 log records rendered
desktop, tablet, and mobile checks, including tracing and reduced motion.
Composition unfolds only when its swept area and marks fit on land. Near unsafe
coast geometry, or with reduced motion enabled, fitted marks fade without traveling.
The tracing slider retains baseline marks and fades unsafe proposed paths in place.

- Do keep labels in the map plane and inspection text in the fixed margin.
- Empty-map clicks clear selection and return to the overview.
  Panning and clicks on the compass or controls retain selection.
- Do preserve keyboard access, reduced motion, survey identity checks and evidence
  availability wording.
- Do distinguish generated geography from the canonical semantic dataset.
- Don't infer quality, live agent activity or physical scale from the map.
- Don't promise temporal stability, historical travel or live refresh from this
  snapshot implementation.
