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
| `source.ts`     | `readCodexSource(reader)`: picks the codex's fields through the library's dataset reader; `CodexSource` lists every field read for the first layout, and `LateCodexSource`, read by `readLateCodexSource`, the ones read after it. |
| `vocabulary.ts` | Codex entities and values, named by meaning.                                                                                     |
| `resolve.ts`    | `resolveCodex(source)` and `resolveLateCodex(late)`: source fields to codex values. Pure.                                        |
| `bindings.ts`   | Codex values to visual channels: the size, position, width, and spacing a value maps to. Inks are not here; see below.           |

`bindings.ts` imports nothing; `vocabulary.ts` imports library types only.
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
| Package `layer`                            | `package-sizes` lens `layer`; `null` stays `null` (unplaced)              |
| Package `path`                             | manifest `packages[].path`, the package's folder; empty if the manifest omits the package |
| Nesting `folders`, `pathRegions`, `seams` | `nesting` lens as saved; read after the layout (`loadLateReadings`) |
| Domains `declared`, `placements` | `domains` lens: its `domains` as saved; its `placements` keyed by `level:place`, as placements are |
| Proximity `apart`, `close`, `labelled` | `proximity` lens as saved; `labelled`, the ids of its `packages`; read after the layout (`loadLateReadings`) |
| Placement `label`, `toward`, `home`, `away`, `share` | `placement` lens `places`: the label and target as saved; consumer modules counted at home and per other package; `share`, the most any one package holds (its own package counted as one of the packages) over all of them, unindexed consumers left out; `labelled`, the lens's `packages` |
| Module `id`, `package`, `path`, `fileKind` | module index; a missing kind becomes `unknown`                            |
| Module `directory`                         | path up to its last `/`                                                   |
| Module `dependents`, `dependencies`        | edge shards, within and across packages; equal to the module record's `gravity.fanIn`, `fanOut` (pinned by `test/lib/semantics.test.ts`) |
| Module `internalFanIn`, `highFanIn`        | `file-roles` lens `fanIn`, `highFanIn`, by module id; 0 and false for a package without internals |
| Package `responsibilityGroups`             | `responsibility-groups` lens `groups` and `independent`; `undefined` for a package without internals |
| Package `highFanInCutoff`, `fileRoles`     | `file-roles` lens `highFanInCutoff` and `modules`; 0 and `undefined` for a package without internals |
| Import                                     | edge shards                                                               |
| Dependency `strength`, `sharedConcepts`    | graph dependency edge `dependency.moduleEdges`, `concepts.total`          |
| Dependency `consumerFiles`, `supplierFiles` | edge shards: the sources and targets of the edges from one package into the other, sorted; joined once by `pairEndpoints` |
| Declared dependency                        | manifest `packages[].declaredDependencies`, current packages only         |
| Retired package `lastSeen`                 | `history/entities.json` checkpoints, latest complete snapshot             |

## Bindings

The map keeps each package's `file-roles` lens entry from load
(`Territory.fileRoles`), and `load-internals.ts` binds its file roles on
entering the island, without reading the lens again; landmarks and drainage
read them from `NaturalEvidence.fileRoles`, and only the district arrangement
attaches them to files (`AtlasFile.fileRole`) for role marks. The overview
reads only internal fan-in, so it draws no role marks.

Craters and volcanoes mark the files the `frequent-change` lens names, read
with the island's internals only when Recorded change is enabled. The lens
gives each file's exact workspace-relative path, commit and line-change
counts, and same-kind workspace percentile, the package's history window and
completeness, and the gate it applied, which the change copy states; no
package report is read. A package without history, or a dataset saved before
the lens, says so; missing history never becomes a zero count.

