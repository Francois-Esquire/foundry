# Atlas trade and behavior

## Accepted direction

Atlas opens as islands at the current settled positions. Connecting land, roads,
houses, forests and sea trade routes remain available under Chart settings →
Experimental layers, all off by default. Roads and forests require connecting
land. Boundary diagnostics, topographic contours and decorative atmosphere also
start off; the existing water palette and current controls remain available.
Layer switches rebuild rendering, not placement, and preserve camera and playback.
Architectural selection clears. Reset visualization restores the island-only view.

Keep island shapes, local file positions, hierarchy and navigation UI. Make real
dependency relationships readable as coastal trade. A port represents existing
endpoint files; it does not establish a new architectural owner or move those files.

## First delivery: package trade

- At overview, rank consumer packages by total outgoing module dependencies and
  show the strongest supplier relationship for each of the first six consumers.
- Selecting an island shows its six strongest incident relationships, incoming or
  outgoing. Stable package IDs break ties. Self-links and zero-weight links do not trade.
- A supplier gets a coastal resource settlement; its consumer gets a harbor.
  Locate each beside the measured endpoint files, with a navigable sea approach.
  Missing file evidence falls back to package geography, explicitly in inspection.
- Engraved routes navigate around every island. No center-to-center curves through
  land. Route smoothing must preserve navigability. Unreachable ports do not get
  fabricated straight-line routes.
- Fine static dashed routes vary slightly in width with distinct module dependencies.
  The inspector states import direction. Curves are constrained by navigable
  water. The continuous strip and traveling crest were rejected and removed.
- Ports use raised Three.js warehouses, pitched roofs, foundations, quays and piers
  in the existing palette. Building footprints fit the land and avoid neighboring
  buildings; narrow approaches may support only piers. Buildings represent port
  roles, not individual files. Terrain and file positions remain untouched.
- No route animation, arrows, dot trains or flat settlement symbols.
- The selected-place inspector offers the same package destinations by keyboard.
  Exact counts and endpoint evidence remain available there. Internal exploration
  retires package-route emphasis rather than competing with file detail.

## Boundary navigation and grouping rings

Water is partitioned by distance to rasterized island coastlines. The bounded map
edge supplies an outside region so peripheral channels join. Shared cell edges
form a vertex graph. Routes attach existing ports to the nearest visible vertices
in a common graph component, traverse its edges, then enter the destination port.

Lanes are smooth curves again. The earlier rule kept every route within one grid
cell of the region boundary, which made lanes trace the outline of whatever lay
between two ports. Now open water takes a single arc between the harbors, tried
at increasing bulges until every sample keeps its clearance. Only when land
blocks every arc does the route fall back to the graph, and then line-of-sight
shortcutting removes every waypoint a clear straight run can skip before a
spline runs through the corners that remain. The spline tightens per segment
until it clears; a segment that never clears stays straight with rounded
corners. No lane crosses land, and unreachable ports still get no route.

The outer hull spans the outermost coast points of every package. Connected groups
of two or more packages receive their own enclosing hull, not a chain of bubbles.
Single packages remain independent islands without a group outline. Grouping unions
positive analyzed module dependencies with declared workspace dependencies from
current package manifests: dependencies, devDependencies, peerDependencies and
optionalDependencies. Either direction connects a group, transitively. Declared
edges retain their kind and never become fabricated module weights or trade routes.
Weak-bridge filtering is not part of this change.

After the existing package force layout, each group's padded hull becomes a collision
body. The largest body is centered and pinned at the origin. Other bodies occupy
angular slots around it, with a stable identifier-based phase and distance derived
from hull support, then separating-axis collision resolution retains 45-unit
clearance. Standalone islands participate as individual bodies. Movement preserves
relative positions within each group, coastline shapes and local file geometry.
Symmetric map bounds keep the main body centered. Overlap changes placement rather
than cutting holes in a landmass. The outer hull is rebuilt after settlement.

After exterior placement, singletons try open pockets inside the largest group's
convex hull but outside its concave footprint. The footprint rasterizes package
original coast rings and a shortest geometric spanning tree, then closes narrow gaps using a
120-unit dilation and erosion by 120 minus the coastal buffer on a 4-unit grid.
The default buffer remains 32. The tree connects the
geographic envelope; it does not claim dependency paths. Enclosed holes are filled.
This outline is computed for every multi-package group and now supports connecting terrain.

