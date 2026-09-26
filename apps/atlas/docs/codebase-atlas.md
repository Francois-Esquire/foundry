# Codebase atlas

The atlas turns the generated semantic dataset into a navigable paper map at
`/atlas` in the documentation app. Package territories contain file settlements.
Dependency routes connect territories. Labels belong to the map plane.

## Accepted development phases

The first iteration is accepted and committed. Preserve the organic islands
and develop them into a recognizable archipelago. The phases below describe
accepted direction; the implementation sections that follow describe the
current implementation. Geography experiments were rejected and the original method restored.
Neighborhood inspection remains. Experiment history is recorded in
[Shape the archipelago](codebase-atlas-phase-1.md).
Phase 2 materials are accepted and committed in `1fb8f047`.
Phase 3 exploration is implemented in [Exploration at each scale](codebase-atlas-phase-3.md).
The material brief remains [Paper, ink and relief](codebase-atlas-phase-2.md).
An accepted atmosphere direction extends Phase 3 in
[Folklore and atmosphere](codebase-atlas-atmosphere.md). The first experiment
implements contour coastlight and a brief open-water wind gesture, with an
independent toggle and reduced-motion support. They respond to exploration,
never agent activity. Mythical sightings and neighborhood bustle remain
candidates; history and agents remain unimplemented.

| Phase                             | Outcome                                                                                                                                        | Checkpoint                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1. Shape the archipelago          | Refine organic coastlines, territory sizes, spacing and neighborhoods. Strong relationships influence proximity; file clusters shape the land. | Geography feels natural, and each territory's placement has an explainable basis.        |
| 2. Give it material richness      | Develop paper grain, ink, coastal shallows, relief and lettering across zoom levels.                                                           | Overview and close range feel like the same crafted atlas.                               |
| 3. Make exploration rewarding     | Navigate between archipelago, island, neighborhood and file. Selection reveals relevant relationships and detail.                              | A user can locate a file and understand its surroundings without fighting the interface. |
| 4. Preserve places through change | Compare generated snapshots while keeping established locations recognizable as files appear, move and disappear.                              | A small code change produces a small, understandable map change.                         |
| 5. Let agents inhabit it          | Connect actual workflow events to locations, showing where agents work, travel, wait and finish.                                               | Every visible action corresponds to a real event; nothing pretends to be live.           |

Start with geography before deeper visual polish. Computation determines the
places; art direction makes those places readable and memorable. Phase 1 must
preserve stable identifiers and expose layout decisions so Phase 4 can evaluate
continuity without treating current coordinates as canonical data.

Open decisions include the balance between geographic
continuity and newly observed relationships, and the event source and meaning
of agent travel. Agent telemetry integration requires an explicit scope before
work expands beyond the documentation app and docs.

## Accepted quality ambitions

These ambitions guide the next phases; they are not claims about the current
implementation. Exceptional beauty should precede agent activity. Agents will
inhabit an already compelling world.

- **Places worth remembering.** Territories have recognizable silhouettes and
  neighborhoods grounded in code relationships. Studio should become recognizable
  without its label. Character must remain visible at several scales.
- **Discovery through approach.** Zoom reveals new information: archipelago,
  coastal routes, neighborhoods, then individual files. Each scale answers a
  different question instead of merely enlarging the same picture.
- **Materials that hold up close.** Paper fibers, pigment collecting at coastlines,
  engraved lettering and restrained relief share coherent lighting. Materials
  remain convincing during movement and zoom.
- **Cartography with judgment.** Labels follow geography, avoid collisions and
  change with scale. Routes meet meaningful locations. Selection clarifies
  important relationships. The map leads the experience; controls recede while
  remaining discoverable and accessible.
- **Movement that explains.** Camera travel preserves orientation. Changed files
  appear in understandable locations. Eventually, selecting a working agent
  reveals its actual task and location. Every movement communicates meaning.

### Defining exploration journey

Approach Studio until its neighborhoods become legible. Select a file, then
follow an actual dependency across the water to another island without losing
your bearings. The journey should feel beautiful and reveal something about
the codebase.

Prove this continuous journey through one large island and one connected
neighbor before extending the visual treatment across the atlas. This is a
bounded proof of the geography, materials and exploration phases, not a reason
to hardcode package-specific scenery or defer the quality bar until agents arrive.

## Scope

Read `.foundry/semantics` without invoking or modifying the analyzer. Keep code
inside `apps/documentation`. Consume existing exported types. Generated atlas
geometry is disposable presentation data, never a new architectural authority.
The first release reads the current dataset when Astro serves or builds the page.
Reloading picks up regenerated data during development; deployed static builds
require rebuilding. Live agent telemetry and historical playback are future work.

## Geography

Use stable identifier seeds and fixed iteration counts. Package radius follows
the square root of file population. Dependency layers establish north/south
placement. Dependency module-edge counts weight attraction between packages,
with logarithmic compression so large consumers cannot collapse the map.