| Binding                | Codex input                                   | Channel               | Used in                         |
| ---------------------- | --------------------------------------------- | --------------------- | ------------------------------- |
| `summitHeight` | Internal fan-in of a high fan-in module and its package's saved cutoff | Summit `1.8 × log₂((1 + internalFanIn) / cutoff)` above lowland; other files, and a package without a cutoff, raise nothing | `scene/terrain-field.ts` |
| `summitReach` / `summitProfile` | Summit height | Rounded foot reaching `10 + 4 × height` units, zero slope at crown and foot | `scene/terrain-field.ts` |
| `rangeBlend` | Overlapping summit profiles | Soft maximum (power 8): clustered summits join into one range | `scene/terrain-field.ts` |
| `lowland` | Clearance from the unchanged coast | Beach round-over (1, 4-unit falloff) plus gentle inland rise (0.9, 30-unit falloff); no table | `scene/terrain-field.ts` |
| `islandPlinth` | None (constant) | 0.45-unit raised coast above the paper | `scene/terrain.ts`, `scene/lettering.ts` |
| `speckRadius` | View pixels per map unit | Overview file dot radius `1.45 / √pixels` | `scene/ink/files.ts` |
| `terrainContourLevels` | Shared elevation scale | Optional contours at 2, 4, 6 and 8 units; every second line emphasized | `scene/topography.ts` |
| `shoreRamp` | Clearance from the unchanged coast | Summits fade over ten units toward the shoreline | `scene/terrain-field.ts` |
| `chartGrid` | View pixels per map unit | Fixed 90-unit majors and 18-unit minor lines; minor opacity fades in at 30–60 screen pixels of spacing | `scene/paint-paper.ts` |
| `footprint`            | Package size                                  | island radius         | `load-atlas.ts`                 |
| `latitude`             | Package layer; an unplaced package takes 0    | each island's latitude, the foundation south; the latitude scale's ticks | `geography.ts`, `scene/ink/latitude-scale.ts` |
| `territoryLabelSize`   | Package footprint                             | territory label size  | `scene/ink/labels.ts`                 |
| `labelPriority`        | Module dependents, dependencies               | file label order      | `scene/ink/labels.ts`                 |
| `laneWidth`            | Dependency strength                           | sea lane width        | `scene/trade-layer.ts`                |
| `dependencyPen` | Module imports between two packages | Selected package's dependency line width, 0.9–1.8 screen pixels | `scene/selection-ink.ts` |
| `roadWidth`            | Dependency strength, merged per road          | road width            | `scene/road-layer.ts`                 |
| `landmarkRadius`           | Module internal fan-in and its package's saved cutoff, for a structural landmark | bounded inspection footprint `min(6, 2 + 0.8 × √(5 × internalFanIn / cutoff))`: `2 + 0.8√5` at the cutoff, 2 without one | `landmarks.ts`           |
| `streamWidth`          | responsibility link module edges, accumulated on shared runs | stream width | `natural-features.ts`, `river-network.ts`           |
| `marshDetail` | Unresolved module count and zoom | reed opacity and screen spacing | `scene/paint-features.ts` |
| `riverPen` | Bound stream width and zoom | mineral river pen width | `scene/paint-features.ts` |
| `filePen` | Zoom | file settlement mark size | `scene/ink/files.ts` |

## Contact points

Every existing file the codex touches, under `src/web/` and `test/web/`. Each
change swaps an inline read or transform for a codex export; nothing else moved.
`AtlasData`, `Territory` and every visual layer's inputs are unchanged.

| File                      | Before                                                               | After                                                                                 |
| ------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `load-atlas.ts`           | fetched the survey, manifests and history; counted sizes and imports | `readCodexSource(viewerDataset({ signal }))`, `resolveCodex`; `footprint` (`latitude` moved to `geography.ts` in 4.3a) |
| `former-packages.ts`      | took raw history; found each package's last complete checkpoint      | takes `CodexRetiredPackage[]`; placement only                                         |
| `former-packages.test.ts` | checkpoint selection and placement                                   | placement; selection moved to `codex/resolve.test.ts`                                 |
| `geography.ts`            | `layer · −220`, `log2(2 + w)`                                        | `latitude`; `attraction` retired in 4.3a, when islands stopped pulling together       |
| `scene/ink/labels.ts`     | `clamp(0.15r, 13, 22)`; `incoming + outgoing`                        | `territoryLabelSize`; `labelPriority`                                                 |
| `scene/trade-layer.ts`    | inline lane width                                                    | `laneWidth`                                                                           |
| `scene/road-layer.ts`     | inline road width                                                    | `roadWidth`                                                                           |

## Outside the codex, deliberately

- **Identity seeds.** `unit(id)` hashes set pigments and wreck sites. They carry no meaning, so layout keeps them.
- **Geometry.** Coasts, relief, ocean depth and every field derived from positions
  belong to layout.
- **Inks.** Every hue, and how strongly each mark is drawn against the land
  or the sea, is in `scene/ink-ladder.ts`, the ink ladder, with the one table
  of hue, dash, and weight that says what each line means. The codex owns the
  categories and magnitudes; the ladder owns the ink; painters own the shapes
  (file kinds and roles), the six strongest trades, and label budgets.
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
7. Derived groupings: landmasses stay in layout; their weights are bindings.
   Districts and neighborhoods were here too, until 2.2b moved the district
   grouping into the `responsibility-groups` lens and 2.2d retired
   neighborhoods for responsibilities.

## Analysis library

The codex reads dataset schema 4 through the library's reader, which checks the
schema version.
`CodexSource` picks its fields from the library's own types (the manifest,
module index, edge shards, graph projection, lenses, history entities, and
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
