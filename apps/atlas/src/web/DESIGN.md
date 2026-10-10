---
name: Codebase Atlas
description: Foundry dependency geography rendered as a navigable paper atlas.
colors:
  paper: "#f1ead9"
  paper-edge: "#bba785"
  seawater: "#d5dbca"
  shallows: "#c3cebd"
  selection: "#3b1e06"
  departure: "#681049"
  label: "#665e50"
  coast: "#7a6a50"
  hover: "#be8430"
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
site or Studio. The established direction is a paper chart whose inks follow
one ladder of strength, with district pigments for responsibilities, engraved
labels and shallow relief. Exploration starts on
the map; search and architectural evidence open in optional paper drawers.

The implementation reads the existing semantic snapshot when Astro serves or
builds the page. Development reloads pick up regenerated survey and history data;
static deployments need a rebuild. Evidence checks the map's survey identity before
displaying. Live agents and historical playback are future work.

Initial load shows separate islands at the established positions. Sea trade
routes, district streams, recorded change and topographic lines, the reader's
layers, start off; so do a developer session's connecting land, roads and six
boundary overlays. The chart is still: nothing animates on its own, and a frame
is drawn only when the view or what it shows changes. Features below are opt-in
where noted.

The overview retains the older chart's dense file marks, pale sage sea, fine grid,
dark labels and fine coast ink while keeping today's relief and map-first
navigation. File marks give scale, not a new quality score. Each package name is
set in Abril Fatface with its real file count beneath in small spaced capitals
("149 FILES"); the caption travels with the name through collision and projection.

When history data exists, package IDs observed at a completed checkpoint but
absent from the current survey appear as subdued submerged wrecks. The ledger
shows the last observed checkpoint, not a removal date. Selecting a wreck opens
an orbitable underwater 3D scene; it does not change the current survey or provide
historical playback. The brig rests among seabed rocks and scattered timbers, with
muted teal fog, suspended particles and faint shafts of light. The brig model is
CC0, with provenance in `public/atlas/MODEL.md`.

## Colors

Every colour comes from the ink ladder (`scene/ink-ladder.ts`), which sets how
strongly each kind of mark is drawn as luminance contrast against the land
(`#f1ead9`) or the sea (`#d5dbca`), measured in linear light as the renderer
blends, strongest first: the selection, a deep amber-brown (12.7:1 on land,
10.8:1 on sea); departures, magenta, with a notched ring and a dash-dot line
as a second cue (4.2b draws them); file marks (6.4–7.9:1); labels
(5.0–5.3:1); the coast (1.9–2.9:1); relief (at most 1.35:1, the steepest
shade 1.26:1); and sea lines (at most 1.15:1). Once an island is entered the
selected island's ring steps down to the file rung at one pixel. The same
module holds the one table of hue, dash, and weight that says what each line,
fill, and text means, and the map key reads it. Hover is a mid amber, solid,
apart from both the coast rule and the selection. Islands carry no package
hue: the land is paper, pigment marks responsibilities only, and a package is
told apart by its coast and its name. Muted paper edges distinguish the
raised land from the sea sheet.

Ocean pigment follows distance to the nearest land across all
territories. A 1280-pixel longest-axis land mask feeds a separable Euclidean
distance field. The sea is layered: it steps one shade deeper and slightly
cooler at 6, 14, 26, 42, 64 and 92 map units offshore, from pale sage
`#dfe3d3` at the shore to `#c7d2c7` in open water. Each step is a soft
four-unit wash, never a line. Because the layers are offsets of every coast,
close islands merge into shared lobes. Holes and disconnected coasts contribute
to the same field. Shallows are the lightest water, `#e3e6d7`. This is
geographic shading, not a semantic metric.

Gilded ripples echo each coast at 2.4, 4.8 and 7.6 map units offshore. They
are contours of the same shore-distance field, built once, inked with the
coast's seeded pen pressure and broken where the pen lifts. At 16%, 11% and 7%
opacity they surface only as the camera comes in and are absent at overview.

