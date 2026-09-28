# Atlas codex

The codex is the vocabulary between the atlas's sources and its visuals. Sources
resolve into codex entities and values; visuals bind only to the codex. Either side
can change without the other: the semantic surface can gain or drop fields, and the
scene can change encodings, as long as the resolver and binding tables are kept
current.

This document inventories both sides first. Nothing here changes the scene. The
first implementation, covering the values the atlas binds today, lives in
`src/web/codex/`; its README records every contact point.

"Density" here means how much meaning each scale can carry. File concentration is
one codex value among many, not the organizing idea.

## Chain

```
source ──resolver──▶ codex (entities, values) ──▶ layout ──▶ geometry fields ──▶ visual channels
                                          └──────────────────────────────────────▶ visual channels
```

Layout consumes codex values and produces geometry: positions, coasts, distance and
density fields. Many channels read geometry rather than values; ocean shading, relief
and currents are all two or three steps removed from any source field. The codex does
not replace layout. It gives layout, and every channel after it, a single named input
instead of an inline transform.

One value end to end, as it works today without a codex:

```
manifest.packages[].modules.count  →  Package size (Studio: 1030, the largest)  →  island footprint 28 + 5.8√n   (load-atlas.ts:80)
```

With a codex, the left arrow is a resolver and the right arrow is a binding; neither
knows about the other.

## Current visual bindings

Every place today's code turns data into something visible. Input kinds:

- **V** real value from a source
- **H** identity hash (`unit(id)` or similar): deterministic, carries no meaning
- **G** derived geometry field, computed from earlier layout output
- **C** constant or chart setting

### Package

| Channel                  | Input                                   | Kind | Transform                                                                | Where                     |
| ------------------------ | --------------------------------------- | ---- | ------------------------------------------------------------------------ | ------------------------- |
| Island radius            | module count                            | V    | `28 + 5.8√n`; also sets contour span `2.5r`, file spread `0.62r`         | `load-atlas.ts:80`        |
| North/south position     | dependency layer                        | V    | target `y = −220·layer`, pull 0.018/step                                 | `geography.ts:19`         |
| East/west seed           | package id                              | H    | `(unit(id) − 0.5)·1400`, then forces                                     | `load-atlas.ts:96`        |
| Attraction               | package→package module edges            | V    | pull `∝ log2(2 + w)`, rest length `rA + rB + 75`, 450 steps              | `geography.ts:29`         |
| Collision gap            | —                                       | C    | 55 units                                                                 | `geography.ts:43`         |
| Landmass group           | module edges > 0 ∪ package.json deps    | V    | connected components, either direction                                   | `landmasses.ts:18`        |
| Group placement          | group mass `Σr²`; main group id         | V, H | heaviest group pinned; others at `unit(mainId)`-phased angles, +90 units | `landmasses.ts:79`        |
| Island clearance, buffer | —                                       | C    | 45, 32 (chart settings)                                                  | `landmasses.ts:12`        |
| Island pigment           | package id                              | H    | 7 pastels by `unit(id + ":pigment")`                                     | `load-atlas.ts:104`       |
| Territory label size     | radius                                  | V    | `clamp(0.15r, 13, 22)`, screen-bounded                                   | `paint-map.ts:562`        |
| Settlement tier          | module count                            | V    | village < 40 ≤ town < 300 ≤ city; 5 / 18 / 64 buildings                  | `continent.ts:57`         |
| Building orientation     | package id                              | H    | `unit(id) > 0.5`                                                         | `continent.ts:96`         |
| Analyzed                 | analyzed flag                           | V    | inspector text only                                                      | `Atlas.tsx:533`           |
| Wreck existence          | package in a checkpoint, absent now     | V    | one wreck per former package                                             | `former-packages.ts:13`   |
| Wreck position, bearing  | package id                              | H    | hashed attempts 28–160 units offshore                                    | `former-packages.ts:43`   |
| Wreck label              | last observed checkpoint timestamp      | V    | ledger and inspector text                                                | `former-packages.ts:28`   |

### Module

