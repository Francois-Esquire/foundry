# Atlas codex

The vocabulary between the atlas's sources and its visuals. Sources resolve into
codex entities and values, and visual layers read those values through the
transforms in `bindings.ts`. The full vocabulary and its reasoning are in
`docs/codebase-atlas-codex.md`.

This first version carries exactly what the atlas reads today. `loadAtlas()`
produces byte-identical data with and without the codex.

## Files

| File            | Role                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `source.ts`     | `readCodexSource(reader)`: picks the codex's fields through the library's dataset reader; `CodexSource` lists every field read.  |
| `vocabulary.ts` | Codex entities and values, named by meaning.                                                                                     |
| `resolve.ts`    | `resolveCodex(source)`: source fields to codex values. Pure.                                                                     |
| `bindings.ts`   | Codex values to visual channels. Every constant that tunes how a value looks.                                                    |

`bindings.ts` imports nothing; `vocabulary.ts` imports one library type.
`resolve.ts` imports codex files and the library's
`SEMANTICS_DECLARED_DEPENDENCY_KINDS`. `source.ts` imports types from `src/lib`
and reads through a `DatasetReader` (`src/lib/dataset.ts`), which alone knows
dataset paths; `src/web/dataset.ts` gives it the viewer's `fetch`. Nothing here
imports from the renderer, so the folder moves as a unit. Tests are in
`test/web/codex/`.

## Resolvers

| Codex value                                | Source field                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| Workspace `surveyedAt`, `coverage`         | manifest `generatedAt`, `coverage`                                        |
| Package `id`, `analyzed`                   | `package-sizes` lens, from the dependency graph                           |
| Package `label`                            | the id without its scope                                                  |
| Package `size`                             | `package-sizes` lens `modules.total`                                      |
| Package `layer`                            | `package-sizes` lens `layer`; `null` becomes 0                            |
| Module `id`, `package`, `path`, `fileKind` | module index; a missing kind becomes `unknown`                            |
| Module `directory`                         | path up to its last `/`                                                   |
| Module `dependents`, `dependencies`        | edge shards, within and across packages; equal to the module record's `gravity.fanIn`, `fanOut` (pinned by `test/lib/semantics.test.ts`) |
| Module `internalFanIn`, `highFanIn`        | `file-roles` lens `fanIn`, `highFanIn`, by module id; 0 and false for a package without internals |
| Package `responsibilityGroups`             | `responsibility-groups` lens `groups` and `independent`; `undefined` for a package without internals |
| Package `highFanInCutoff`, `fileRoles`     | `file-roles` lens `highFanInCutoff` and `modules`; 0 and `undefined` for a package without internals |
| Module `concepts`                          | module shard `concepts`, every role, deduplicated                         |
| Import                                     | edge shards                                                               |
| Dependency `strength`, `sharedConcepts`    | graph dependency edge `dependency.moduleEdges`, `concepts.total`          |
| Declared dependency                        | manifest `packages[].declaredDependencies`, current packages only         |
| Retired package `lastSeen`                 | `history/entities.json` checkpoints, latest complete snapshot             |

## Bindings

The map keeps each package's `file-roles` lens entry from load
(`Territory.fileRoles`), and `load-internals.ts` binds its file roles on
entering the island, without reading the lens again; landmarks and drainage
read them from `NaturalEvidence.fileRoles`, and only the district arrangement
attaches them to files (`AtlasFile.fileRole`) for role marks. The overview
reads only internal fan-in, so it draws no role marks. Landmarks also consume `SurfaceReport.churn`: exact workspace-relative file
paths, commit and line-change counts, same-kind repository percentiles, and
`history` window/completeness. This is loaded with the island's internal evidence only when Recorded change is enabled;
missing history never becomes a zero count.

| Binding                | Codex input                                   | Channel               | Used in                         |
| ---------------------- | --------------------------------------------- | --------------------- | ------------------------------- |
| `changeCrater` | Commits and repository same-kind commit percentile in the recorded window | Recorded-change index at >=3 commits and >=80th percentile | `landmarks.ts` |
| `summitHeight` | Internal fan-in of a high fan-in module and its package's saved cutoff | Summit `1.8 × log₂((1 + internalFanIn) / cutoff)` above lowland; other files, and a package without a cutoff, raise nothing | `scene/terrain-field.ts` |
| `summitReach` / `summitProfile` | Summit height | Rounded foot reaching `10 + 4 × height` units, zero slope at crown and foot | `scene/terrain-field.ts` |
| `rangeBlend` | Overlapping summit profiles | Soft maximum (power 8): clustered summits join into one range | `scene/terrain-field.ts` |
| `lowland` | Clearance from the unchanged coast | Beach round-over (1, 4-unit falloff) plus gentle inland rise (0.9, 30-unit falloff); no table | `scene/terrain-field.ts` |
| `islandPlinth` | None (constant) | 0.45-unit raised coast above the paper | `scene/terrain.ts`, `scene/lettering.ts` |
| `speckRadius` | View pixels per map unit | Overview file dot radius `1.45 / √pixels` | `scene/paint-map.ts` |
| `terrainContourLevels` | Shared elevation scale | Optional contours at 2, 4, 6 and 8 units; every second line emphasized | `scene/topography.ts` |
| `shoreRamp` | Clearance from the unchanged coast | Summits fade over ten units toward the shoreline | `scene/terrain-field.ts` |
| `chartGrid` | View pixels per map unit | Fixed 90-unit majors and 18-unit minor lines; minor opacity fades in at 30–60 screen pixels of spacing | `scene/paint-paper.ts` |
| `footprint`            | Package size                                  | island radius         | `load-atlas.ts`                 |
| `latitude`             | Package layer                                 | north/south position  | `load-atlas.ts`, `geography.ts` |
| `attraction`           | Dependency strength                           | pull between islands  | `geography.ts`                  |
| `settlementTier`       | Package size                                  | village, town, city   | `continent.ts`                  |
| `territoryLabelSize`   | Package footprint                             | territory label size  | `scene/paint-map.ts`                  |
| `labelPriority`        | Module dependents, dependencies               | file label order      | `scene/paint-map.ts`                  |
| `neighborhoodAffinity` | imports, shared concept participation         | neighborhood grouping | `relationships.ts`              |
| `laneWidth`            | Dependency strength                           | sea lane width        | `scene/trade-layer.ts`                |
| `dependencyPen` | Module imports between two packages | Selected package's dependency line width, 0.9–1.8 screen pixels | `scene/selection-ink.ts` |
| `roadWidth`            | Dependency strength, merged per road          | road width            | `scene/road-layer.ts`                 |
| `currentStrength`      | cross-package imports between two packages    | sea current           | `current-field.ts`              |
| `landmarkRadius`           | Module internal fan-in and its package's saved cutoff, for a structural landmark | bounded inspection footprint `min(6, 2 + 0.8 × √(5 × internalFanIn / cutoff))`: `2 + 0.8√5` at the cutoff, 2 without one | `landmarks.ts`           |
| `streamWidth`          | responsibility link module edges, accumulated on shared runs | stream width | `natural-features.ts`, `river-network.ts`           |
| `marshDetail` | Unresolved module count and zoom | reed opacity and screen spacing | `scene/paint-features.ts` |
| `riverPen` | Bound stream width and zoom | mineral river pen width | `scene/paint-features.ts` |
| `reliefHachure` | Current height-field slope and zoom | engraved fall-line threshold, length and opacity | `scene/relief-ink.ts` |
| `filePen` | Zoom | file settlement mark size | `scene/paint-map.ts` |