A convex hull spans the outermost coast points of all packages with 110-unit
padding, rebuilt after package settlement. The rim is smoothed in polar form
about the hull's centre over 180 angles: a moving maximum of the radius across
±18° only moves it outward, then a triangular moving average across the same
window bends long straight sides into broad arcs. Every averaged radius covers
the hull's own radius at that angle, so the rim always contains the padded hull
(over 100 units clear of every coast on the reference atlas). Segments of at
most 20 units then join with tangent-continuous Bezier rounding. A muted dashed
line marks that
archipelago rim when the outer boundary is shown, and the sea uses the same
curved mask. Beyond it, open water continues the coastal layering: soft steps at
14, 80, 170, 280, 410 and 560 units, each a 20-unit wash, carry the deep water
toward a slightly darker ocean blue `#b4c4c5` at the chart's edges. The water is
the vignette: light at the centre of the archipelago, deepest at the margins,
a quiet base for type set on the sea. It is a cartographic boundary, not a
dependency claim.

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
offshore. Original relief and local file geometry remain intact. The
combined continental and island coast drives water shading and sea contours.

## Typography

Local Abril Fatface is registered as `AtlasDisplay`; local regular Inter as
`AtlasBody`. Both are bundled with the standalone viewer in `public/fonts`, with
font swapping and their licenses. The former design-package font paths no longer
exist; an unloaded family must not silently substitute the map typography.
The scene waits for their font loads before painting labels.

Abril Fatface sets the page title, section headings and territory names.
Inter sets navigation, paths, counts and inspection text. Georgia sets
responsibility and district names; italic Georgia sets the sea caption. Map
typography is painted onto a transparent ink texture on a parallel plane 0.02 map units above the raised
paper. Labels and routes remain continuous across relief and share the map's
tilt. Visible ink repaints at viewport resolution during pan, zoom and camera
travel, with device pixel ratio capped at two and texture dimensions limited by
the renderer. Label sizes remain bounded as the camera approaches.

## Layout

The atlas fills 100dvh with no permanent sidebar or outer gutter. A single
header row holds the breadcrumb, the map layer selector, Find a place, and the
map controls: zoom out, whole atlas, zoom in, chart settings, and the side panel
toggle. The world below it holds the canvas, a thin
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
remain unchanged. Every island stands on a slight 0.45-unit lift above the
0.4-unit paper: a short vertical coast, the land tinted 22% toward earth,
gives the old-game raised rim without a cliff.

Interiors are natural lowland. Ground rounds over the beach (1 unit with a
four-unit falloff) and keeps rising gently inland (0.9 units with a 30-unit
falloff); both terms depend only on clearance from the coast, so nothing levels
into a table or shelf. Height above the lowland expresses usage, never quality,
churn or live activity. Only a package's high fan-in files raise summits: the
modules its internal topology gives the `high-fan-in` role, read from the
`file-roles` lens (the same rule as structural landmarks). A module's internal
fan-in is the number of the package's own source modules that import it, and the cutoff is
the topology's saved one: the larger of 3 and the 90th percentile among the
package's modules with any dependent. Imports from other packages and from tests
do not count, and a package saved without internals raises none. A summit's
height is 1.8 × log₂((1 + internal fan-in) / cutoff); its rounded foot reaches
10 + 4 × height units.
Neighbouring summits join through a soft maximum, so a cluster of heavily used
files forms one range rather than stacked needles, and summits fade over ten
units toward the shore. Ordinary files never raise their own ground.
The field is sampled once on a fixed three-unit grid and interpolated cubically;
the fixed three-unit mesh does not change with zoom. Normals use a three-unit
span to keep the relief term continuous. Commons and junction roles remain in Place
and do not change the terrain when their evidence arrives. File placement and
coastline XY stay fixed. No terrain noise, peak icons or activity elevation are added.

Every coast carries a gilt rule just inside the shore, framed by a fine inner
ink hairline, then a hand-inked coastline whose pen swells and thins along the
shore. Pen pressure is seeded from the territory and arc length, so it is
identical on every repaint; runs are grouped into four weights and stroked once
per weight. All coast ink is clipped inside the shore so it drapes on the raised
land; nothing is left on the flat sea plane to ghost across a far-side coast.
Selection is the ladder's strongest ink. A selected island is ringed by a line
five map units offshore of its own coast (a contour of a per-island distance
field, built once per island), and curves in the same ink lead to its package
dependencies: dashed to the
packages it imports from, dotted from the packages that import it, each ending
in a small bead at the other package. Weight follows module imports between the
pair (`dependencyPen`). Lines run between the nearest shores with a gentle bow,
pass beneath other islands as sea-only ink, and stop short of every place name.
They appear only while a package is selected. All of this ink is repainted at
viewport resolution. Shallows in the fixed-resolution coast
texture are feathered so they magnify as a soft depth change, never as
stair-stepped texels.