| Channel                   | Input                                     | Kind | Transform                                                                            | Where                     |
| ------------------------- | ----------------------------------------- | ---- | ------------------------------------------------------------------------------------ | ------------------------- |
| Position: anchor          | directory path                            | H    | angle `unit(dir)·2π`, distance `√unit(dir:distance)·0.62r`                           | `geography.ts:66`         |
| Position: jitter          | module id                                 | H    | `√unit(id:distance)·0.24r`                                                           | `geography.ts:74`         |
| Position: pull            | intra-package imports                     | V    | spring 0.012, anchor pull 0.025, collision 5, 100 steps                              | `geography.ts:79`         |
| Coast, shallows, hills    | module positions                          | G    | Gaussian density `σ = clamp(0.65r/√n, 4, 10)`, 112² grid, thresholds 0.18 / 0.5 / 1.8 | `geography.ts:119`        |
| Relief height             | module positions                          | G    | `0.4 + 18(1 − e^(−D/40))·smoothstep(d/28)`, `D` = Gaussian σ 22                        | `terrain.ts:9`            |
| Mark shape and color      | file kind                                 | V    | source / test / story / config / other                                               | `terrain.ts:76`, `paint-map.ts:321` |
| Mark shape (district mode) | composition root; scope mix; fragmentation | V   | junction / mixed / commons / unknown                                                 | `district-layout.ts:129`  |
| Label priority            | incoming + outgoing imports               | V    | descending sort before budget                                                        | `paint-map.ts:596`        |
| Import counts             | incoming, outgoing imports                | V    | inspector text                                                                       | `load-atlas.ts:61`        |
| Traced imports            | imports touching the selected module      | V    | dashed lines, all of them                                                            | `paint-map.ts:260`        |
| Neighborhood membership   | imports; shared concept participation     | V    | attraction `imports + 0.5·min(1, shared)`, greedy modularity merge                   | `relationships.ts`, `neighborhoods.ts` |
| Neighborhood label        | most-connected member's path              | V    | shortest unique path suffix                                                          | `neighborhoods.ts:96`     |

### Relationships

| Channel               | Input                                        | Kind | Transform                                                              | Where                    |
| --------------------- | -------------------------------------------- | ---- | ---------------------------------------------------------------------- | ------------------------ |
| Trade selection       | package module edges                         | V    | overview: top 6 consumers by `Σw`, each to strongest supplier; selected: top 6 incident | `trade-routes.ts:26`     |
| Sea lane width        | module edges                                 | V    | `0.35 + 0.25·log1p(w)/log1p(max)`                                      | `trade-layer.ts:259`     |
| Port size             | consumer vs. supplier side                   | V    | supplier gets larger warehouses                                        | `trade-layer.ts:186`     |
| Port location         | participating module endpoints               | V    | nearest coast to endpoint files; package fallback                      | `trade-routes.ts`        |
| Road network          | measured relationships inside a landmass     | V    | Dijkstra on 12-unit grid, shared edges cost 0.55                       | `roads.ts`               |
| Road width            | merged module edges                          | V    | `0.7 + log1p(w)/log1p(max)`                                            | `road-layer.ts:16`       |
| Sea current           | cross-package module imports; positions      | V, G | per pair `log1p(count)`, reach `max(85, 0.55(rA + rB))`, 0.4 prevailing blend | `current-field.ts`       |
| Current around coasts | current field; land mask                     | G    | obstacle-aware pressure solve                                          | `coastal-current.ts`     |

### Belonging and architecture (loaded per island)

| Channel                       | Input                                         | Kind | Transform                                                              | Where                         |
| ----------------------------- | --------------------------------------------- | ---- | ---------------------------------------------------------------------- | ----------------------------- |
| Responsibility membership     | responsibility regions; module→file join      | V    | exact members; unresolved kept separate                                | `belonging.ts:129`            |
| Responsibility footprint      | member positions                              | G    | radius 6 influence, contour 0.32, clipped to land                      | `belonging.ts:80`             |
| Responsibility pigment        | responsibility id (hashes membership)         | H    | 6 pigments; unresolved rust                                            | `belonging.ts:65`             |
| Uncertainty                   | unresolved ownership                          | V    | dashed outline, lower alpha                                            | `paint-map.ts:203`            |
| District grouping             | responsibility relationships                  | V    | weight `log1p(moduleEdges) + log1p(symbolFlow)`, clustered             | `hierarchy.ts`                |
| District anchor               | anchor responsibility's most-imported member  | V    | square anchor mark                                                     | `belonging.ts:234`            |
| District footprint            | member positions                              | G    | radius 22 cubic falloff, competing fields ×1.08, contour 0.08          | `belonging.ts:266`            |
| Focus overlay                 | members, related, path disagreement, unresolved | V  | amber r3.5, teal r2.5, notch, broken diamond; ≤ 24 links               | `paint-responsibility.ts`     |
| Composition marks             | declarations by served responsibility or scope | V   | rows or hex clusters, 1.8 spacing, groups 5.4 apart                    | `composition-layout.ts`       |
| Scenario routes               | primary edges from subject; redirect / surface / collapse | V | baseline teal, proposed amber by progress, ≤ 64 each                | `scenario-routes.ts`, `paint-scenario-routes.ts` |
| Tracing blockers              | scenario closure                              | V    | rust struck marks                                                      | `paint-composition.ts:37`     |
| District arrangement (option) | responsibility centroids; module id           | V, H | `0.8·centroid + 0.2·file + hash jitter`, fitted to 3.6 × 3.2 hex sites | `district-layout.ts:13`       |