Pocket candidates must be reachable from exterior water by the whole padded island,
not just a point. A bounding circle reserves the selected island clearance plus
two grid cells of sampling margin. Inside-pocket candidates come first, then
reachable water nearest a pocket mouth, with center-distance and coordinate
tie-breaking. Every candidate is checked against other groups. The mouth search
extends at most the island's padded radius plus 120 units from a pocket; no safe
candidate retains the initial exterior position. Group membership never changes.

Chart settings → Display boundaries exposes atlas hull, group hulls, concave
landmass outlines, coastal pockets, package clearance and original coastlines.
All boundary layers start hidden. All layers are computed once
per scene and drawn as independently toggled ink, without rerunning placement.
Pocket outlines show potential coastal space, not a promise every island fits.

The same section has live Coastal buffer controls from 0 to 64 and Island clearance
from 8 to 80. Defaults remain 32 and 45. Lower settings admit more pocket placements.
Changes debounce for 300 ms, then rebuild geography and its dependent water, terrain
and routes from the original data without cumulative movement. Camera position,
world scale, visual preferences and independent playback clocks survive the rebuild.
Selection and architectural inspection clear. Reset layout changes only these two
parameters; Reset visualization also restores the other chart settings.

Hull padding is 90 world units for the entire map and 32 for each group. Short edge
subdivision limits inward rounding before tangent-continuous Bezier rendering.
Dashed routes recompute against the settled package geography.

## Continental ecosystem

Connected groups receive continuous sage-colored ground between their unchanged
package shapes. The envelope starts from original coast rings, not convex package
hulls. Zero buffer removes extra coastal padding at 4-unit raster resolution;
the rendered coast union also retains every original package polygon. This is not
an analytic, point-perfect silhouette. Isolated packages remain offshore islands.

Ground rises gently away from the sea and stays low beneath existing package terrain.
Ocean shading, wave masks and sea contours use the combined continental coast, so
new land no longer behaves as water. Focus repaints retain that same ground.

Overview settlements use instanced pitched-roof buildings: villages below 40 files,
towns from 40, cities from 300. Geometry limits their footprint and building count;
these are scale metaphors, not one building per file. Deterministic forest groves
occupy connecting ground, leaving shore, settlement, label and overview-route clearances.
Props fade between 1.1 and 2.9 pixels per world unit and retire during internal
inspection. Existing districts and file exploration keep their original geometry.

Connected-package harbor props retire inland. Continental dependencies now use
the persistent road network below. Sea routing remains separate.

## Persistent continental roads

Measured package dependencies route between stable settlement anchors inside their
original package coasts. Every routable measured relationship contributes, independent
of the inspector's six-partner limit. Declared-only dependencies still establish
landmass membership but do not acquire invented module counts or roads.

Dijkstra search uses a 12-unit grid over the continental land mask. Distance and
elevation change determine cost; previously used edges receive a 0.55 distance
multiplier so later roads can join established corridors. Dependencies process by
descending measured weight, with stable IDs breaking ties. The result is deterministic
for the same input, not a globally optimal transport network.

Segments reserve shoreline clearance and sample their full length. Unreachable
same-continent endpoints remain unrouted rather than escaping through water.
Shared edges render once; accumulated dependency weight controls road width.
Shared runs relax within 36 units of their original corridor before three passes
of corner-cutting subdivision. Relaxation reduces bends without accepting a local
grade increase above 0.12 height units per step. Every resulting segment is checked
against the land mask. Junctions and settlement anchors remain fixed, including
anchors that happen to have only two incident edges. No random displacement is used.
Forests and buildings reserve space against these rendered curves, not the old grid.
The road follows terrain elevation, clears trees and buildings from its corridor,
and stays visible across package selection. Close zoom reduces contrast; internal
inspection retires the package road layer. Original coasts and file positions do
not move. Road-driven terrain grading is not implemented.

The inspector retains measured import direction and exact endpoint files, while
the road itself terminates at a settlement anchor, not each contributing file.
Sea-route rendering is excluded for pairs on the same continent. Cross-continent
port placement remains a later refinement; no such route is fabricated when the
data has no dependency.