Within each package, directory anchors seed file positions and actual module imports
pull files together. File collisions keep individual settlements legible.
Package ownership contains this local solve. This first map does not apply
concept or historical coupling forces; those remain candidates for later lenses.

Sample a smooth density field around the solved files. Extract level contours
for coastlines and shallows. No Voronoi partition: contours may form islands,
inlets, holes, and disconnected territories. Continuous density relief rises
from a low shoreline and tapers smoothly to the existing coast. Height means concentration,
not quality. Colors distinguish package territories without ranking them.
Dependency routes show actual directed imports, not roads invented from proximity.

Deterministic placement is not temporal stability. Identifier seeds preserve
initial orientation, but changed dependencies can still move regions. Continuity
across snapshots must be measured before adding historical travel.

## Material and interaction

Warm paper, desaturated seawater, mineral pigments, amber ink, shallow relief.
Use Three.js with an orthographic camera and controlled tilt. Cartographic text,
settlements, contours, and routes lie in perspective on the map.
The current material uses solid matte pigments and smooth density relief.
The coordinate grid follows the raised mesh. Printed annotations occupy a
separate parallel ink plane so raised edges do not slice lettering. No geographic
coordinates or contours change.

Ocean depth is computed from proximity to all coastlines. Pale coastal water
darkens gradually into muted teal, while nearby terrain keeps channels lighter.
The distance field changes with the generated geography; it uses no random noise
and does not alter land positions or contours.

Topographic ink follows the existing land-height field. Major contours remain
visible at overview; finer levels appear with zoom. Coastal proximity rings stay
within 20 map units of land, with quieter rings just outside the archipelago
rim. They illustrate geography, not measured seabed depth. Lines remain thin,
leave gaps around labels, and suppress crowded segments. Contour paths are
computed once when the scene is created, not during camera movement.

Each ring family has seven levels, tightly packed near its rim and increasingly
spaced and faint outward. The outer ocean gradient also tapers gradually, with
less contrast. Land contours use slightly darker ink without changing pigment.

Terrain uses the existing file kinds. Stories are rose theater marks; tests are
blue walled proving grounds; configuration is ochre; source remains brown
settlements. Tree symbols, hatching and material noise are removed. Other kinds
remain neutral. Neighborhoods stay mixed. File marks fade in only at close range
on the selected island; file names require a closer view. Overview routes stay
hidden until island selection. Finer source categories remain future refinements. This terrain pass
is separate from interaction atmosphere and future agent activity.

Drag to pan, wheel or pinch to zoom. Selecting a package frames it and reveals
neighborhood labels once the scale permits and shows its dependency routes.
Visible ink repaints at viewport resolution during camera movement. Labels remain
in the tilted map plane, with bounded sizes and collision suppression. File names
appear close up in the selected territory, subject to available space.
Selecting a file reports its exact path and direct import counts in a fixed map
margin and draws its recorded connections. No floating tooltip boxes.
The margin's package index provides keyboard access; file choices become
available after selecting a package. Selecting a computed neighborhood filters
the index, frames its members and dims other files in the territory without
moving them. "Why this geography?" explains the evidence and links connected
packages. File connections lists actual source or target files with Imports or
Imported by direction. Each entry navigates to that file, including across islands.
Return to the territory leaves detail; Escape and "Whole atlas" restore overview.
Respect reduced motion. Keep an accessible index if WebGL cannot initialize.

Hover, index focus and selection add amber light along the territory's existing
coast contours. A one-second pointer pause over clear water can trigger a
2.4-second wind gesture, with a 12-second cooldown from its start. Wind avoids
coasts, shallows, labels, routes and annotations; file detail suppresses it.
The "Decorative atmosphere" toggle controls both effects. Reduced motion keeps
static coast emphasis and omits wind. Animation ends when effects settle and
stops in hidden tabs or when the map leaves the viewport. Geography and survey
loading are unchanged.

## Verification

Check dataset provenance, deterministic layout, finite coordinates, nonempty
contours, production build and TypeScript. Inspect desktop and narrow browser
renders. Exercise package selection, file inspection, reset, pan and zoom.
Clearly show partial coverage and the snapshot date. Do not invent agent activity.

## Running the atlas

From the repository root, run `bun run --cwd=apps/documentation dev --background`
and open `/atlas`. The dataset must already exist at `.foundry/semantics`.
Use `bun run --cwd=apps/documentation test` for geometry and dataset checks,
`typecheck` and `lint` for source checks, and `build` for the static site.

The mobile overview trades label readability for the complete geography. Use
zoom or the searchable territory index to explore it. Neighborhood labels use
representative source-path suffixes and suppress overlaps. The index exposes
every group, including labels omitted from the map.

## Implementation references

- [Astro framework components](https://docs.astro.build/en/guides/framework-components/)
- [Three.js](https://threejs.org/docs/)
- [D3 contour polygons](https://d3js.org/d3-contour/contour)