### Sea, terrain and decoration

| Channel                  | Input                           | Kind | Transform                                                     | Where                 |
| ------------------------ | ------------------------------- | ---- | ------------------------------------------------------------- | --------------------- |
| Ocean shade              | distance to land; to atlas rim  | G    | smoothstep over 40 units; vignette over 1100                  | `ocean.ts:8`          |
| Contours and rings       | height and distance fields      | G    | land 3–15 by 3; coastal and rim rings, 7 each                 | `topography.ts`       |
| Wave arrival             | distance field; wind direction  | G, C | wavefront approximation                                       | `wave-field.ts`       |
| Water motion             | chart settings                  | C    | shader uniforms                                               | `water-material.ts`   |
| Continental ground       | landmass footprint              | G    | `0.16 + …sin/cos` undulation                                  | `continent.ts:42`     |
| Forests                  | footprint; grid seeds           | G, H | grove noise plus hash                                         | `continent.ts:123`    |
| Wreck water reveal       | wreck positions                 | H    | radius 40, falloff 22, alpha by zoom                          | `water-material.ts:85` |

### Scale

| Channel                   | Input               | Kind | Transform                                                        | Where                  |
| ------------------------- | ------------------- | ---- | ---------------------------------------------------------------- | ---------------------- |
| District, file, composition fades | pixels per unit | C | districts 1.2–1.8; files 3–5; composition 6–8                    | `detail-level.ts:21`   |
| Interaction hysteresis    | pixels per unit     | C    | files 4.2 / 3.6; composition 7 / 6.2                             | `detail-level.ts:33`   |
| Houses and trees          | pixels per unit     | C    | fade 1.1–2.9                                                     | `ecosystem-layer.ts:12` |
| Atmosphere                | pixels per unit     | C    | fade 0.8–2.8                                                     | `atmosphere.ts:9`      |
| Label budgets             | view area           | C    | files `area/40000`, regions 2–6                                  | `paint-map.ts:627`     |

### What the inventory shows

- Every real value reaches the screen through its own inline transform: `√n` for
  size, `log2` for attraction, `log1p` for lanes and roads, raw counts for label
  priority. There is no shared normalization and no single place to tune one.
- Hashes decide east/west position, island and responsibility color, file anchors,
  wreck placement and several decorations. These are identity seeds, not values.
- Most of the overview's look is geometry derived from positions, two or more steps
  from the source. Tuning a value today means knowing that chain by heart.
- Responsibility ids hash their membership, so their color and identity change when
  membership changes.

## Source vocabulary

The semantic surface is the only source today. It arrives in four cost tiers, and
the tier decides where a resolver can run:

| Tier                | Files                                                         | Size        | Resolver runs              |
| ------------------- | ------------------------------------------------------------- | ----------- | -------------------------- |
| Eager               | manifest, module index and shards, edge shards, projections   | a few MB    | build, shipped with page   |
| Heavy               | `packages/<pkg>.json` (28), `workspace.json`                  | 169 + 46 MB | build only, summarized     |
| History             | `semantics-history/` timeline, 9 snapshots, 8 deltas, entities | ~10 MB     | build, summarized          |
| Per island          | `/atlas-internals`, `/atlas-architecture` (analyzer on demand) | per package | server, fetched on demand |

Ranges below are min / median / max over the current survey (2026-09-23).

### Persisted entities