Cartographic ink and pointer hits share the displaced relief mesh. Lettering
uses raised anchors on a separate overlay so glyphs remain undistorted; label
collision and hit bounds use those projected positions. File label heights are
cached per immutable terrain field and file position, so camera movement does
not resample terrain for every label. Sea ink remains flat. Terrain pointer
hits use an eight-unit grid of projected mesh triangles for the fixed camera,
then exact barycentric intersection within the relevant bin. The index rebuilds
only when that terrain changes; it does not approximate the picked surface.

Terrain, contour ink and picking are built once from the initial survey.
Zoom and late-arriving package evidence never replace the land beneath the ink.
There are no browser workers or alternate terrain variants. Camera and
detail-reveal changes share one map repaint per display frame. Viewport-resolution
ink uses linear sampling without rebuilding mipmaps on each upload.

Source settlements retain brown ink. Tests use blue walled proving grounds;
stories use rose semicircular theaters; configuration uses ochre buildings.
Unknown kinds stay neutral. These marks preserve mixed areas of an island rather
than splitting islands by classification. Finer source
roles remain unclassified. File specks are round dots, one per file, that grow
gently with zoom (radius 1.45 / √pixels map units) and are filled once per kind.
They stay at full strength across every island, regions or not, then give way
to full file marks between 3 and 5 pixels per map unit. File marks
stay visible at closer zoom.

The land is plain paper, with no package wash. The coordinate grid uses 90-unit
major lines and 18-unit subdivisions, which fade in at 30–60 pixels of spacing.
On land the grid is printed in world coordinates on the displaced mesh, so lines
bend with the relief. Derivative antialiasing keeps the ink fine.
The sea grid stops at land, preventing a second flat line across a hill. Land
and sea share one graticule ink. Atlas references label each major cell:
lettered columns along the top margin and numbered rows down the left, counted
from the chart's own corner so a place keeps its reference at every zoom. They
are printed on the lettering overlay and are not map labels: they take no part
in collision or announcements.
File and declaration connections still require an explicit trace.

Engraved topography is generated from the current height and distance fields.
Land levels at 2, 4, 6 and 8 units use one-unit sampling; their ink follows
the mesh. Land contours are built once with the survey terrain. Seven coastal rings sit 2, 3.5, 5.5, 8,
11.5, 15.5 and 20 units from land. Seven outer rings sit 3, 4.5, 6.5, 9.5, 13, 17
and 22 units beyond the archipelago rim. Their spacing increases and ink fades
outward; the coastal reach stays capped at 20 units. A finer 1280-pixel distance
mask resolves the close rings. These sea lines express
proximity, not measured bathymetry. The palette and coastlines remain unchanged.

Major lines show at overview. Intermediate lines fade in from 1.1 to 2.3 pixels
per map unit. Land ink is warm brown; sea ink is muted teal. Contours are solid,
with slightly stronger major lines; boundaries and dependencies retain dashes.
Three-pixel crowding suppression and four-pixel label clearance protect reading.

The island paper is unlit: its colour is its own, and relief is one term in it.
Slopes turned from a north-west light, and each vertex's concavity, multiply
the paper's linear colour by 1 minus at most 0.22, the ladder's relief cap, so
the steepest shade just clears the relief rung and is never darker than a file
mark. There are no hachures. The sea and the coast walls still take the
scene's ambient fill (1.23) and warm directional light (3.16), balanced so
level ground renders at its own colour. Nothing on the chart casts a shadow, so
the scene keeps no shadow map. The sea is the painted sea sheet under the shared paper surface,
thinned over wrecks as the camera comes in; it does not move.
The full-screen sheet has no outer border or CSS shadow. Paper drawers and the
selected-place inspector use `0 8px 26px #584a3328` to separate them from the map.

Pointer rays intersect the relief for file and feature inspection; projected
lettering is tested first. Scene teardown releases the ink and lettering canvas
textures, all materials and geometries, the light's
shadow resources, controls and renderer.

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

Responsibilities are the only grouping inside an island. In the default
drawing they do not control file placement, which follows directories and
imports; when files are grouped by responsibility, `fitDistricts` places them
by district. Local file spacing retains the original behavior, without the
later file-clearance guarantee. Coordinates and contours
remain disposable presentation data; temporal stability is not guaranteed.

## Components

