# Atlas viewer

Maintainer note, excluded from the Blume site. Dated 2026-10-09. Where the
viewer stands, and the questions to settle before reworking it. This is a
diagnosis, not a redesign: the maintainer's view is that the viewer is not
there yet, and the first job is to agree on what "there" means.

The design record for the current viewer is `apps/atlas/src/web/DESIGN.md`.
The data-to-visual bindings are listed in `apps/atlas/src/web/codex/README.md`.

## What the map answers

Decided 2026-10-09. The map answers four questions, and they are the
questions of Atlas as a whole:

1. **What is the shape of the code?**
2. **What sits next to what, and should it be that close?**
3. **How is it nested?**
4. **Where does it live, and where is it most used?**

The point of all four is to see where something is wrong from looking at it.
The defining case: part of one package is used by one other library and
nowhere else. The map should make that visible on its own, and should let
the workspace's domains mark it as belonging where it is, without hiding
it. A domain can span islands, so the map also needs a way to show one
domain across several packages. See [`_domains.md`](./_domains.md).

What the scan already measures for each:

| Question | Data that exists | Drawn today |
| --- | --- | --- |
| Shape | Package graph, dependency layers, gravity, file counts | Island size and north–south position |
| Proximity | Responsibility regions; change coupling; boundary interactions; `pathAgreesWithRegion` | Distance from a directory hash plus imports; one grouping, `lib`'s responsibilities, once an island is entered (the viewer's own neighborhoods retired in 2.2d); path agreement only inside a responsibility overlay |
| Nesting | The `nesting` lens (2.4): one folder tree across every package, from the module index, with path regions and seams from `internals/`; scopes with parent chains | Islands and districts; directories only seed a random angle |
| Lives vs used | The `placement` lens (2.3): every symbol, file, folder, and package labelled fits, spread, or departs from its consumer modules; per-symbol consumer packages; symbol locality `commonScope` and `dominant*`; concept miscentering; `fold-package` | Package trade, selection ink, import traces; none of the `lib` placement data is read |