| Entity             | Records | Value fields with spread                                                                                                                                  | Atlas reads today             |
| ------------------ | ------: | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Workspace          |       1 | topology (sources, sinks, articulation, seams, depth 7); architecture statements; limitations                                                              | survey time, coverage         |
| Package            |      28 | modules 2 / 43 / 1030; layer 0–7; graph role; architectural roles; fan-in 0–12, fan-out 0–15; reach; betweenness; articulation; symbols 4 / 197 / 6293; export utilization 0–1; concept centers by role; shape and profile signals | id, label, analyzed, layer    |
| Module             |    3497 | file kind; role (internal, aggregator); fan-in 0 / 1 / 246; fan-out 0 / 2 / 107; transitive dependents 0 / 1 / 889; transitive dependencies 0 / 10 / 501; concepts by role; commits 0 / 2 / 114; lines changed 0 / 148 / 5034; last changed; hotspot (80) and signals; co-change partners | id, path, kind, concepts (flattened) |
| Import             |    9258 | scope (7381 intra, 1877 cross); type-only (2377)                                                                                                          | source, target                |
| Dependency         |      65 | module edges 1 / 11 / 285; import sites; references; concepts by role; weak bridge (4); seam (13); severed pairs; alternative routes; patterns; symbol breadth; surface coverage | module edges, concept total   |
| Concept            |    6216 | kind; declaring package; centers by role; modules 1 / 1 / 130; references 0 / 2 / 219; distribution shape; ownership alignment and tensions; locality shape; overlaps | only per-module participation |
| Co-change          |    3021 | commits together 3 / 3 / 42; jaccard 0.03 / 0.33 / 1; conditional share; same or cross package. Also 14 package pairs                                   | no                            |
| Concept direction  |     180 | from, to, role (representation, usage, behavior, conversion, implementation); concepts 1 / 4 / 105                                                         | no                            |
| Pattern            |     131 | family (boundary, pair, role, concept, evolutionary); kinds; members; strength (strong, moderate, limited)                                                | no                            |

Heavy-tier content with no eager equivalent:

- **Per declaration** (21 406): kind, exported, public, external references, consumers, access.
- **Per function** (50 857): decisions, nesting, statements, parameters, awaits, owning declaration.
- **Per file churn** (4327, including non-code files): additions, deletions, days since last change.
- **Per commit radius** (1650): files, packages and boundaries a commit touches.
- **Concept intelligence**: layer span, boundary count, overlap pairs (2707).
- **Recentering findings** (42): mismatch −0.41 / 0.37 / 0.96, evidence confidence.

### History

| Entity     | Records | Value fields                                                                          | Atlas reads today  |
| ---------- | ------: | ------------------------------------------------------------------------------------- | ------------------ |
| Commit     |    1891 | time; files changed 1 / 9 / 805; additions; deletions; paths added, removed, renamed  | no                 |
| Checkpoint |       9 | time; counts (packages 3 → 28, modules 27 → 3684, dependencies 36 → 9256)             | time               |
| Checkpoint package | 152 | module count; layer; fan-in; fan-out                                              | id, checkpoints    |
| Checkpoint module | 15 612 | lineage id; path; package; kind; layer; concepts by role                         | no                 |
| Delta      |       8 | modules added, removed, renamed, moved between packages; dependencies added and removed; concepts appeared, disappeared, recentered; boundary changes | no |
| Lineage    |    6968 | path segments with the commits that introduced and retired each                       | no                 |

### Identity

| Identity                | Form                           | Stable over time                                                                  |
| ----------------------- | ------------------------------ | --------------------------------------------------------------------------------- |
| Commit                  | git hash                       | yes                                                                               |
| Module                  | repository path                | through lineage, TypeScript files only; rename-tracked at 50% similarity          |
| Package                 | package name                   | only while the name holds; no rename lineage (44 names across history, 28 now)    |
| Concept                 | `file#name`                    | survives file renames via lineage; breaks on type rename or move                  |
| Import, dependency      | `source→target`                | inherits its endpoints' stability                                                 |
| Co-change, pattern, direction, finding | composite strings | current survey only                                                               |

### No spread in current data

Author count (always 1), cycle flags (always false), concept coverage and analysis
mode, static dependency direction (always reverse), node and package cautions (empty).
These resolve to constants today and should not drive a channel until they vary.

### Per-island reports

Computed by the analyzer on request. Counts are `@foundry/studio` / `@foundry/lib`
(largest and median package); ranges are Studio's.