- Chart settings holds the reader's layers: Sea trade routes, District streams,
  Recorded change and Topographic lines, all off initially. Each draws data the
  scan measured, and each applies to the existing scene without rebuilding it.
  In a developer session (`?dev`, or the dev server) a Developer section follows:
  Connecting land and Road network, which draw package dependency a third and
  fourth time and rebuild the scene at the exact existing island positions,
  with roads requiring connecting land; Display boundaries; and Rendering.
  Camera and preferences survive a rebuild while selection clears. Reset
  visualization turns every layer, boundary and topographic line off.
- When enabled, continental ground (`scene/continent-ground.ts`) shares the paper
  material and persists through focus repaints.
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
  A harbor is where a lane meets the coast; nothing is built there.
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
  Ochre roads follow terrain height. Opacity decreases with zoom.
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
- Natural features draw an island's internal evidence on its own land, in
  island-local ink under the file marks. They need no connecting land. A
  file's structural evidence remains inspectable: shared commons, composition
  junctions, and high fan-in files, the `file-roles` lens's reading of the
  package's topology: imported by at least the package's saved cutoff of its own
  source modules. Roles arrive with the island's internals; the overview reads
  only fan-in, for relief.
  The rejected summit and crater stamps are removed. Every file retains its own
  visible mark and selection ring. Structural roles and consuming responsibilities
  remain in Place and its keyboard index. They shape the actual relief without
  adding icons. Every file mark remains visible on the surface.
  A module with unresolved belonging is a marsh: a patch of
  reed signs around the file, with up to two dotted drains following land
  routes part of the way toward the districts it could join. Reeds vary
  slightly in lean and spacing, with screen-space thinning and lower opacity
  on crowded islands. Drains appear at file scale; there is no blanket marsh
  wash. Every unresolved module remains in the feature index. Marsh draws with
  the districts and stays through file zoom, receding under composition.
  Marsh means undecided, not defective.
- District streams are an optional layer, off initially, under Experimental
  layers. Each recorded relationship between two responsibilities is one
  stream from a supplier file to the consumer's composition junction, or to
  its most depended-on consuming file when it has no junction. Width follows
  module edges; shared downstream runs accumulate their contributing module
  edges and draw once. Up close a stream thins to a pen line. Stronger
  relationships route first, with stable identity breaking ties. Tributaries
  sharing a consumer mouth prefer an existing downstream run at 0.45 of its
  remaining distance, approaching in its direction where land permits. Other
  rivers are obstacles, never false connections. One arc is preferred; a lazy
  three-unit land grid and constrained smoothing handle obstructed routes.
  Natural geometry is memoized from the package evidence on the browser thread,
  independently of camera movement. District routes are computed only when the
  streams layer is enabled. Grid-edge coast checks are cached per build.
  Every segment checks the coast, including holes and thin inlets.
  Detours longer than 1.7 times the independent land route are omitted.
  A confluence
  is an actual joining fork, not a ring around an isolated junction file.
  Place lists omitted relationships, distinguishing disconnected land,
  other rivers and unavailable endpoints. The routes are a deterministic
  drawing, not a hydraulic simulation or an exhaustive planar embedding.
  Streams aggregate at district level: selecting a
  responsibility still does not draw its file graph, and nothing animates.
  A small open spring sign marks a recorded supplier endpoint unless a structural file mark
  already marks it. Muted banks replace the bright casing around each line.
- A collapsed Map key sits on the paper at the lower left. It explains district streams, unresolved marsh, and structural relief without implying quality.
  Feature hover and selection report in Place and the polite live region.
  File inspection lists its structural role and measured consuming responsibilities. River
  inspection states import direction, module edges, contributing relationships
  on shared trunks and dominant crossing symbols. An independent, collapsed
  feature index provides the same destinations by keyboard, including streams
  while their optional layer is off. Selecting a feature adds only its focus
  ink; it does not enable streams, move a file or open a dependency trace.
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
  Camera target and world scale, visual preferences and the open drawer survive. Selection and architectural
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

- The header pairs an Atlas/island/district/responsibility/file breadcrumb with a Belonging/Files
  map layer selector (`mapLayer` in the map state), Find a place, and the map controls. Belonging is the initial layer. Search lists
  islands at overview, districts within an island, responsibilities within an
  entered district, and exact members of an entered responsibility. A typed query
  also finds files within the current island or district. Direct file selection
  recovers available ancestry; shared files retain the entered parent when valid.
  Choosing a result switches the panel to Place and focuses that tab.
  Escape closes search first; empty searches report no matches.