The gap is clearest in the last two rows. Nesting by directory is in the
data and not on the map, and "lives here, used there" is the question that
matters most and is drawn least, although `lib` computes it. The rejected
engraved survey below asked a close cousin ("what belongs together, and
what role does each file play?").

The code review found that the viewer also recomputed parts of the analysis
on its own, with different thresholds and units: landmarks against
`highFan`, change craters against hotspots, neighborhoods against
responsibility regions, plus composite districts and file roles that `lib`
did not have. Phase 2 moved them into shared lenses, so the map and the
terminal agree: file roles and landmarks into `file-roles` (2.2a), districts
into `responsibility-groups` (2.2b), and craters into `frequent-change`
(2.2e); 2.2d retired the neighborhoods for responsibilities; and 2.2f made
package-pair traffic read the dependency graph's counts, with each pair's
endpoint files joined once in the codex. No viewer duplicate of `lib`
remains, except the per-module import counts, which equal `gravity.fanIn`
and `fanOut` (pinned; kept so the codex reads no module shard). Details, the settings split, and what is reusable are in
[`_review.md`](./_review.md#the-viewer), a dated snapshot.

## What the viewer is today

About 20k lines under `src/web`: 40 scene modules on three.js with a
WebGPU renderer and a WebGL 2 fallback, a post-processing pipeline, 26 UI
components, and a 668-line design record that has grown one paragraph per
feature. The metaphor is a paper sea chart of an archipelago.

What the map encodes, from the codex bindings and the design record:

| Element | Carries | On by default |
| --- | --- | --- |
| Island | A package. Size from file count. | yes |
| North–south position | Dependency layer: foundations north, leaves south. | yes |
| Distance between islands | Dependency strength and shared concepts. | yes |
| File mark | A file. Placed by imports and shared concepts. | yes |
| District | A responsibility group: responsibilities the `responsibility-groups` lens joins (since 2.2b). | at island zoom |
| Relief and summits | High fan-in files: imported by at least their package's cutoff of its own source files (`file-roles` lens, since 2.2a). | yes |
| Lake | A module many responsibilities draw on. | yes |
| Marsh | A module the analysis could not place in one responsibility. | yes |
| Selection ink | A package's dependency lines, a file's imports. | on selection |
| Wreck | A package seen at a history checkpoint and gone now. | with `--history` |
| Sea trade routes | Each package's leading consumers. | no |
| District streams | Imports between responsibilities. | no |
| Roads, connecting land | Dependency strength, merged. | no |
| Houses | Settlement tier from package size. | no |
| Boundary overlays (six) | Package and region boundaries. | no |
| Recorded change | Churn percentile per file. | no |

What the map draws that carries no data: the layered sea and its six depth
steps, gilded coast ripples, the archipelago rim, paper grain and grid,
forests, wind, waves, currents, coastlight, the chart filters (faded,
graphite, treasure, original), and the rendering controls: quality, five
tone mappings, exposure, occlusion, global illumination, bloom, and a stage
inspector. Pigment colors are seeded from package ids and carry no meaning.

## Observations

Stated as observations to test against the maintainer's view, not as
conclusions.

- **Most of the meaning is hidden or implicit.** By default, the only
  relationships on screen are positions. Imports between packages, imports
  between districts, and change history are all behind toggles. A first-time
  reader sees islands and has to know that north means foundation.
- **The settings panel is a renderer's debug panel.** Tone mapping, bloom,
  and a stage inspector are tools for building the renderer, not for reading
  a codebase. They sit beside the layers that carry evidence, with equal
  weight.
- **Two groupings inside an island.** Resolved in 2.2d: the viewer's import
  and concept neighborhoods are gone, and responsibilities, grouped into
  districts, are the only grouping. Neighborhoods never placed files (the
  directory and the imports do); they labelled and selected groups on a
  selected island before it was entered.
- **Decoration outweighs evidence on screen.** Relief, sea layers, and coast
  ink are the strongest marks at most zoom levels; file marks are among the
  faintest. This and the previous point come from the diagnosis under
  [Earlier work](#earlier-work), made at `73d227f`; worth re-checking
  against the current build.
- **The metaphor adds vocabulary the reader must learn.** Lake, marsh,
  stream, summit, wreck, trade route, district, settlement. Each is
  explained in the docs, and each explanation says it describes a role, not
  quality.

## Earlier work

An "engraved survey" art direction was drawn up around 2026-09-30 and
rejected. It survives only in a local, untracked cache
(`apps/atlas/.cache/rejected-art-direction/` in the main checkout). Its
thesis was that the map should answer one question, "what belongs together,
and what role does each file play?", and it proposed: responsibilities lead,
neighborhoods move to inspection, no package pigment, a plan-view camera, and
relief that may never be darker than a file mark. Only the directory name
marks it rejected: the document still says "Status: proposal", and neither
it nor `DESIGN.md` records a reason. That reason is the most useful input to this rework,
because it says which of the above observations the maintainer disagrees
with.

## Questions

1. **Answered:** see [What the map answers](#what-the-map-answers). What
   follows from it: how a departure is drawn so it reads without a toggle,
   and how an intended placement differs from it.
2. **Is the problem legibility, the metaphor, or polish?** Legibility means
   keeping the chart and changing what is on by default and how strongly it
   is drawn. The metaphor means questioning islands and terrain as the
   frame. Polish means the frame and the defaults are right and the
   execution is not.
3. **Why was the engraved survey rejected?** See above.
4. **Who is the reader?** Someone exploring locally after `atlas scan`, a
   reader of a hosted static export, or a reviewer looking at a PR. Each
   wants a different default zoom and a different amount of explanation.
5. **What leaves the settings panel?** Recommendation: rendering controls
   move behind a developer flag; reader-facing settings are only layers that
   carry data.
6. **What has to change for many workspaces?** One archipelago per
   workspace, or one archipelago for all of them. See
   [`_workspaces.md`](./_workspaces.md); the answer changes the layout
   code more than anything else here.