| Report           | Entities                                                                                   | Value fields with spread                                                                                                                                                  | Atlas reads today                                        |
| ---------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Topology         | modules 1022 / 42; edges 2784 / 54; directories 151 / 5; path regions 7 / 3; seams 6 / 0; cycles 10 / 0; layers 37 / 5 | module fan-in 0 / 1 / 87, fan-out 0 / 0 / 39, layer 0 / 12 / 36, declared, exported and provided symbols, test and story fan-in, external fan-out; edge import sites, locality (same directory, same region, cross region), directory distance 0–9; cycle size 2–37; module roles (sink, high fan-in, bridge, satellite…) | edge endpoints, primary flag, import sites; module-to-file join |
| Locality         | symbols 1325 / 38; scopes 789 / 32                                                         | consumers 1 / 1 / 108; distribution (module, directory, region, package); placement (aligned, split, cross-region…); usage (type, value); declaration shape (behavior, contract, value); consumer statements 0 / 48 / 3880 | symbol id, consumer modules                              |
| Responsibilities | regions 150 / 13; relationships 190 / 3; unresolved 89 / 2                                 | region size 1 / 2 / 75; behavior mass 0 / 53 / 2368; internal, inbound, outbound edges; local vs. crossing symbols; path agreement; relationship module edges 1 / 1 / 14 and symbol flow; unresolved reason; module status (assigned, attached, unresolved) | id, label, members, relationships, unresolved            |
| Primitives       | declarations 3563 / 137; modules 632 / 24; conventions 182 / 27                            | declaration role (14: behavior, type, constant, schema, contract…); scope (module-local, responsibility-local, cross, package-wide, unclear, unplaced); module composition (single or mixed role and scope); fragmentation; module shape (primitive hub, contract hub, implementation) | symbol, role, scope, module fragmentation and scope mix  |
| Rewiring         | scenarios 1340; families 929                                                               | edges added and removed 0–56; closure size; wiring called and rendered                                                                                                   | proposed arrangement, closure, composition roots         |
| Review           | families, scenarios, subjects                                                              | disposition; measure deltas −53…46; certainty (measured, conditional, unresolved); trade-offs                                                                            | scenario review                                          |

Studio's payloads are 8.1 MB (internals) and 15.2 MB (architecture); Lib's are
249 KB and 316 KB. Cached analysis takes 150–350 ms; a cold analysis 0.3–3.5 s.

Identity inside these reports:

- Module, directory and scope ids are package-relative paths; declaration ids are
  repository-relative `file#name`. `package.root` joins them.
- Responsibility ids hash their sorted members, including attached connectors. Any
  membership change produces a new id, and that instability carries into
  relationships, scenario ids and 540 of Studio's 929 family ids.
- Scenario ids are not unique (1340 scenarios, 1322 ids). The atlas already joins on
  scenario id plus subject.
- Cycle ids are ordinal (`cycle-N`) and renumber whenever any cycle changes.

## Draft codex

Codex names describe meaning, not the source that supplied it. A second source,
such as agent activity in Phase 5, adds resolvers and values without renaming
anything here.

### Entity ladder

Entities by level, with how many exist and when their values are available. This
ladder is the density dimension: each level carries its own population and its own
evidence.

| Level | Entity         | Count now                      | Values available   | Atlas form today         |
| ----- | -------------- | ------------------------------ | ------------------ | ------------------------ |
| 0     | Workspace      | 1                              | eager              | chart, sea caption       |
| 1     | Cluster        | 7 in the projection; atlas derives its own | eager  | landmass (optional)      |
| 2     | Package        | 28                             | eager, heavy       | island                   |
| 3     | District       | derived per package            | per island         | district wash            |
| 3     | Responsibility | 150 in Studio, 13 in Lib       | per island         | responsibility footprint |
| 3     | Directory      | 151 in Studio                  | per island         | hashed file anchor only  |
| 4     | Module         | 3497                           | eager, per island  | settlement mark          |
| 5     | Declaration    | 21 406 (3563 in Studio)        | heavy, per island  | composition mark         |
| 5     | Concept        | 6216 (type-level declarations) | eager, heavy       | none                     |
| 6     | Function       | 50 857                         | heavy              | none                     |

Links connect entities at the same or adjacent levels:

| Link                | Between                  | Count now                  | Atlas form today                         |
| ------------------- | ------------------------ | -------------------------- | ---------------------------------------- |
| Import              | module → module          | 9258                       | file placement, traced lines, sea current |
| Dependency          | package → package        | 65 measured, plus declared | attraction, clusters, trades, roads      |
| Responsibility link | responsibility → responsibility | 190 in Studio       | district grouping                        |
| Consumption         | declaration → module     | per island                 | composition inspector                    |
| Co-change           | module ↔ module, package ↔ package | 3021, 14         | none                                     |
| Concept flow        | package → package, by role | 180                      | none                                     |
| Membership          | module ∈ responsibility, district, directory, package | per island | belonging washes                |

Time entities: Change (1891 commits), Checkpoint (9), Delta (8), Lineage (6968
module histories).

### Values by dimension

Kinds: **count** (heavy-tailed), **share** (0–1), **ordinal**, **category**, **flag**,
**time**, **series** (one value per checkpoint), **weight** (on a link). `flag +`
marks a flag that carries detail, such as a reason or size. Resolver tiers: E eager,
H heavy, T history, I per island.

**Mass: how much is there**