## Following delivery: behavior and internal routes

Behavior mass is measured executable statements, not runtime frequency, complexity,
quality or test coverage. District pigment deepens with behavior mass on a compressed
scale. On entry, a bounded wash concentrates around behavior-bearing files; empty
space stays quiet. Selecting a file reveals statement count and district share.

Internal routes bundle district relationships at island scale, expand toward
responsibilities on entry, and reveal exact dependency endpoints on file selection.
Thickness encodes distinct module dependencies. Symbol counts describe the crossing
without silently changing that encoding. Preserve dependency direction and avoid
invented junction files. Begin the experiment on Studio.

The useful comparison is where behavior concentrates versus where dependencies go:
local support, broad service, or a dependency-heavy consumer. Keep these separate
observations, not one health score.

## Later candidates

Cycle contours on focus; split accents for competing responsibility affinities;
composition bands for declaration roles; declaration-to-consumer locality links;
tracing-paper comparisons showing measured advantages, costs and uncertainty.
Coastal districts may eventually expand into their true internal consumers and
resources. Boats, animated cargo, live agents and historical traffic are excluded
from this delivery.

## Proof required

Deterministic ranking and ports; input immutability; paths avoid intervening land,
including thin islands; disconnected water fails honestly; selected and overview
route limits; retained internal exploration; desktop and narrow rendered checks.

## Delivery evidence

Package trade implemented. Behavior washes and internal district routes remain future
work. Package world positions now account for landmass collisions. Island shapes,
local file placement, semantic tooling, dependencies and Git history remain unchanged.

- 128 tests across 34 files pass; typecheck and scoped lint pass.
- Production build passes with existing chunk-size, missing-404-content and
  sitemap-site warnings.
- Live browser verifies all six overview routes, all six Studio trades, partner
  navigation, keyboard entry into an exact DB resource file, and no narrow overflow.
- Desktop and narrow captures show no browser errors or horizontal overflow.
- Live navigation construction plus six overview and six Studio routes measured
  685 ms in headless Chrome. Combined evidence yields a 24-package main group and
  two isolated packages: markdown-config and plugins-foundation-ux. The analyzed
  module snapshot alone had three groups and four isolates; shared tooling manifests
  supply the missing connections. This is a local measurement, not a performance guarantee.
- Actual-map checks cover member/nonmember coastline containment in concave outlines.
  Convex hulls may now contain unrelated islands in accessible coastal pockets.
  Crossing hulls plus an enclosed singleton fixture verifies separation,
  unchanged local geometry, rigid group movement and deterministic ordering.
- An open-bay fixture verifies deterministic pocket placement, clearance and access;
  a closed-hole fixture rejects inaccessible cavities. Boundary tests verify all
  six independent layers without changing package geometry.
- Default settings place plugins-foundation-ux in a southern mainland pocket and
  markdown-config near its mouth. Both fit pockets at 8/8; wide 64/80 settings
  keep them near mouths. Island shapes and dependency evidence remain unchanged.
- Live slider min/max/reset checks pass; reset produces the same captured pixels.
  Layout tests cover conservative clearance, immutable inputs and determinism;
  playback restoration preserves independently paused track clocks.
- Desktop and narrow browser checks verify every boundary toggle changes the map,
  with no page errors or horizontal overflow.
- Continental checks cover deterministic groves and buildings, coast containment,
  untouched inputs, connected ground, settlement categories and zoom fading.
  Live desktop, zero-buffer, Studio and narrow captures show retained land after
  selection, with no browser errors or horizontal overflow. A forest-ground sample
  has zero ocean-mask distance.
- Road tests cover deterministic ordering, retained evidence, immutable input,
  sampled land clearance, shared segments and failure when land is severed.
  Desktop, zero-buffer, Studio and narrow captures show persistent land roads,
  without browser errors or horizontal overflow.
- Relaxation tests cover fixed endpoints, deterministic geometry, retained input,
  constrained curve subdivision and sampled full road width on the actual landmask.

Routing uses a conservative sea grid. Channels narrower than its clearance can be
unavailable; it does not claim exact continuous shortest paths. Corners round only
where the rounded segments remain clear. Coastline geometry is never modified to
make a route possible.
