# Spyglass data

The vocabulary between the spyglass's sources and its visuals. Sources resolve into
codex entities and values, and visual layers read those values through the
transforms in `bindings.ts`.

This first version carries exactly what the spyglass reads today. `loadSpyglass()`
produces byte-identical data with and without the codex.

## Files

| File            | Role                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `source.ts`     | `readCodexSource(reader)`: picks the codex's fields through the library's dataset reader; `CodexSource` lists every field read for the first layout, and `LateCodexSource`, read by `readLateCodexSource`, the ones read after it. |
| `vocabulary.ts` | Codex entities and values, named by meaning.                                                                                     |
| `resolve.ts`    | `resolveCodex(source)` and `resolveLateCodex(late)`: source fields to codex values. Pure.                                        |
| `bindings.ts`   | Codex values to visual channels: the size, position, width, and spacing a value maps to. Inks are not here; see below.           |
| `dataset.ts`    | `viewerDataset(options)`: the library's dataset reader over the viewer's `fetch`, pinned to the dataset the map was laid out from; `servesCollection` to tell a served collection, which the viewer refuses. |

`bindings.ts` imports nothing; `vocabulary.ts` imports library types only.
`resolve.ts` imports codex files and the library's
`SEMANTICS_DECLARED_DEPENDENCY_KINDS`. `source.ts` imports types from `src/lib`
and reads through a `DatasetReader` (`src/lib/dataset.ts`), which alone knows
dataset paths; `dataset.ts` here gives it the viewer's `fetch`. Nothing here
imports from the renderer, so the folder moves as a unit. Tests are in
`test/web/data/`.

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
| Module `dependents`, `dependencies`        | module index `fanIn`, `fanOut`, the record's gravity copied at scan time (pinned by `test/lib/semantics.test.ts`); 0 where gravity was not observed |
| Module `internalFanIn`, `highFanIn`        | `file-roles` lens `fanIn`, `highFanIn`, by module id; 0 and false for a package without internals |
| Package `responsibilityGroups`             | `responsibility-groups` lens `groups` and `independent`; `undefined` for a package without internals |
| Package `highFanInCutoff`, `fileRoles`     | `file-roles` lens `highFanInCutoff` and `modules`; 0 and `undefined` for a package without internals |
| Import (`SpyglassData.fileEdges`)             | edge shards, all of them, read only on Trace imports (`loadImports`); empty at load |
| Dependency `strength`, `sharedConcepts`    | graph dependency edge `dependency.moduleEdges`, `concepts.total`          |
| Dependency `consumerFiles`, `supplierFiles` | `import-traffic` lens `pairs`, joined from the edge shards at scan time; none for a pair it does not list |
| Declared dependency                        | manifest `packages[].declaredDependencies`, current packages only         |
| Retired package `lastSeen`                 | `history/entities.json` checkpoints, latest complete snapshot             |

## Bindings

The bindings that survive the Islands renderer are the ones the layout, the
labels and the chart chrome still read; Islands draws the land, the sea and
the towns from the `Chart` its adapter makes of the same map, with its own
bindings. The file roles, frequent-change and responsibility-group readings
reach the map through that adapter (`islands-host/chart.ts`), not through
these.

| Binding                | Codex input                                   | Channel               | Used in                         |
| ---------------------- | --------------------------------------------- | --------------------- | ------------------------------- |
| `paperThickness` | None (constant) | the height label anchors are given in the labels' own model (`flatMarkHeight`) | `layout/labels.ts` |
| `chartGrid` | View pixels per map unit | Fixed 90-unit majors and 18-unit minor lines; minor opacity fades in at 30–60 screen pixels of spacing | `ui/chart-margin-layout.ts` |
| `footprint`            | Package size                                  | island radius         | `layout/load-spyglass.ts`          |
| `latitude`             | Package layer; an unplaced package takes 0    | each island's latitude, the foundation south; the latitude scale's ticks | `lib/visualization/geography.ts`, `ui/chart-margin-layout.ts` |
| `territoryLabelSize`   | Package footprint                             | territory label size  | `layout/label-proposals.ts`          |
| `labelPriority`        | Module dependents, dependencies               | file label order      | `layout/label-proposals.ts`          |

## Contact points

Every file under `src/web/` the codex touches. Each reads a codex export in
place of an inline read or transform.

| File                      | Reads                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `layout/load-spyglass.ts` | `readCodexSource(viewerDataset({ signal }))`, `resolveCodex`; `footprint`             |
| `layout/label-proposals.ts` | `territoryLabelSize`; `labelPriority`                                               |
| `ui/chart-margin-layout.ts` | `chartGrid`, `latitude`                                                             |

## Outside the codex, deliberately

- **Geometry.** Coasts and every field derived from positions belong to the
  library's preparation (`lib/visualization/prepare.ts`, saved as `map.json`);
  relief, the sea and the towns belong to Islands.
- **Inks.** Every hue, and how strongly each mark is drawn against the land
  or the sea, is in `ladder/ink-ladder.ts`, the ink ladder; the one table of
  hue, dash, and weight that says what each line means is beside it in
  `ladder/ink-table.ts`. The codex owns the
  categories and magnitudes; the ladder owns the ink the labels and the
  chrome are set in.
- **Per-island evidence.** The Islands chart is made with each module's
  history (module shards), the edge shards, and the `responsibility-groups`
  and `frequent-change` lenses, read through the same dataset reader by
  `islands-host/chart.ts`; Islands draws districts and change from them.

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

The codex reads dataset schema 5 through the library's reader, which checks the
schema version.
`CodexSource` picks its fields from the library's own types (the manifest,
module index, graph projection, lenses, history entities, and
`SemanticsDeclaredDependencies`, with `SemanticsDeclaredDependencyKind` for the
declared dependency kinds), so a renamed or removed field, or a new file kind,
stops the codex compiling instead of reaching the map.

## Adding a value

1. If the source field is not read yet, add it to `CodexSource` and read it in
   `readCodexSource`, through the reader; a file the reader does not read yet
   gets a method in `src/lib/dataset.ts`.
2. Name it by meaning in `vocabulary.ts`.
3. Resolve it in `resolve.ts` and cover it in `test/web/data/resolve.test.ts`.
4. When a visual uses it, add the transform to `bindings.ts` and a row above.