| Value           | Entity                    | Kind  | Resolver                                          | Spread              | Bound today                      |
| --------------- | ------------------------- | ----- | ------------------------------------------------- | ------------------- | -------------------------------- |
| size            | Package                   | count | E `manifest.packages[].modules.count`             | 2 / 43 / 1030       | radius, settlement tier, label   |
| surface         | Package                   | count | E package projection `surface.totalSymbols`       | 4 / 197 / 6293      | —                                |
| concept mass    | Package                   | count | E graph node `metrics.declaredConcepts`           | 0 / 67 / 1553       | —                                |
| declarations    | Module                    | count | I topology `declaredSymbols`; H `role.ownDeclarations` | 0 / 3 / 61 (Studio) | —                           |
| behavior mass   | Module, Responsibility    | count | I responsibilities `behaviorMass`, `behavior.mass` | 0 / 15 / 341; 0 / 53 / 2368 | —                        |
| statements      | Module (from Function)    | count | H `localComplexity` summed per file               | per function 0 / 1 / 384 | —                           |

**Connectivity: what depends on it, what it depends on**

| Value              | Entity      | Kind  | Resolver                                              | Spread                   | Bound today              |
| ------------------ | ----------- | ----- | ----------------------------------------------------- | ------------------------ | ------------------------ |
| dependents         | Module      | count | E shard `gravity.fanIn`                               | 0 / 1 / 246              | label priority (via edges) |
| dependencies       | Module      | count | E shard `gravity.fanOut`                              | 0 / 2 / 107              | label priority (via edges) |
| reach              | Module      | count | E shard `gravity.transitiveDependents`                | 0 / 1 / 889              | —                        |
| dependents         | Package     | count | E graph node `metrics.fanIn`                          | 0 / 1 / 12               | —                        |
| reach share        | Package     | share | E package projection `graph.dependentReachShare`      | 0 / 0.04 / 0.59          | —                        |
| brokerage          | Package     | share | E package projection `graph.betweenness`, `articulation` | 0 / 0 / 0.006; 2 flagged | —                     |
| export use         | Package     | share | E package projection `surface.exportUtilization`      | 0 / 0.26 / 1             | —                        |
| consumers          | Declaration | count | I locality `consumers.modules`                        | 1 / 1 / 108              | composition inspector    |

**Depth: where it sits in the stack**

| Value          | Entity  | Kind     | Resolver                                        | Spread                     | Bound today  |
| -------------- | ------- | -------- | ----------------------------------------------- | -------------------------- | ------------ |
| layer          | Package | ordinal  | E graph node `layer`                            | 0–7                        | north/south  |
| stack role     | Package | category | E graph node `graphRole`                        | source, sink, intermediate, isolated | — |
| layer          | Module  | ordinal  | I topology `layer` (within package)             | 0 / 12 / 36 (Studio)       | —            |
| nesting        | Module  | ordinal  | I topology directory `depth`                    | 0–6                        | —            |

**Complexity: how intricate the inside is**

| Value           | Entity           | Kind  | Resolver                                          | Spread                    | Bound today |
| --------------- | ---------------- | ----- | ------------------------------------------------- | ------------------------- | ----------- |
| decisions       | Module (from Function) | count | H `localComplexity.decisions.total`, summed | per function 0 / 0 / 158  | —           |
| nesting         | Module (from Function) | ordinal | H `localComplexity.nesting.max`, max      | 0–6                       | —           |
| cycle           | Module           | flag + size | I topology `cycle`, cycle `modules`         | 60 modules in 10 cycles (Studio) | —    |

**Activity: how much it changes**

| Value        | Entity  | Kind  | Resolver                                       | Spread                     | Bound today |
| ------------ | ------- | ----- | ---------------------------------------------- | -------------------------- | ----------- |
| commits      | Module  | count | E shard `history.commits`                      | 0 / 2 / 114                | —           |
| churn        | Module  | count | E shard `history.linesChanged`                 | 0 / 148 / 5034             | —           |
| recency      | Module  | time  | E shard `history.lastChangedAt`                | 2026-01-29 … 2026-09-23    | —           |
| hotspot      | Module  | flag + signals | E shard `history.hotspot`, `hotspotSignals` | 80 modules          | —           |
| blast radius | Package | share | H `evolution.radius.crossPackageRate`          | 0.02 / 0.66 / 1            | —           |

**Lifecycle: when it existed**