## Contact points

Every existing file the codex touches, under `src/web/` and `test/web/`. Each
change swaps an inline read or transform for a codex export; nothing else moved.
`AtlasData`, `Territory` and every visual layer's inputs are unchanged.

| File                      | Before                                                               | After                                                                                 |
| ------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `load-atlas.ts`           | fetched the survey, manifests and history; counted sizes and imports | `readCodexSource(viewerDataset({ signal }))`, `resolveCodex`; `footprint`, `latitude` |
| `former-packages.ts`      | took raw history; found each package's last complete checkpoint      | takes `CodexRetiredPackage[]`; placement only                                         |
| `former-packages.test.ts` | checkpoint selection and placement                                   | placement; selection moved to `codex/resolve.test.ts`                                 |
| `geography.ts`            | `layer · −220`, `log2(2 + w)`                                        | `latitude`, `attraction`                                                              |
| `continent.ts`            | `settlementKind`                                                     | removed; `settlementTier`                                                             |
| `continent.test.ts`       | imported `settlementKind`                                            | imports `settlementTier`                                                              |
| `scene/paint-map.ts`      | `clamp(0.15r, 13, 22)`; `incoming + outgoing`                        | `territoryLabelSize`; `labelPriority`                                                 |
| `relationships.ts`        | `imports + 0.5 · min(1, shared)`                                     | `neighborhoodAffinity`                                                                |
| `scene/trade-layer.ts`    | inline lane width                                                    | `laneWidth`                                                                           |
| `scene/road-layer.ts`     | inline road width                                                    | `roadWidth`                                                                           |
| `current-field.ts`        | `log1p(count)`                                                       | `currentStrength`                                                                     |

## Outside the codex, deliberately

- **Identity seeds.** `unit(id)` hashes set east/west position, pigments, file
  anchors and wreck sites. They carry no meaning, so layout keeps them.
- **Geometry.** Coasts, relief, ocean depth and every field derived from positions
  belong to layout.
- **Palettes and selection rules.** File-kind colors and shapes, buildings per
  tier, the six strongest trades and label budgets stay with the painters. The
  codex owns the categories, not how they look.
- **Per-island evidence.** `load-internals.ts` reads the analyzer's internal
  reports through the same dataset reader, and belonging, composition and the
  inspection panels use them as-is. The district grouping is no longer the
  viewer's: districts are the `responsibility-groups` lens's groups, kept per
  package from load (`Territory.responsibilityGroups`) and drawn on entering
  the island.

## Decisions taken for this version

Against the design doc's open decisions:

1. Design rules lifted: none. Every binding reproduces today's visual.
2. Vocabulary: the values bound today. The design doc's other values come next.
3. Normalization: bindings take raw values. No rank until a binding needs one.
4. Identity: the codex publishes ids; hash seeds stay in layout.
5. Placement: this folder, inside the renderer.
6. Per-island resolution: deferred, as above.
7. Derived groupings: neighborhoods and landmasses stay in layout; their
   weights are bindings. Districts were here too, until 2.2b moved their
   grouping into the `responsibility-groups` lens.

## Analysis library

The codex reads dataset schema 4 through the library's reader, which checks the
schema version.
`CodexSource` picks its fields from the library's own types (the manifest,
module index and shards, edge shards, graph projection, history entities, and
`SemanticsDeclaredDependencies`, with `SemanticsDeclaredDependencyKind` for the
declared dependency kinds), so a renamed or removed field, or a new file kind,
stops the codex compiling instead of reaching the map.

## Adding a value

1. If the source field is not read yet, add it to `CodexSource` and read it in
   `readCodexSource`, through the reader; a file the reader does not read yet
   gets a method in `src/lib/dataset.ts`.
2. Name it by meaning in `vocabulary.ts`.
3. Resolve it in `resolve.ts` and cover it in `test/web/codex/resolve.test.ts`.
4. When a visual uses it, add the transform to `bindings.ts` and a row above.