- Selecting an island frames its districts: the `responsibility-groups` lens's
  responsibility groups. Recorded module edges and symbol flow determine
  grouping; displayed coordinates do not. Each district takes its name from its
  most connected responsibility and marks an anchor, that responsibility's file
  with the highest internal fan-in, with an inspectable connectivity reason.
  Independent responsibilities and unresolved belonging remain searchable
  collections without district washes.
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
- Hovering an island inks its coast in amber, a fine line over a soft band at a
  constant screen width, drawn on the ink canvas after the map; it appears and goes
  with the pointer, without fading. Each repaint asks again which island lies under
  the resting pointer, so a zoom or camera move under a still pointer inks the
  island now beneath it. A selected island keeps its selection ring instead.
- Territory names lead the overview. Zooming near an island loads its Belonging
  regions without selecting it. Island clicks frame the region scale; further
  zoom reveals files. An island shows no grouping until its Belonging
  regions load; there are none for a package saved without internals.
  District and responsibility names have a stable
  screen-area budget of two to six, with parent priority, collision and viewport
  checks. Hover preserves that label set. Collections have no map labels; child
  names retire as composition reaches half opacity while parent names remain.
  Selected responsibility members use 5px ink marks and 17px filenames. Ordinary
  file marks appear at 3–5 CSS pixels per map unit on every island in view. With
  composition loaded, declarations appear at 6–8 while file marks remain. File interaction enters at 4.2
  and exits below 3.6; declaration interaction enters at 7 and exits below 6.2.
  These separate thresholds prevent detail flicker. Ordinary file labels require 5;
  only the selected file's name remains while that file is in view. Its 20px
  name takes placement priority, and its selection-ink ring has a paper knockout drawn
  above composition, so detail cannot erase the selected settlement. Selecting a
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

## Rendering pipeline

Chart settings → Developer → Rendering, in a developer session, controls one
pass graph shared by the chart and wreck dives: scene → ambient occlusion →
indirect light → bloom → exposure, tone mapping, saturation and vibrance. A
reader gets the default tier, which adapts down on a slow device. Quality tiers
trade resolution and filtering for speed. Off draws directly; shader failure also
falls back to direct draw and is disclosed in the panel. There are no map
filters.

Land is unlit paper whose relief is the one capped term above; concavity comes
from fixed-radius samples of the current terrain field. There are no
full-sheet fold bands or screen grain.
Fine fibers and faint broad stock variation are stationary world-coordinate
material texture, shared by land and sea. They fade when too small to resolve,
never distort geometry, and never encode activity. Material texture also works
in direct draw.

Recorded change evidence is optional, off initially. It reads the same survey's
`frequent-change` lens only when enabled, matched by exact workspace-relative
file path. Craters and volcanoes mark frequent change: files of the kinds
`lib`'s hotspots consider at or above the hotspot commit gate, among workspace
files of the same kind in the same history window. The lens carries the gate it
applied, each file's counts, and each package's history window, and Place
states them from there; no package report is read.
Recorded change is inspection evidence in Place and does not alter terrain.
The zoom-dependent crater cuts and role-based elevation boosts have been removed.
Counts, line additions/deletions, dates, percentile population, and complete or
partial Git history remain in Place. No history means no inferred count.
Bloom starts off so bright paper slopes retain their edges.

Sliders are uniforms and change nothing in the graph; quality, toggles, tone
mapping, and stage view rebuild it. Stage modules load on first use.
When the device reports GPU frame times, a sustained frame over budget steps
the tier down one level, never to Off, and the panel says so; choosing a
quality again clears the cap. A reader's chart runs Light, the default: the
paper's relief term and full-resolution ink, without screen-space occlusion;
the wreck dive never runs below Balanced, since its perspective view keeps
screen-space occlusion at every enabled tier;
Balanced, Full, and the occlusion stage preview retain that pass. Perspective
wreck views retain screen-space occlusion at every enabled tier. The Show stage select replaces the image with a
single stage's output for tuning.

## Do's and Don'ts

The [internal architecture foundation](../../../../docs/designs/codebase-atlas-internals.md)
serves v13/v13.1/v13.2 evidence separately from the map. Architectural inspection
adds member rings, unresolved-ownership diamonds, path-disagreement notches, and
selected import links. Evidence and its limitations remain in the margin;
structural disagreement is not a quality score. It does not change
responsibilities or geometry. Later placement must consume geography without feeding
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