| Value      | Entity           | Kind  | Resolver                                   | Spread                        | Bound today  |
| ---------- | ---------------- | ----- | ------------------------------------------ | ----------------------------- | ------------ |
| first seen | Module, Package  | time  | T lineage `since`; package `checkpoints[0]` | Jan–Sep 2026                  | —            |
| last seen  | Package          | time  | T package `checkpoints`                    | 16 former packages            | wreck ledger |
| retired    | Module, Package  | flag  | T lineage `until`; absent from survey      | 3307 retired module lineages  | wrecks (packages) |
| renamed, moved | Module       | flag  | T delta `renamed`, `moved`                 | 501 renames, 168 moves         | —            |
| growth     | Package          | series | T checkpoint `moduleCount`                | 9 checkpoints                 | —            |

**Kinship: what belongs together** (link weights and memberships)

| Value             | Link or entity           | Kind     | Resolver                                           | Spread                  | Bound today                              |
| ----------------- | ------------------------ | -------- | -------------------------------------------------- | ----------------------- | ---------------------------------------- |
| import strength   | Import                   | weight   | E edge presence; I topology `importSites`          | 1 / 1 / 19 sites        | file placement, traced lines, sea current |
| type-only         | Import                   | flag     | E edge `typeOnly`                                  | 2377 of 9258            | —                                        |
| dependency strength | Dependency             | weight   | E graph edge `dependency.moduleEdges`              | 1 / 11 / 285            | attraction, trades, lanes, roads         |
| declared          | Dependency               | category | package.json files (already a second source)       | 4 kinds                 | cluster membership                       |
| co-change         | Co-change                | weight   | E couplings `jaccard`, `coChangeCommits`           | 0.03 / 0.33 / 1         | —                                        |
| shared concepts   | Module pair              | weight   | E shard `concepts.*` participation                 | 0 / 2 / 319 per module  | neighborhoods                            |
| concept flow      | Concept flow             | weight   | E directions `count` by role                       | 1 / 4 / 105             | —                                        |
| responsibility    | Module membership        | category | I responsibilities `regions[].modules`             | 1 / 2 / 75 members      | belonging washes                         |
| responsibility link | Responsibility link    | weight   | I relationship `moduleEdges`, `symbolFlow`         | 1 / 1 / 14; 0 / 1 / 31  | district grouping                        |

**Character: what kind of thing it is**

| Value              | Entity      | Kind     | Resolver                                          | Values                                                 | Bound today                 |
| ------------------ | ----------- | -------- | ------------------------------------------------- | ------------------------------------------------------ | --------------------------- |
| file kind          | Module      | category | E index `fileKind`                                | source, test, story, config, other                     | mark shape and color        |
| module role        | Module      | category | E index `role`; I topology `roles`                | internal, aggregator; sink, bridge, satellite…         | —                           |
| composition        | Module      | category | I primitives + rewiring (atlas-derived)           | junction, commons, mixed, unknown                      | marks in district mode      |
| module shape       | Module      | category | I primitives `shapes`                             | primitive hub, contract hub, implementation, aggregator | composition inspector      |
| package role       | Package     | category | E graph node `roles`                              | semantic, consumption, representation, conversion, implementation center | —         |
| package profile    | Package     | category | E package projection `profileSignals`             | foundation-like, surface-heavy, leaf-like…             | —                           |
| declaration role   | Declaration | category | I primitives `primaryRole`                        | 14 roles                                               | composition inspector       |
| declaration scope  | Declaration | category | I primitives `scope`                              | 6 scopes                                               | composition grouping        |

**Tension: where structure disagrees with itself**

| Value               | Entity             | Kind     | Resolver                                     | Spread                          | Bound today                   |
| ------------------- | ------------------ | -------- | -------------------------------------------- | ------------------------------- | ----------------------------- |
| seam, weak bridge   | Dependency         | flag     | E graph edge `structure.seam`, `weakBridge`  | 13, 4                           | —                             |
| path disagreement   | Module             | flag     | I responsibilities `pathAgreesWithRegion`    | 119 of 543 (Studio)             | notch mark                    |
| unresolved belonging | Module            | flag + reason | I responsibilities `unresolved[]`       | 89 (Studio); 4 reasons          | broken diamond, dashed region |
| ownership tension   | Concept            | category | H concept `ownership.tensions`               | 128 tension records             | —                             |
| placement mismatch  | Concept            | share    | H recentering `mismatch`                     | −0.41 / 0.37 / 0.96 (42)        | —                             |
| blocked move        | Scenario           | flag     | I rewiring `closure`                         | per scenario                    | struck tracing marks          |

**Certainty: how much the evidence supports it**

| Value            | Entity                | Kind     | Resolver                                  | Values                                | Bound today                |
| ---------------- | --------------------- | -------- | ----------------------------------------- | ------------------------------------- | -------------------------- |
| coverage         | Workspace, Package    | category | E manifest `coverage`; node `analyzed`    | complete, partial                     | inspector text             |
| strength         | Pattern, package role | ordinal  | E patterns `strength`                     | strong, moderate, limited             | —                          |
| verified         | Dependency            | flag     | H boundary `verified`                     | 65 of 66                              | —                          |
| scope evidence   | Declaration           | ordinal  | I primitives `evidence.scope`             | complete, partial, structural, none   | composition inspector      |
| effect certainty | Scenario              | ordinal  | I review `certainty`                      | measured, conditional, unresolved     | scenario inspector         |

### Channels

The visual half of the bridge. Every current binding, restated in codex terms:

| Channel                    | Bound to today                                      | Input kind today |
| -------------------------- | --------------------------------------------------- | ---------------- |
| Latitude                   | Package layer                                       | value            |
| Longitude                  | package id, then dependency strength                | hash             |
| Footprint                  | Package size                                        | value            |
| Coast silhouette           | module positions from directory hash and imports    | hash, geometry   |
| Elevation                  | module concentration                                | geometry         |
| Land pigment               | package id                                          | hash             |
| Area wash                  | responsibility membership                           | value            |
| Mark shape and color       | file kind; composition                              | value            |
| Label prominence           | Package size; module dependents + dependencies      | value            |
| Structures                 | Package size tier; dependency strength (ports)      | value            |
| Routes (lanes, roads)      | dependency strength                                 | value            |
| Water current              | import strength across packages                     | value, geometry  |
| Water depth                | distance to land                                    | geometry         |
| Ink solidity (dash)        | unresolved belonging                                | value            |
| Submerged objects          | retired packages                                    | value            |
| Surface texture, vegetation, light, weather, motion | nothing or decoration only | —                |

At overview only Mass, Depth, Kinship and file kind reach a channel. Connectivity
reaches label priority alone; Complexity and Activity reach nothing; Lifecycle
reaches only wrecks; Tension and Certainty appear only inside island inspection.

### Gaps

Source side:

- No module size in lines or bytes. Statements summed from function complexity are
  the closest proxy, and only in the heavy tier.
- Package names have no rename lineage, so a renamed package looks retired and new.
- Responsibility ids hash membership; scenario ids are not unique; cycle ids are
  ordinal. None can anchor a place over time.
- Author count, cycle flags and several enums are flat in current data.

Atlas side:

- Values reach channels through inline transforms with no shared normalization.
- Hashes stand in for meaning on longitude, land pigment, file anchors and wreck
  placement.
- Derived groupings (clusters, districts, neighborhoods) are computed inside the
  atlas with no named home.
- Per-island reports ship whole. Studio sends 8.1 MB on approach and about 23 MB
  when evidence opens; the scene reads a fraction of either.

## Open decisions

The next artifact is the binding table: codex value × channel × transform. The first
two decisions gate it. The rest can wait until the mapping exists, and 3 and 4 have
workable defaults.

**Gate the binding table:**

1. **Design rules to lift.** Binding Activity, Complexity or Tension to elevation,
   pigment or light conflicts with DESIGN.md's rules that height means
   concentration, color carries no meaning, and the map implies no quality. Decide
   per dimension which rule lifts and what the new meaning is. This decides which
   channels are available at all.
2. **Vocabulary scope.** Which dimensions and values to keep, drop or defer. Flat
   fields and 169 MB of heavy detail suggest starting smaller than this table.

**Defaults proposed; confirm or change:**

3. **Who owns normalization.** Each value is heavy-tailed or bounded differently.
   Recommend the codex publish raw value plus rank within its population; bindings
   choose the curve (linear, log, step) and constants.
4. **Identity and seeds.** Recommend the codex publish stable identity (path,
   lineage) and leave hash seeds to layout, since seeds carry no meaning. Places
   that must survive change need a placement identity the analyzer does not supply
   today for packages or responsibilities.

**Code placement; decide after the mapping:**

5. **Where the codex lives.** In the atlas (`apps/documentation/src/atlas/codex/`),
   in its own package, or as a semantic-surface projection. A projection couples
   the codex to its first source. Recommend starting inside the atlas and extracting
   only when a second consumer appears.
6. **Resolution time.** Heavy and history tiers can only resolve at build. Per-island
   resolution could return codex records instead of raw reports, shrinking Studio's
   23 MB, but the V13 inspection panels read those reports directly.
7. **Derived groupings.** Clusters, districts and neighborhoods are semantic
   groupings, not geometry. Recommend they become codex derivations with named
   inputs rather than layout internals.
