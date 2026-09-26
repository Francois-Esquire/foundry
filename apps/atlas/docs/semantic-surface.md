# @foundry/semantic-surface

Deterministic semantic-surface analysis for a TypeScript package or directory:
which symbols it owns, which are exported, which exports the rest of the
monorepo actually references, and how that usage is distributed — plus the
package's dependency context: who consumes it, what it consumes, which symbols
account for each incoming edge, and what structural shape it currently takes.
From that evidence it derives reduction opportunities — explicit structural
operations the graph supports, never applied automatically.
An analysis tool, not a linter — no verdicts, exit code 0 whenever analysis
completes; eligibility gates decide what qualifies as an opportunity, never
whether the run passes. The one exception is `--apply`: a mutation request
that does not end in `preview` or `applied` exits 1, because a script must be
able to tell "changed" from "refused".

## Run

From the monorepo root:

```sh
bun run audit:surface -- packages/models
bun run audit:surface -- @foundry/models --json
bun run audit:surface -- @foundry/workspaces --plan ArtifactRead
bun run audit:surface -- @deps/satellite --plan fold-package
bun run audit:surface -- @foundry/workspaces --apply internalize-export --symbol ArtifactRead
bun run audit:surface -- @foundry/workspaces --apply internalize-export --symbol ArtifactRead --write
```

Options: `--json` (full report), `--plan <value>` (focused plan view — an
internalize-symbol subject name, or `fold-package` / the fold source package
name for the package fold plan), `--complexity [name]` (focused
local-complexity view; with a function name or id, that function's full
metric vector), `--gravity` (focused dependency-gravity view), `--profile`
(focused architectural-profile view), `--boundaries` (focused
boundary-interaction view), `--pressure` (focused structural-pressure
view), `--churn` (focused Git churn view), `--hotspots` (focused
change-meets-complexity view), `--coupling` (focused change-coupling
view), `--radius` (focused change-radius view), `--evolution` (focused
static × evolutionary pressure view), `--concepts` (focused concept
inventory view), `--concept <name>` (one concept family by seed name or
id), `--apply <operator>` with
`--symbol <name>` (preview a mutation; add `--write` to perform it),
`--root <path>`, `--tsconfig <path>`.
The target is a root-relative directory or a workspace package name.
Ordinary analysis and planning never mutate; only `--apply … --write` does,
one symbol at a time (bulk apply is deliberately not supported).

## Programmatic API

```ts
import { analyzeSurface, renderReport } from "@foundry/semantic-surface";

const report = await analyzeSurface({ target: "packages/models" });
```

`analyzeSurface` returns a `SurfaceReport` (`schemaVersion: 29`): target
boundary, summary counts and ratios, and per-symbol records — external
reference and import-site counts, consumer modules/packages with per-consumer
distribution (including per-consumer type/value namespace and usage contexts),
usage contexts (`implements`, `extends`, `call`, `construct`,
`parameter-type`, …), and public/deep access derived from the package's
declared `exports`. The CLI is a thin wrapper over this API.

`src/` contains the importable library. `cli/` contains the three command
entry points (`analyze`, `workspace`, `semantics`) and is not imported by the
library. `runInternalAnalysis({ target, through })` runs the requested
topology-to-review stages for a package without CLI output. Dataset generation
uses the exported `generateSemantics()` and `generateSemanticsHistory()`
functions; the `semantics` command supplies flags and progress text.

Export scope is explicit: `symbol.exported` means exported from its source
module, `symbol.packagePublic` means reachable through a declared package
entrypoint (root or subpath, following re-export chains). A module export
with no public route is a **module-only export** — internal module
composition, not package API. The summary separates
`moduleExportedSymbols` / `packagePublicSymbols` / `moduleOnlyExports`, and
`unusedExternalExports` counts only package-public symbols with zero external
usage; surface ratios use the package-public denominator. When the public
surface cannot be enumerated (wildcard `exports` subpaths, a directory
boundary, unresolvable entrypoints) every module export conservatively counts
as package-public. Deep-import reachability never makes a symbol
package-public; a deep-imported module-only symbol keeps its per-symbol usage
counts but stays outside the package-public aggregates.

`report.dependencies` adds package-level dependency context:

- `incoming` — one `PackageConsumer` per consuming package: symbols used,
  references, import sites, reference/surface shares, type/value namespace,
  the `SymbolDependencyUsage` list explaining _why_ the edge exists, and
  module-level edges as evidence.
- `outgoing` — internal packages the target depends on, with module edges.
- `primaryConsumer`, `consumerPackages`, `dependencyPackages`,
  `averageSymbolDistribution` — the raw concentration/distribution facts.
- `shapeSignals` — descriptive structural labels (`single-consumer`,
  `concentrated-consumption`, `distributed-consumption`, `high-fan-in`,
  `high-fan-out`, `one-way-satellite`, `shared-hub`) derived from centralized
  thresholds in `src/config.ts`. Signals are evidence, not verdicts —
  the underlying percentages are always reported alongside them.

`report.opportunities` lists `ReductionOpportunity` records, one per
structural operation the evidence supports. Detection is layered — hard
eligibility gates first, weighted evidence second — and a weighted score
never compensates for a failed gate (signal ≠ operation):

- `internalize-symbol` — an unused external export: package-public, with
  zero external references
  and import sites. It may still be used internally; the analyzer only sees
  outside the boundary.
- `fold-package` — the package behaves as an internal subsystem of its one
  consumer; the package boundary (not its internal modularity) is the
  candidate for reduction. Hard gate: **exactly one consumer package** —
  a multi-consumer package never folds, however concentrated its usage.
- `preserve-shared-boundary` — the opposite finding: multiple independent
  consumers support the existing boundary. Hard gates: **at least three
  consumers** and **primary reference share below 0.8**. A dominant consumer
  alone does not disqualify; surface share is deliberately not gated (one
  consumer touching the whole surface is normal for small shared packages).

Each opportunity carries `evidence` (metric/value/significance triples),
`cautions` (counter-evidence such as a dependency cycle, an explicitly
publishable package, or a multi-subpath exports map), an
`estimatedReduction`, and an `evidenceConfidence` in [0, 1]. Evidence
confidence measures how strongly the observed deterministic evidence matches
the operation's detection model — it is _not_ a probability that the
architectural action is correct, and it never triggers any action. It is a
transparent weighted sum of the evidence terms (gates and weights centralized
in `src/config.ts`); cautions warn without changing the number,
because their effects are already priced into the terms (a cycle zeroes the
one-way term; the concentration terms use the raw shares).

`report.ineligibleOperations` records why a package-level operation did not
fire (`failedGates`, e.g. `single-consumer expected 1, actual 3`) whenever
the target has consumers — the "why not" stays inspectable in JSON without
adding terminal noise. Concentration measurements and shape signals remain in
`report.dependencies` regardless of what fires: a `concentrated-consumption`
signal can coexist with a preserve opportunity or with nothing at all. The
terminal report is a lightweight snapshot: opportunities are summarized by
category (internalize candidates as one counted line) and the unused-exports
list is capped at ten names; the full per-symbol detail is in the JSON.

`report.plans` holds one `ReductionPlan` per internalize-symbol opportunity
(`InternalizeSymbolPlan`) and one per fold-package opportunity
(`FoldPackagePlan`) — concrete, read-only structural plans.
An internalization plan describes: the exact public exposure routes
(entrypoint file, export statement, re-export chain), the planned changes
(`remove-public-export` / `rewrite-public-export`), what is preserved, and a
signed predicted surface delta. Plan `status`:

- `ready` — every public route is accounted for and the change is precise.
- `blocked` — the plan is precise but a deterministic rule invalidates it
  (currently: the package is explicitly publishable, so consumers outside the
  repository are invisible).
- `unsupported` — a precise plan cannot be constructed: star-export exposure,
  wildcard `exports` subpaths, or a declaration in an entrypoint that other
  package modules import (or a namespace import of the entrypoint).

The predicted delta models the package-public surface, and since the summary
scopes its export counts to package-public symbols, a re-run after applying a
ready plan shows the `-1` (in `packagePublicSymbols` and
`unusedExternalExports`) even while the declaring module keeps its own
`export` — the symbol simply becomes a module-only export.
A fold plan assembles the concrete shape of an eligible fold: source file
inventory (source/test/config), the destination package with a conservative
directory suggestion (`resolved` / `suggested` / `unresolved`), the module
edges and consumed symbols crossing the boundary (with type/value namespace),
the exported symbols that would stop being package-public ("potentially
internalized" — never "must become private"), affected package metadata
(source manifest/tsconfig, consumer dependency declarations, TypeScript
project references, explicit workspace entries), and a predicted delta split
into `certain` (boundary, dependency edge, files, import sites) vs
`potential` (public exports). V2 cautions (publishable, designed exports,
dependency cycle) are carried into the plan; for folds they remain cautions,
not blockers — fold `ready` means "sufficiently understood to describe",
never "safe to execute". A fold source that is not a workspace package is
`unsupported`. Planning never decides fold eligibility — that stays in V2
policy.

`buildInternalizationPlan(report, opportunity)` and
`buildFoldPackagePlan(report, opportunity)` select the plan for one
opportunity (plans are computed during analysis, since route resolution needs
the source ASTs); preserve-shared-boundary has no plans. Plans describe; only
the explicit apply path below mutates.

Every plan also carries `intelligence: PlanIntelligence` — a deterministic
description of the plan's real scale, composed purely from data the analysis
already produced (no rescanning): `scale` (file inventory by kind, package
symbol counts, boundary import sites/module edges), `surface` (consumed and
unused-external surface ratios — null when nothing is exported — reference
density for folds, route burden for internalizations), `boundary` (package
edges, crossing counts, and fold dependency-flow direction incl. cycles),
`intent` (anchors, publishable, designed exports — context, never judgment),
and `consequence` (the predicted delta split by certainty). Raw facts only:
no size labels, no scores, no thresholds.
`buildPlanIntelligence(plan, report)` recomputes it standalone; it is derived
data, excluded from the plan fingerprint. Each `report.operators` entry adds
`unsupportedReasons` — blocker-reason counts across unsupported plans. The
default report stays compact: one plan-scale line per fold candidate and one
unsupported-reason line under the internalize summary; the full model lives
behind `--plan` and `--json`.

## Anchors, validation, operators

**Anchors** declare intentional architectural boundaries in
`ANALYSIS_CONFIG.anchors` (`{ target, reason? }`, matched by package name or
root-relative path). An anchor never suppresses analysis — the anchored
package still reports its full surface, dependencies, opportunities, and
plans (the report gains an `anchor` field and an ANCHOR section). It protects
the package boundary itself: a fold plan whose source is anchored becomes
`blocked` (`anchored-boundary`), while internalize plans are unaffected
because narrowing the public surface leaves the boundary intact.

**Validation.** Every plan carries a `fingerprint` — a stable hash of the
input facts it was built from (routes, statements, blockers; not the derived
delta). `validateReductionPlan(plan, freshReport)` re-checks each
precondition (symbol still resolves/exported/unused, single-consumer gate
still holds, destination unchanged, …) and compares fingerprints against the
freshly rebuilt plan; moved facts yield `stale`, and stale plans are never
applied.

**Operators** put structural operations under one lifecycle — plan →
validate → apply → verify — with explicit capabilities
(`getOperator(id)` / `listOperators()`, summarized per report in
`report.operators` and the OPERATORS section):

- `internalize-export` (plan ✓ validate ✓ apply ✓ verify ✓) — the one
  mutating operator. It removes a symbol's package-public exposure routes
  (named export/re-export specifiers, whole statements, or a direct
  declaration's export modifier) and nothing else: no symbol deletion, no
  internal rewrites. `applyReductionPlan(plan, { root?, tsconfig?, write? })`
  revalidates against a fresh analysis first (stale/blocked/unsupported plans
  are refused), blocks if any planned file has uncommitted git changes, and
  defaults to preview. With `write: true` it saves, then verifies: no new
  TypeScript errors in the target package, the symbol no longer
  package-public, external usage unchanged, and the observed package-public
  delta equal to the prediction. Any failed check restores every touched file
  to its exact pre-mutation contents (`rolled-back`). Star-export and
  wildcard-exposed symbols stay unsupported — never partially internalized.
- `fold-package` (plan ✓ validate ✓ apply ✗ verify ✗) — applying returns
  `unsupported`; fold mutation is not implemented.

`verifyInternalizeExport(plan, before, after)` exposes the structural
verification on its own; its deltas use package-public semantics (route
disappearance), matching the plan's prediction rather than the module-level
summary counts.

## Local complexity

`report.localComplexity` inventories how every function in the boundary is
shaped — declarations, expressions, arrows, methods, constructors, accessors —
as raw structural facts: no score, no thresholds, no quality gate. Each
`FunctionComplexity` record carries a metric vector (see
`LocalComplexityMetrics`) plus ownership (`ownerSymbolId`,
`exported`/`packagePublic` when the function directly implements a surface
symbol) and a position-stable id. Measurement is one walk per source file over
the already-loaded project; nested function bodies belong to their own records
and reach the parent only through `callbacks` (nested count and max depth) —
callback depth is deliberately separate from control-flow nesting.

Metric semantics live in `src/local-complexity.ts`:

- **Decisions** — `total = controlFlow + expression`, where
  `controlFlow = ifs + elseIfs + cases + loops + catches` (statement-level
  branching) and `expression = ternaries + logical` (value-level branching —
  the shape JSX conditional rendering takes, so component render bodies read
  as what they are without losing the raw total). The switch statement and
  default clause are recorded but add nothing. `logical` counts short-circuit
  `&&`/`||` (`localComplexity.decisions.countLogicalOperators`) and
  optionally `??` (`countNullishCoalescing`, off by default); assignment
  forms and optional chaining never count. This is deliberately named
  decision counting, not cyclomatic complexity.
- **Nesting** — deepest chain of `if` / loops / `switch` / `try`; a single
  un-nested `if` is depth 1, plain blocks add nothing, and an `else if`
  continues its ladder without deepening (guard clauses stay shallow however
  many decisions they add).
- **Parameters** — total/optional/defaulted/rest, plus `boolean` for
  parameters whose _annotated_ type resolves to boolean (`boolean`,
  `true | false`, an alias) — never inferred from names.
- **Exits** — explicit `return` / `throw` / `break` / `continue`.
- **Statements** — executable statement nodes (blocks, type-only
  declarations, and nested functions excluded); expression-bodied arrows
  report 0. Not a LOC measure.
- **Async / exceptions / loops** — `async`/`awaits`/`generator`/`yields`,
  `tries`/`catches`/`finals`, and per-kind loop counts.

`report.localComplexity.summary` aggregates totals, averages, and
nearest-rank percentiles (`sorted[⌈q·n⌉−1]`; p50/p90/p95/max) for decisions,
nesting, parameters, and statements. The default report shows one compact
LOCAL COMPLEXITY block; `--complexity` renders distributions plus top
functions per metric ("MOST"/"DEEPEST"/"LARGEST" mean highest measured count,
not worst code), and `--complexity <name>` prints one function's full vector.
`analyzeLocalComplexity(project, boundary, owners, config?)` exposes the pass
standalone against an existing project.

## Dependency gravity

`report.dependencyGravity` measures dependency pressure over the
workspace-wide module graph the cruise already produces — no extra project
build, no scanning. Raw vector only: no gravity score, no centrality, no
importance labels. All counts describe internal workspace relationships;
external npm dependencies are excluded from the cruise and therefore from
the graph.

Two levels: the target **package** (modules collapsed onto owning packages,
internal edges and self-edges dropped) and every target **module** measured on
the full module graph. Per node:

- **role** (modules only) — `aggregator` when the file forwards at least as
  often as it declares: `export … from` statements plus `export { … }`
  lists whose every name was imported (`import { Foo } from "./foo";
export { Foo }`), against top-level declarations of its own; else
  `internal`; plus `entrypoint`, `reExports`, and `ownDeclarations`.
  Syntactic, from the already-parsed source; the file name plays no part.
  A barrel's fan-in is the package surface, so higher-order signals that
  look for an internal center skip aggregators.
- **fan-in / fan-out** — unique direct dependents / dependencies.
- **transitive dependents / dependencies** — unique nodes reachable through
  incoming / outgoing edges, excluding the node itself. Cycle-safe: each node
  counts once.
- **depth** — longest chain in edges on the strongly-connected-component
  condensation, so a cycle collapses to one step and every member shares its
  component's depth. `downstream` follows dependent chains, `upstream`
  dependency chains.
- **reach** — transitive counts / (population − 1), where the population is
  every internal package (or module) the cruise observed, including
  disconnected ones.
- **cycle** — strongly-connected-component membership and size (0 outside a
  cycle).

`incomingConcentration` / `outgoingConcentration` show which target modules
receive or create the package's boundary-crossing edges, with exact counts
and shares. The default report shows a compact DEPENDENCY GRAVITY block;
`--gravity` renders the package vector, population, top modules per measure
("MOST"/"HIGHEST"/"DEEPEST"/"LARGEST" mean highest measured value, not worst
code), and edge concentration. `analyzeDependencyGravity(graph, boundary)`
exposes the pass standalone against a `WorkspaceModuleGraph`.

## Architectural profiles

`report.architecturalProfile` composes the existing sections — gravity,
semantic surface, local complexity, and declared intent — into one
description of the architectural role the target appears to play. Pure
composition: no new scanning, no score, no recommendations. Package level
only; module profiles wait for module-local complexity aggregation.

Descriptive shape signals fire from config-gated conditions
(`architecturalProfiles` in `src/config.ts`), each carrying the exact
metrics that satisfied its gates:

- **foundation-like** — fan-in ≥ 2, fan-out ≤ 1, dependent reach above
  dependency reach.
- **integration-like** — fan-in ≤ 2, fan-out ≥ 3, dependency reach above
  dependent reach.
- **shared-hub-like** — fan-in ≥ 3, ≥ 3 consumers, average symbol
  distribution ≥ 1.5.
- **leaf-like** — fan-in ≤ 1 with fan-out 1–2 (above that the shape reads
  integration-like).
- **surface-heavy** — ≥ 20 package-public symbols with export utilization
  ≤ 25%.
- **narrowly-consumed** — primary consumer holds ≥ 80% of references.
- **broadly-consumed** — ≥ 3 consumers, primary consumer below 80%.

There is deliberately no depth shape: module depth minus package depth
cleared the former `internally-deep` gate on 20 of 28 workspace packages
(package depth never exceeds 4, so the delta is just module depth). The raw
depths stay on gravity; the depth gap only counts inside
`internal-structure-pressure`, where two other gates do the separating.

Signals are not mutually exclusive and matching none is normal. Intent
flags are tri-state: `publishable`/`designedExports` appear only when an
existing opportunity or plan caution proved them — absent means unknown,
not false. The default report lists matched signals; `--profile` renders
signals with evidence plus the gravity/surface/intent/complexity facts.
`buildArchitecturalProfile(report, config?)` exposes the composition
standalone.

## Boundary interactions

`report.boundaryInteractions` measures how much traffic crosses each
internal package-to-package relationship and where it concentrates. It
aggregates data the analysis already holds — per-consumer symbol usage,
per-module usage from the same reference pass, cruiser module edges, and
the target's own import declarations — with no thresholds and no score.

Per boundary (`from → to`):

- **module edges** — unique module-to-module cruiser edges crossing the
  boundary, exactly as `dependencies` reports them.
- **import sites** — one per import/export specifier or default import
  naming a symbol (the V1 definition). Namespace imports carry references
  but no sites.
- **symbols** — distinct consumed symbols by declaration identity, so a
  symbol re-exported through several paths counts once. `references` sums
  external (non-import) references; `referencesPerSymbol` is their ratio,
  null when either side is unavailable or zero.
- **usage** — the boundary namespace plus symbol counts by per-boundary
  namespace (type-only / value-only / both). Reference counts are not split
  by namespace because `extends` and `unknown` contexts do not record one.
- **surfaceCoverage** — package-public symbols this consumer touches over
  the destination's package-public symbols. Null when the destination
  surface is unknown or empty. Consumers overlap, so coverages never sum.
- **source / destination modules** — contributions with `share` = the
  module's import sites over the boundary's import sites. Destination
  modules are the symbols' declaring files, not the imported barrel;
  barrels still appear as edge-only entries with zero sites. `breadth`
  counts modules carrying at least one site; `concentration` is the top
  share on each side.

Incoming boundaries carry the full vector. Outgoing boundaries are measured
from the target's import declarations alone (alias-resolved to the
declaring file; type-only by import syntax or type-only declaration), so
`references`, `packagePublic` and `surfaceCoverage` are null there. The
summary keeps incoming and outgoing separate, unions symbols across
boundaries, and reports `throughPaths` — distinct (consumer, dependency)
pairs routed through the target. Boundary chain depth is package gravity
depth; `--boundaries` shows it from the gravity section rather than
duplicating it. `analyzeBoundaryInteractions(report, outgoingImports)`
exposes the aggregation standalone; `collectOutgoingImports(project,
boundary)` produces the outgoing sites.

## Structural pressure

`report.structuralPressure` names places where independent measurements
converge. It is pure composition over the profile, module gravity and
boundary sections — no scanning, no score, no recommendation. A package
signal fires only when every gate in its config block matches, and each
block spans at least two measurement families (the builder throws if an
evidence set collapses to one dimension):

- `surface-pressure` — surface + consumption: large package-public surface,
  low export utilization, primary consumer share at or above the
  concentration threshold.
- `integration-pressure` — gravity + boundary: fan-out, dependency reach,
  outgoing import sites.
- `centralization-pressure` — gravity + boundary: fan-in, incoming
  references, and the top declaring module's share of all incoming import
  sites (destination modules summed across consumers — the V5.2 basis, so
  barrels do not count).
- `internal-structure-pressure` — gravity + complexity: module/package depth
  gap, fan-in of the top _internal_ module (aggregators excluded — a
  barrel's fan-in is surface, not an internal center), and the number of
  branch-heavy functions (≥ 6 control-flow decisions; expression decisions
  never count). Repository-wide, branch-heavy counts split cleanly (0–1 for
  twelve packages, then 3 and up) where total-decisions p95 cleared its old
  gate on 23 of 28 packages.

Every signal carries the raw evidence behind it (`dimension`, `metric`,
`value`) and the target's declared intent; anchoring never suppresses a
signal. Boundary signals (`boundary-pressure`) come from V5.2 interaction
facts alone and keep their shape: `broad` (volume by import sites or
references, plus symbol breadth), `concentrated` (moderate traffic with a
destination-module share at or above the configured share), or `mixed` when
both hold. Outgoing boundaries qualify by import sites since their
references are not measured. Signals never become opportunities.
`analyzeStructuralPressure(source, config)` runs standalone over
`{ architecturalProfile, dependencyGravity, boundaryInteractions, localComplexity }`.

## Churn

`report.churn` is the first evolutionary section: where the target's
current files change, how often, and how recently, read from local Git
history only (no network, no database). It is an inventory — raw counts,
distributions, and factual rankings — with no score, no hotspot, and no
combination with the static sections above.

- **Collector / analyzer split.** `collectGitHistory(root, { now })` runs
  one repository-wide `git log -z --numstat -M --relative` plus
  `git ls-files` and returns a normalized `GitHistory` (`commits`, newest
  first, each with `{ hash, timestamp, author, files[] }`; `trackedFiles`;
  `shallow`). `analyzeChurn(history, boundary, config)` is pure: the only
  clock it reads is `history.analyzedAt`.
- **Line churn** = additions + deletions from numstat. Binary changes carry
  no line counts; they add commits but zero lines.
- **Commits** are unique per file and unique per package: a commit touching
  five files counts once in `summary.commits`.
- **Window.** `config.churn.windowDays` (default 365; `null` = full history)
  limits commits, lines, and authors. `firstChangedAt`, `lastChangedAt`, and
  `daysSinceLastChange` always read the full history, so an untouched file
  still reports when it last moved. Timestamps are committer dates.
- **Renames** are followed: Git's rename detection (default similarity)
  maps the old path onto the current one, so history survives a `git mv`.
  Detection runs within the analysis root only; a file moved in from
  outside it starts fresh.
- **Current files only.** `files[]` covers paths Git tracks under the
  target today, minus the shared excluded directories (`dist`,
  `storybook-static`, …). Deleted paths are counted in
  `summary.deletedFiles` and otherwise dropped.
- **Authors** are distinct `%aN` names (after `.mailmap`); no email address
  is ever recorded. `ownership.primaryAuthorShare` is the largest single
  author's share of the file's window commits. Author counts and shares
  are informational only: this repository is effectively single-author,
  so no higher-order gate reads them.
- **Kinds.** Each file is `source`, `test`, `story`, `config`, or `other`
  by path convention; `summary.byKind` splits files, unique commits, and
  line churn. Raw line churn (`additions + deletions`) is kept as measured
  and is dominated by generated artifacts such as Drizzle snapshots;
  higher-order signals read commit frequency and per-kind percentiles,
  never raw line volume.
- **Population.** `repository` carries the same distributions over every
  tracked file in the root so a file can later be placed repository-wide.
- **Unavailable.** Outside a Git work tree the section is
  `{ available: false, reason }` and the rest of the report is unaffected.
  Shallow clones set `history.historyComplete: false`.
- **Rank.** Every target file carries `rank.commitPercentile` and
  `rank.lineChurnPercentile`: its placement (0–1) among all repository
  files of the same kind, as the share of that population with a strictly
  lower value. Ties share one placement; the population maximum sits just
  under 1.

## Hotspots

`report.hotspots` names files where frequent change meets structural
complexity. It composes churn (V6.0) with local complexity (V4) and
decorates with module gravity (V5); no Git is reparsed and no AST is
walked. Observations only — no score, no opportunity.

- **Population.** Files whose churn kind is in
  `config.hotspots.eligibleKinds` (default `["source"]`). Tests, stories
  (`*.stories.*` and anything under a `stories/` directory), config, and
  generated artifacts keep their churn in V6.0 but never become hotspots
  under the default policy.
- **Eligibility.** The commit gate is mandatory:
  `rank.commitPercentile ≥ minCommitPercentile` (repository-relative, same
  kind, same churn window). Then at least one complexity condition must
  hold (OR): max control-flow decisions in one function (≥ 6), max nesting
  (≥ 4 — at 3 the gate admitted files with three or four decisions; every
  hot file at 4 is already branch-heavy, so `deep-control-flow` is now a
  label rather than a door), or total control-flow decisions spread over at
  least `minFunctionsForDense` functions. Expression decisions (`&&`, `||`,
  ternaries) are reported but never gate, so JSX-heavy render code does not
  qualify on syntax alone. Line churn and authorship never gate.
- **File complexity** folds V4 function records per file: function count,
  control-flow and expression decisions (total and single-function max),
  max nesting, statements (total and max). One difficult function is never
  averaged away.
- **Signals.** `frequent-change` (always), `branch-heavy`,
  `deep-control-flow`, `complexity-dense`, and `architecturally-central`
  when the file is a module node whose fan-in or fan-out meets
  `config.hotspots.architecture`. Gravity never creates eligibility.
- **Ranking.** Commit percentile desc, commits desc, max control-flow
  decisions desc, path. `rank.complexityPercentile` is target-relative
  among eligible files on max control-flow decisions.
- `analyzeHotspots(source, config)` runs standalone over
  `{ target, churn, localComplexity, dependencyGravity }`.

## Change coupling

`report.changeCoupling` names files and packages that repeatedly change in
the same commits, and whether the current static graph explains each
pair. It reads the V6.0 `GitHistory` (no second `git log`) and the
workspace module graph. Pairs only — no clusters, no score, no
recommendation.

- **Co-change.** Two current files co-change when one commit touches both
  (renames resolved through the churn alias map). Pairs are generated from
  commit membership, never from an all-files scan; `left < right`
  lexically, one record per unordered pair.
- **Commits considered.** The shared history filter (`config.history`,
  also behind change radius and evolutionary pressure): churn-window
  commits with ≥ 1 eligible current file that are not oversized. A commit
  is oversized when it has more than `maxCodeFilesPerCommit` (40) source,
  test, or story files, or when it is config-dominant and spans at least
  `configSweepMinPackages` (5) packages — version bumps and tooling sweeps
  (30 files over 26 packages, 21 over 17) that read as cross-package
  evolution otherwise. Oversized commits generate no pairs and are counted
  in `history.commitsExcluded`; churn still counts them, so `leftCommits`
  can be lower than `churn.files[].commits`. Each commit also carries a
  composition (`source-dominant` ≤ 25% config, `config-dominant` ≥ 50%,
  else `mixed`), by file kind alone — never from the message.
- **Eligible kinds.** `source`, `test`, `story`, `config` by default;
  `other` (docs, generated JSON) keeps its churn but forms no pairs.
  Repository-root files (`<root>` owner) count as files but never as a
  package, so a root `package.json` riding along does not make a commit
  cross-package.
- **Measures.** `leftConditional = co / leftCommits` (how often left's
  change included right), `rightConditional = co / rightCommits`,
  `jaccard = co / (left + right − co)`. Divide-by-zero yields 0.
- **Gates.** `coChangeCommits ≥ minCoChangeCommits` (3) AND (either
  conditional ≥ `minConditional` (0.5) OR `jaccard ≥ minJaccard` (0.3)).
  Support is always shown so 100% never hides 1-of-1.
- **Static relation.** Direct module edges only: `left-to-right` (left
  imports right), `right-to-left`, `bidirectional`, `none`, or
  `unmeasured` when a side is not a graph module (non-TS files, tooling
  config, `.d.ts`). An import routed through a package barrel lands on the
  barrel, so a test importing `../index` reads as `none` against the
  implementation file it exercises. Only `none` counts as "no static
  edge". Package relations map module edges through ownership.
- **Static path.** Reachability in either direction on the same graph:
  `direct` restates the relation, `indirect` means a path exists (the
  barrel case above), `none` means the graph offers no explanation,
  `unmeasured` as for the relation. Repository-wide, 406 of the 1,473 pairs
  with no direct edge turned out to be indirect. The direct-edge fact is
  never changed.
- **Context.** Which kinds a file pair joins: `source-source`,
  `source-test`, `test-test`, `config-config`, `story-related` (either
  side a story), or `mixed` (config with source or test). Lets consumers
  keep test companions apart from parallel implementations without
  touching the coupling facts.
- **Packages.** Each commit's eligible files collapse to a unique owner
  set, so five files across two packages count as one package co-change.
- **Scope.** File pairs touch the target on at least one side and are
  tagged `same-package` / `cross-package`; package pairs involve the
  target package. Commit totals are repository-wide.
- **Order.** Co-change commits desc, Jaccard desc, larger conditional
  desc, then ids.
- `analyzeChangeCoupling(history, { boundary, graph }, config)` runs
  standalone.

## Change radius

`report.changeRadius` describes how wide a change to the target typically
is: for every window commit that touches the target, the number of
current files, owning packages, and static package boundaries it moved
across the whole repository. Raw distributions and per-commit records
only — no radius label, no score, no coupling strength.

- **Files.** Unique current files of an eligible kind (`source`, `test`,
  `config` by default) after rename resolution, minus excluded
  directories; `sourceFiles` and `filesByKind` keep the split.
- **Packages.** Distinct owners of those files (graph ownership, else the
  nearest `package.json`).
- **Boundaries.** Directed static package edges (module edges mapped
  through ownership) with both endpoints touched. `A → B → C` touched
  together crosses 2; unrelated `A + C` crosses 0 while still counting as
  2 packages.
- **Target-relative.** A commit is listed when ≥ 1 of its files belongs
  to the target; its radius is the full repository radius. `targetFiles`
  and `targetFileShare` record the target's part.
- **Oversized commits.** The shared `config.history.oversized` rule (see
  change coupling): oversized commits count in `history.commitsObserved`
  and `commitsExcluded` but not in distributions or `commits[]`. Each
  listed commit carries its `composition`; `<root>` files are counted but
  never form a package.
- **Distributions** use the nearest-rank helper shared with complexity and
  churn. `crossPackageRate` = commits touching > 1 package ÷ eligible;
  `boundaryCrossingRate` = commits crossing ≥ 1 static edge ÷ eligible.
- **Combinations.** The most frequent multi-package sets touched together
  (shapes, not pair strength — that is change coupling).
- **Order.** Packages desc, source files desc, files desc, newest first,
  hash.
- `analyzeChangeRadius(history, { boundary, graph }, config)` runs
  standalone; `eligibleCommits(history, filter)` is the shared
  window/kind/size filter.

## Evolutionary pressure

`report.evolutionaryPressure` asks one question of the sections above:
does development history reinforce, contradict, or leave unsupported what
structural pressure already decided? Pure composition — no Git reparse,
no re-evaluation of a V5 gate, no score, no recommendation.

- **Three outcomes.** Each V5.3 signal lands in exactly one of
  `reinforced` (history shows the same shape) or `staticOnly` with status
  `static-only` (adequate history, checked evidence fell short — not
  disproven) or `insufficient-history` (too few commits to interpret).
- **Support gate.** `evolutionaryPressure.support.minCommits` (10) on
  eligible change-radius commits. Below it, `reinforced` and `tensions`
  are empty; hubs (evidence, not conclusions) remain. Repository-wide
  eligible commits run 10 and up for twenty packages and 9 and down for
  the rest; `@foundry/templates` (9), `@foundry/environments` (8), and
  the two packages sitting exactly at 10 are the marginal cases.
- **Reinforcement rules.** Integration: boundary-crossing rate at or
  above `integration.minBoundaryCrossingRate`, or at least one recurring
  package pair with a direct static path (the rate alone sat in a dense
  part of the distribution — six packages within ±0.05 of 0.5 — and the
  former cross-package-rate gate was implied by this one). Surface: the
  primary consumer recurs as a package coupling partner or the dominant
  two-package combination at or above `coupling.minPackageCommits`.
  Centralization: a top incoming seam (declaring modules ranked by import
  sites, the V5.3 destination basis) is high-churn, a hotspot, or
  cross-package coupled; quiet seams are listed as not reinforced.
  Internal structure: a hotspot in a high-fan-in module, a hot hub whose
  role is internal, or same-package source ↔ source coupling around a
  high-fan-in internal module. A hot barrel is listed as a hub but does
  not reinforce internal structure: a churning surface is not an internal
  center.
- **Tensions.** `static-leaf-temporal-coupling` (leaf-like profile plus
  recurring package coupling or combination); `static-pressure-low-
evolution` (pressure present, mostly local change, no hotspots, no
  recurring coupling); `temporal-coupling-without-static-path` (a
  source ↔ source pair with static path `none` at or above
  `coupling.minFileCommits`, one per pair — test, story, and config
  companions stay visible on the V6.2 pairs but are not tensions).
- **Hot structural hub.** A source file whose commit percentile and module
  fan-in both clear the hub gates, whatever its function count, carrying
  its module `role`. Evidence only; hotspot rules are untouched.
- **Spread.** `edgeLessSpreadCommits` = cross-package commits −
  boundary-crossing commits, straight from the radius summary
  (edge-following spread is `boundaryCrossingRate` itself and is not
  restated).
- **Evidence.** Every signal and tension carries the static evidence
  (V5.3's own) and the historical values read, each tagged with its
  dimension and, where relevant, the file, package, or pair it describes.
- `analyzeEvolutionaryPressure(source, config)` runs standalone over the
  report sections (static paths come from V6.2, roles from gravity);
  `renderEvolution` is the focused view behind `--evolution`.

## Concept inventory

`report.conceptInventory` starts a different layer: not files, modules,
and dependencies, but the named semantic identities those structures
represent. V7.0 is a deterministic inventory — no ownership claim, no
merging of look-alike names, no similarity, no score, no recommendation.

- **Seeds.** Every top-level `interface`, `class`, `type`, and `enum`
  declared in the target (`concepts.seedKinds`), exported or not.
  Functions and constants never seed a family; they participate as
  representations. A primitive alias (`type WorkspaceId = string`) is a
  seed. Anonymous structural types and stdlib types are not.
- **Identity.** The resolved declaration node — the same identity the
  symbol inventory uses. Two `Status` interfaces in different packages are
  two seeds; a barrel or `export … from` never adds one, and import
  aliases resolve back to the original declaration.
- **Relationships.** One pass over the workspace collects explicit
  TypeScript structure only: `implements`, `extends` (direction kept),
  `alias` (a type alias whose whole right-hand side is the seed),
  `parameter-type`, `return-type`, `property-type`, `type-reference`
  (other type positions), and `constructs` (`new Seed()`). Generic
  wrappers are looked through: `Promise<Seed>` as a return type is a
  `return-type` reference to `Seed`, and `Promise` gets no family.
  Self-references (a seed named inside its own declaration) are ignored.
- **Evidence → representations → counts.** `evidence` is the raw list,
  one entry per occurrence with file and line and, where one exists, the
  nearest enclosing named top-level declaration as `source` (in the
  symbol-inventory id convention; methods roll up to their class,
  module-level code has no source). `representations` roll evidence up to
  one entry per source symbol and relationship (`implementation`,
  `extension`, `alias`, `factory` for return types, `type-user`, `other`
  for constructions) with an occurrence count; `relationships` are
  per-kind counts.
- **Distribution.** Packages and modules holding the declaration or any
  evidence, with counts; `references` counts every non-declaration
  occurrence, in-target and out, so it is not the surface report's
  external-reference count. `packagePublicRepresentations` is assessed for
  in-target symbols only. The declaring package is `declaration.package`,
  not an owner. `distributedFamilies` = more than one module,
  `crossPackageFamilies` = more than one package; no threshold beyond that.
- **Report.** The default report carries a two-line `CONCEPTS` section.
  `renderConcepts` (`--concepts`) lists the most distributed families,
  contract families (two or more implementations) with their
  implementations, and cross-package families with the representations
  outside the seed package. `renderConceptFamily` (`--concept <name>`)
  shows one family's representations, relationship counts, distribution,
  and evidence.
- `analyzeConceptInventory(source, config)` runs standalone over the loaded
  project, boundary, collected symbols, and surface symbols.

## Concept distribution

V7.1 answers where each V7.0 family lives. Every family carries a
`distributionAnalysis`; membership still comes only from the explicit
TypeScript relationships above. Nothing here adds a member, merges two
families, or names an owner.

- **Representations.** One per distinct symbol attached to the family
  (a symbol attached by two relationships counts once) plus the seed. Per
  package: count and the kinds present (`seed`, `implementation`,
  `extension`, `alias`, `factory`, `type-user`, `other`). `primaryShare`
  is the largest package's share; ties go to the lexically first package.
  `implementationPackages` / `implementationModules` count where
  `implementation` representations live.
- **References.** The V7.0 `distribution.references` count attributed by
  package and module with shares; `primaryShare` is null with no
  references. Module-level evidence counts here although it has no
  representation.
- **Relationships.** Per relationship kind, the occurrence count by package.
- **Boundaries.** `seedPackage`, the sorted representation and reference
  packages, `moduleCount`, and `packageSpan` = distinct participating
  packages (declaration ∪ evidence) − 1. Breadth, not path depth.
- **Package matrix.** `packages[]` holds one row per participating package:
  `seed` (declared here — a fact, not ownership), representation,
  implementation, and reference counts, and the relationship kinds present.
  Sorted by references, then representations, then name.
- **Shapes.** `local` (one package) or `cross-package`, always one of the
  two; then additively `implementation-split` (implementations in ≥ 2
  packages), `reference-distributed` (references in ≥
  `conceptDistribution.referenceDistributed.minPackages` packages and no
  package above `maxPrimaryReferenceShare`), and
  `representation-concentrated` (≥ `minRepresentations` representations,
  one package holding ≥ `minPrimaryShare` of them, references in ≥ 2
  packages). Descriptive only.
- **Temporal.** Existing V6 outputs annotate known members: the strong
  file pairs whose two sides are both representation files (with the
  member names on each side), representation names whose file is a
  hotspot, and how many in-target representation files have churn. Pairs
  come from `changeCoupling.filePairs`, which touch the target on at least
  one side, so two out-of-target members never pair. A strong pair with
  one side outside the family is not listed. No Git reparse.
- **Report.** The default `CONCEPTS` section adds a shape-count line.
  `--concepts` adds `DISTRIBUTION SHAPES` and capped sections for
  implementation-split, reference-distributed, representation-concentrated,
  and co-changing families. `--concept <name>` adds shapes, span, seed
  package, primary representation and reference packages, references by
  package and module, relationships by package, the package matrix, and
  the temporal context.
- `analyzeConceptDistribution(inventory, source, config)` runs standalone
  over a `ConceptInventoryReport` and the `churn`, `hotspots`, and
  `changeCoupling` sections; `attachConceptDistribution` folds the result
  back onto the families.

## Concept overlap

`report.conceptOverlap` (V7.2) lists pairs of _separate_ concepts whose
deterministic evidence says they may be representations of one idea. A
candidate is two families plus evidence; nothing is merged, no side is
canonical, nothing is recommended.

- **Universe.** Left is always a target seed; right is any top-level
  `interface`, `type`, `class`, or `enum` in the workspace (`inTarget`
  marks seeds). Usage and distribution evidence exist only when both sides
  are target seeds, since foreign declarations have no family.
- **Generation, not all-pairs.** Four indexes propose pairs: shared
  non-generic name tokens, shared non-common property names (≥
  `minSharedProperties`, from syntax members, no checker), converter
  signatures, and V6-coupled declaration files. Buckets larger than
  `generation.maxIndexFanout` propose nothing. Pairs already inside one
  family (a seed and its implementation, extension, or alias) and siblings
  of one family (two implementations of one contract) are dropped.
  `generation` reports the counts.
- **Name affinity.** Names split on camelCase, PascalCase, snake_case, and
  kebab-case; `name.genericTokens` (`record`, `config`, `options`, …) are
  dropped before comparing; evidence when the Jaccard of the remaining
  tokens reaches `name.minJaccard`. `UserConfig` / `DatabaseConfig` share
  nothing.
- **Structure.** Object-like declarations (unions and intersections of
  objects included; primitives, literal unions, and enums excluded) get a
  property shape: name, optional, readonly, callable, and the checker's
  printed type. Overlap = shared, left-only, right-only names, Jaccard,
  shared over each side, and `compatibleShared` (same printed type or
  assignable either way). Assignability is the checker's, both directions.
  `properties.commonNames` (`id`, `name`, …) never generate pairs but do
  count in ratios. When both sides derive from `Error`, the inherited
  `properties.errorBaseNames` (`name`, `message`, `stack`, `cause`) are
  recorded as `baseShared`: still in `shared` and the ratios, but they
  satisfy no gate, and assignability between two errors with no own
  overlap is not structural evidence. Own properties on an error count
  normally.
- **Conversion.** A function, method, or arrow whose parameter resolves to
  one concept and whose return type resolves to the other, looking through
  `conversion.wrappers` (`Promise`, `Array`, …) and `T[]`. Both sides must
  be data shapes (at least one non-callable property), so a signature that
  takes a store contract and returns an entity is an accessor, not a
  conversion. The converter is excluded from shared consumers.
- **Gate.** Evidence dimensions (`name`, `structure`, `usage`,
  `conversion`, `distribution`, `temporal`) must number ≥
  `gates.minEvidenceDimensions`, and one of: property overlap passing
  `properties.minSharedProperties` and `minJaccard`, an assignability
  relation, or an explicit conversion. Name alone never qualifies; history
  alone never qualifies (a temporal-only pair is generated and rejected).
- **Shapes** (several may apply): `near-equivalent` (assignable both ways,
  or Jaccard ≥ `shapes.nearEquivalentMinJaccard` with every shared property
  compatible; either way at least `shapes.minSharedProperties` own shared
  properties, so `{ kind }` matching `{ kind }` is not equivalence),
  `projection-like` (one-way assignable, or the smaller shape's compatible
  properties cover ≥ `projectionMinSubsetShare` of it with the same
  minimum), `conversion-pair` (explicit converters, whatever the structural
  overlap), `structurally-overlapping` (property gate or assignability,
  neither of the first two). The temporal context carries the V6 coupling
  `context` (`source-source`, `source-test`, …).
- **Order.** Dimensions desc, property Jaccard desc, conversion present,
  left id, right id. No composite score.
- **Report.** The `CONCEPTS` summary adds one candidate line; `--concepts`
  ends with a `CONCEPT OVERLAP` section capped by `report.topCandidates`;
  `--concept <name>` lists that seed's candidates.
- `analyzeConceptOverlap(source, config)` runs over the loaded project,
  boundary, collected symbols, the concept inventory, and the coupling
  report. `assessOverlap(facts, config)` is the pure gate; `nameAffinity`
  and `nameTokens` are exported for tests and tooling.

## Concept ownership

`report.conceptOwnership` (V7.3) says where each family's centers sit.
"Ownership" is analytical: declared in, represented most in, referenced
most in, implemented in, and changed with are measured separately, and the
report describes whether they converge. No owner is declared, nothing is
moved, families and overlap candidates are untouched.

- **Candidates are packages.** A package participates when it holds the
  seed, an implementation, ≥ `candidates.minRepresentations` named
  representations, ≥ `candidates.minBehaviors` explicit behaviors, or ≥
  `candidates.minReferenceShare` of references (OR-style). Each candidate
  carries `evidence` (`dimension.metric = value`), its `dimensions`,
  `roles`, and raw `participation`. Order: dimensions desc,
  representations, references, behaviors, package name. No score.
- **Behavior attribution.** Executable symbols explicitly attached to the
  seed, from V7.0 evidence: a function or arrow whose signature names the
  seed (parameter, return, or construction) is _contract_ behavior; every
  bodied member of a class that implements the seed is _implementation_
  behavior (methods need not mention the seed); a member of any other class
  counts only when the evidence line falls inside it. Interface members are
  declarations. Only representation files are opened, through a memoized
  top-level index on the existing project. Every behavior row and
  `representationKinds` split the counts by the kind of file declaring
  them (`source`, `test`, `story`, `config`, `other`).
- **Centers**, each with its own gate: `semantic` is the seed package;
  `implementations` are packages holding an `implements` representation;
  `representation`, `usage`, and `behavior` are the primary package when
  its share reaches `representationCenter` / `usageCenter` /
  `behaviorCenter`. Representation and behavior centers (and their
  tensions) read only the file kinds in `fileKinds` (default `source`) and
  behavior counts contract behavior only; test helpers and story-only
  types stay visible in the raw counts, participation, and
  `representation.share` / `behavior.contractShare` evidence, next to the
  `sourceShare` / `sourceContractShare` the gate read. `evolution` is the
  package with the most historical support (changed representation files +
  hotspot representations + strong member coupling pairs whose context is
  in `evolutionCenter.couplingContexts`, default `source-source`) at ≥
  `evolutionCenter.minHistoricalSupport`; every pair is still listed under
  `couplings` with its context, co-change commits, both conditionals,
  Jaccard, and whether an aggregator sits on either side, and hotspot
  representations keep their commit count and percentile. Every tie
  resolves to the seed package, then lexically, so a center never leaves
  the seed by chance. Churn and hotspots are target-scoped, so a foreign
  package is supported only through coupling pairs and their per-file
  commits; a pair kept by one side's conditional (the target changes with a
  large consumer far more often than the reverse) counts like any other.
- **Alignment.** `insufficient-evidence` below `support` (checked first;
  no centers are inferred); `divergent` when a `seed-vs-*` tension holds;
  `aligned` when every inferred center is the seed package and
  implementations live only there; `distributed` otherwise.
- **Tensions.** `seed-vs-representation` and `seed-vs-behavior` need the
  observed package to hold ≥ `tensions.minShare` of a dimension with ≥
  `tensions.minRepresentations` / `minBehaviors` total; `seed-vs-evolution`
  needs an evolution center elsewhere; `usage-vs-semantic-center` is
  descriptive and never divergent on its own (a widely consumed primitive
  is normal); `anchor-vs-observed-center` is added when the seed package is
  anchored and at least `tensions.anchorMinConvergingDimensions` `seed-vs-*`
  tensions point at one other package — references elsewhere alone never
  question an anchor. The anchor reason is kept as an `anchored-seed`
  caution; `no-implementation-evidence` means only that no `implements`
  clause was found, since structural (object-literal, factory) conformance
  is not analyzed.
- **Overlap context.** Each V7.2 partner of the seed is listed with the
  packages its converters live in. `representationBoundary` marks a partner
  in another package with converters there — a domain/persistence split
  described, not judged, and never a divergence by itself. Converter
  location is conversion evidence on the candidate, not a center.
- **Report.** The `CONCEPTS` summary adds an alignment line; `--concepts`
  ends with `CONCEPT OWNERSHIP` (divergent and distributed concepts, capped
  by `report.topConcepts`); `--concept <name>` adds an `OWNERSHIP` section
  with centers, tensions, candidates, behavior, evolution, cautions, and
  representation boundaries with the partner's centers when it is a seed.
- `analyzeConceptOwnership(source, config)` composes the inventory (with
  distribution attached), overlap, churn, hotspots, coupling, the
  architectural profile, and the anchor; `assessOwnership(facts, config)`
  is the pure gate. Its behavior rows carry the individual `participants`
  (symbol, file, package, file kind, role) so later layers need no second
  scan.

## Behavioral locality

`report.conceptBehavioralLocality` (V7.4) says how far understanding or
changing one concept's behavior travels: across how many modules,
packages, and dependency steps, and whether that spread is a few intended
boundaries or genuine scatter. It consumes V7.0–V7.3 facts and never
reinterprets them: families, overlap candidates, centers, alignment, and
tensions are untouched, and no ownership tension or opportunity is added.

- **Participants** are the V7.3 behavior participants: functions whose
  signature names the seed, and bodied members of implementing classes.
  A V7.2 converter tags the matching participant `conversion` (once,
  however many partners it converts to); a converter V7.3 did not
  attribute — its signature wraps the concept in a `Promise` or array,
  which V7.2 looks through — joins as one conversion participant.
  Reference-only consumers, imports, and type-only declarations never
  count. A module is a root-relative file, the same node as the module
  graph and `ConceptDistribution.modules`.
- **Behavior map.** Every participant by file kind (`source`, `test`,
  `story`, `other`), by package, and by module (with the target's module
  role when known). The shape reads source behavior only; test and story
  behavior stay visible and raise `test-heavy-behavior` when they outnumber
  it.
- **Span** counts source modules and packages and lists `boundaryEdges`:
  direct package-graph edges (`from` imports `to`) between two behavior
  packages — actual edges, not `packages − 1`.
- **Traversal.** Shortest paths over the workspace module graph and the
  package graph derived from it, memoized per start node and computed only
  for participating nodes. Origin is the semantic center: the seed package
  for `centerDistances`, the seed's declaring module for `moduleDistances`.
  `outward` follows dependency edges from the origin (it imports … the
  target); `inward` is the reverse; neither means disconnected, and no
  undirected distance is invented. `packageDistances` covers every pair of
  behavior packages so two implementation packages that never reach each
  other stay visible (`disconnectedPackagePairs`); `disconnectedModules`
  are source modules with no path to or from the seed module. A module
  distance notes when a known aggregator sits strictly inside the path.
  Barrels hold no bodied symbols, so they never count as behavior modules;
  they appear only on paths.
- **Change surface** is observed, not predicted: source modules and
  packages, implementation and converter modules, source modules that are
  V6.1 hotspots, and behavior modules in a strong V6.2 pair with another
  behavior module. **Reference halo** (`packages`, `modules`,
  `references` from V7.1) sits beside it and never enters the shape;
  `concentration` gives the primary package and module share of source
  behavior; `distribution` restates the V7.1 representation and reference
  primaries for comparison.
- **Temporal** (when history is available): behavior modules that are
  hotspots with commits and percentile; `internalCouplings` — strong pairs
  with both sides in the behavior map, context preserved; and
  `externalCompanions` — a behavior module's strong partner outside the
  map, listed but never added to the map. Churn and hotspots are
  target-scoped: `target-scoped-history` is raised when source behavior
  lives outside the target.
- **Shapes** (`shape.primary`, one always applies; `shape.modifiers`
  additive), gated by `behavioralLocality` counts and distances, never a
  score: `insufficient-evidence` below `support.minSourceBehaviors`;
  `behavior-light` when references reach `behaviorLight.minReferenceModules`
  modules with at most `behaviorLight.maxSourceBehaviors` source behaviors
  (a semantic type consumed widely, usually healthy) — never for a class
  seed, whose own members V7.3 does not attribute; one package (the
  behavior's, not necessarily the seed's — read `local` beside V7.3
  alignment and the center distances) is `local` below
  `singlePackageDistributed.minModules` and `single-package-distributed`
  at or above it; several packages are
  `cross-package-distributed` at ≥ `crossPackageDistributed.minModules`
  source modules with either ≥ `minPackages` packages or traversal breadth
  (max module distance ≥ `minTraversalDistance`, a disconnected package
  pair, or a disconnected module), and `cross-package-localized` otherwise
  — the usual domain/persistence split. `parallel-implementations` is
  added when source implementation behavior sits in ≥
  `parallelImplementations.minPackages` packages. Cautions:
  `structural-conformance-unobserved` (mirrors V7.3
  `no-implementation-evidence`), `test-heavy-behavior`,
  `sparse-source-behavior` (below `support.sparseSourceBehaviors`, only
  where the shape claims spread), `disconnected-static-path`,
  `target-scoped-history`.
- **Report.** The `CONCEPTS` summary adds a locality line; `--concepts`
  ends with `BEHAVIORAL LOCALITY` (cross-package concepts, capped by
  `report.topConcepts`); `--concept <name>` adds a `BEHAVIORAL LOCALITY`
  section with shape, source and other behavior, concentration, packages,
  modules, traversal, change surface, halo, distribution, temporal
  context (external companions capped by `report.topExternalCompanions`),
  and cautions.
- `analyzeConceptBehavioralLocality(source, config)` composes the
  inventory, overlap, ownership, gravity (module roles), coupling,
  hotspots, the workspace module graph, and the anchor;
  `assessLocality(facts, config)` is the pure shape and caution rule.

## Re-centering candidates

`report.recenteringCandidates` (V8.0) asks whether a concept's current
placement still matches the structure the codebase exhibits: which
families show enough deterministic disagreement between placement and
observed centers that considering an alternative arrangement is justified.
It names no destination, predicts no delta, ranks nothing, and moves
nothing; those belong to later V8 steps. Observed architecture (centers,
behavior, locality, gravity, coupling) stays separate from intended
architecture (seed placement, boundaries, anchors), and observed is never
treated as more correct than declared.

- **Subject** is the V7.0 concept family. Overlap pairs contribute context
  only; no merged concept is created.
- **Behavior evidence kinds.** V7.3 attribution is untouched; V8.0 reads
  each participant's own evidence (inside its line range, so one class
  member is classified by what it does, not by its class) and names it
  `implementation`, `conversion`, `return` (a factory that constructs and
  returns the concept reads as `return`), `construction` (constructs
  without returning: throwing, storing), or `parameter-consumer`. Only the
  first three are strong; accepting or constructing the concept is use,
  not owned behavior, so `Db`, `ArtifactId`, or an `Error` class thrown
  everywhere stay `parameter-consumer-dominated` and never become
  candidates on breadth alone. Test and story participants never count.
- **Tensions** (`RecenteringTension`), one dimension each:
  `semantic-vs-behavior`, `semantic-vs-representation`, and
  `semantic-vs-evolution` reuse the V7.3 seed-vs-* tensions (behavior is
  strong only when the observed package holds ≥
  `candidates.minStrongBehaviors` strong behaviors); `anchor-conflict`
  reuses `anchor-vs-observed-center`; `usage-vs-semantic-center` is
  evidence, never a tension. `behavioral-scatter` needs V7.4
  `cross-package-distributed` behavior whose strong part is genuinely
  spread: ≥ `scatter.minStrongModules` modules and `minStrongPackages`
  packages, under `maxTopTwoModuleShare` in the two largest strong modules
  (ModuleStore's 89% in two implementations is `behaviorally-concentrated`,
  not scattered) and under `maxWeakShare` weak behavior.
  `implementation-scatter` is conversion or return behavior in packages
  that are neither the seed nor an implementation center (≥
  `implementationScatter.minSupportingBehaviors`). `boundary-friction`
  is a package edge between two behavior packages whose V5.2 interaction
  is heavy (`boundaryFriction.minImportSites`, `minSourceModules`), with
  concept modules among both the importing and the imported modules and ≥
  `minForeignReturnBehaviors` return behaviors on the foreign side —
  implementing or converting alone is a split, not friction.
  `dependency-misalignment` is a foreign package holding ≥
  `dependencyMisalignment.minStrongShare` of strong behavior and ≥
  `minSeedImportSiteShare` of the import sites into the seed's declaring
  module. `temporal-misalignment` is ≥ `temporal.minCrossPackageCouplings`
  strong source-source pairs between behavior modules of different
  packages; history strengthens a structural hypothesis and never creates
  one.
- **Shapes** are the strong structural conditions, each a corroborated
  combination: `mis-centered` (strong behavior tension plus
  representation, evolution, or dependency pointing at the same package),
  `behaviorally-scattered`, `representation-drift` (representation tension
  with behavior or evolution favoring the same package),
  `implementation-drift` (implementation scatter, or a strong behavior
  tension pointing at a foreign implementation center),
  `boundary-strained` (friction on a genuinely spread concept with a
  cross-package coupling on the same boundary), and `intent-protected`.
- **Eligibility.** A family is emitted when it has any tension; it is a
  `candidate` at ≥ `candidates.minEvidenceDimensions` distinct dimensions
  with at least one shape, `protected` when that holds but the seed package
  is anchored (the evidence stays; certain moves are prohibited, not the
  candidate), and `insufficient-evidence` otherwise. Families without a
  tension are counted in `summary.evaluated` only. Distributed ownership,
  a cross-package split, a broad reference halo, or a persistence pair
  with converters is never enough by itself.
- **Context and cautions.** `currentPlacement` restates the V7.3 centers;
  `behavior` is the kind profile; `locality` copies the V7.4 facts plus
  the top-two module share; `history` counts hotspot modules and lists
  cross-package couplings; `intent` records the seed anchor, anchored
  observed packages, and V7.2 representation boundaries (partner,
  converter packages, bidirectionality, structural overlap). Cautions:
  `parameter-consumer-dominated`, `sparse-strong-behavior`,
  `behaviorally-concentrated`, `representation-boundary`, and the V7.4
  `test-heavy-behavior`, `structural-conformance-unobserved`,
  `target-scoped-history`.
- **Ordering** is strong tensions, dimensions, strong behavior,
  historical support, then name — deterministic, no composite score.
- **Report.** The `CONCEPTS` summary adds a re-centering line;
  `--concepts` ends with `RE-CENTERING CANDIDATES` (candidates and
  protected entries, capped by `report.topCandidates`); `--concept <name>`
  ends with a `RE-CENTERING` section: status, shapes, tensions,
  dimensions, placement, behavior by package, locality, history, intent,
  every evidence item with its source, and cautions.
- `analyzeRecenteringCandidates(source, config)` composes the inventory,
  overlap, ownership, locality, boundary interactions, gravity, and the
  configured anchors; `assessRecentering(facts, config)` is the pure
  tension, shape, status, and caution rule; `classifyParticipants` is the
  behavior-kind reading.

## Mis-centered concepts

`report.recenteringCandidates.miscentered` (V8.1) asks one narrower
question of every family: does the package the code says a concept lives
in agree with where its usage, symbols, and behavior gravitate? A finding
is a mis-centering signal, never a verdict, a destination, or a move. The
detector reuses V8.0 facts only; there is no second gravity system.

- **Declared home** is the seed declaration: package and module.
- **Observed centers** are every package with a composite gravity in
  [0, 1]: the weighted mean of three per-package shares, renormalized over
  the families that have data — governing behavior (V8.0 behavior kinds
  `conversion` and `return`, plus `implementation` when the seed is a
  class; `implements` of an interface or type alias is adapter behavior
  and never counts), V7.1 representation share, and V7.1 reference share.
  Weights are `miscentering.gravity.weights`; producing or governing the
  concept outweighs using it. Import sites into the seed module are
  measured across boundaries only, so `dependency-gravity` is evidence
  and never part of the composite.
- **Evidence families** (`MiscenteringEvidenceKind`): `behavioral-locality`,
  `symbol-distribution`, `consumer-gravity`, `dependency-gravity`,
  `boundary-crossing` (a V7.4 boundary edge whose V5.2 interaction has
  concept modules on both sides), `concept-distribution` (V7.1 shapes),
  and `ownership` (the V7.3 evolution center). A family points at a
  package at ≥ `minFamilyShare`; a signal needs ≥ `minEvidenceFamilies`.
- **Signals**, one per concept, in precedence order. `external-gravity`:
  the strongest other package reaches `external.minAlternativeGravity`,
  leads the home by `external.minMismatch`, and behavior is among its
  supporting families — consumption alone is never enough.
  `boundary-drift`: the home keeps the symbol center while ≥
  `drift.minForeignShare` of governing behavior (≥ `minForeignBehaviors`)
  sits outside it, corroborated by a boundary crossing, a foreign
  evolution center, or an implementation split. `split-gravity`: no
  package reaches `split.maxTopGravity`, ≥ `minPackages` reach `minShare`,
  behavior itself divides, and a second family divides too; a
  consumption-heavy concept (more parameter and construction behavior
  than strong behavior) never reads as split, since a shared type's few
  producers naturally scatter among its consumers.
- **No finding** is explained per family in `assessed`: `aligned`,
  `behavior-light` (fewer than `candidates.minStrongBehaviors` governing
  behaviors — identifiers, shared types, interfaces implemented
  elsewhere), `usage-only` (consumption tilts the composite while
  behavior stays home), `unclear` (a mismatch below every gate).
- **Evidence confidence** is how well the deterministic evidence matches
  the signal's pattern, not the probability the concept is misplaced:
  supporting families over families with data, scaled by
  `0.5 + 0.5 × magnitude`, where magnitude is the mismatch over twice
  `external.minMismatch` (external), the foreign behavior share (drift), or
  one minus the strongest gravity (split). `mismatch` is the strongest
  other center's gravity minus the home's; ranking context only.
- **Anchors** never suppress a finding. An anchored home sets `anchored`
  and adds `declared-home-anchored`; an anchored observed center at ≥
  `split.minShare` adds `observed-center-anchored`. Other cautions:
  `adapter-implementations`, `unobserved-conformance` (no `implements`
  names the interface, so foreign factories returning it may be adapter
  factories), `consumption-heavy`, `representation-boundary`.
- **Ordering** is evidence confidence, mismatch, then name.
- **Report.** `--concepts` ends with `MIS-CENTERED CONCEPTS` (the top
  `miscentering.report.topFindings`, one line each); JSON carries every
  center, share, evidence row, and outcome. `renderMiscenteredFinding`
  is the focused view, exported for callers; `--concept <name>` does not
  print it yet.
- `findMiscenteredConcepts(target, facts, config)` runs over the V8.0
  facts; `assessMiscentering(facts, config)` is the pure rule.

## Re-centering scenarios

`report.recenteringCandidates.scenarios` (V8.2) takes each V8.1 finding
one step further: which alternative responsibility arrangements does the
current architecture already support strongly enough to deserve
simulation? A scenario is architectural state, never an operation, a
delta, or a recommendation. Nothing is scored, ranked, or preferred;
consequences are a later version. Generation is compositional over the
V8.0/V8.1 facts: no scan, no history, no LLM.

- **Placement** (`ScenarioPlacement`) is a semantic center plus a
  responsibility → packages table over a fixed vocabulary:
  `semantic-contract`, `domain-behavior`, `implementation`,
  `persistence`, `representation`, `conversion`, `integration`,
  `consumption`. Current and proposed share the shape so they can be
  diffed without reading narrative. A responsibility without evidence is
  omitted, never guessed. The **current placement** is derived: the seed
  package holds the contract; packages with governing behavior (the V8.1
  rule) hold domain behavior; V7.3 implementation centers and `implements`
  adapters hold implementation; every package with a representation share
  or a converter-bearing V7.2 partner holds representation; converter
  packages hold conversion; a projection-shaped partner whose package owns
  all its converters holds persistence (structural, never a package
  name); packages that only construct the concept hold integration;
  packages with references hold consumption.
- **Candidate centers** come from evidence only: the declared home,
  governing-behavior share ≥ `scenarios.minObservedCenterShare`,
  representation share ≥ the same, implementation centers and adapters,
  the evolution center, converter packages, and packages where ≥
  `minSupportingFamilies` strongly related V7.2 families (converter,
  near-equivalent, or projection partners; never name-only) are declared
  or converted. Consumption is never a reason, so a package that only
  uses the concept is never a destination. A supporting-family cluster
  qualifies a package as a center and supports behavior rehomes,
  consolidation, and splits, but never argues for moving the semantic
  contract: related rows, stores, and mappers say where representations
  live, not where the concept belongs.
- **Kinds**, in the precedence used for dedup and truncation:
  `preserve-current` (the explicit baseline every finding carries),
  `rehome-semantic-center`, `rehome-behavior`, `consolidate-behavior`,
  `formalize-representation-boundary`, `split-responsibility`. Each moves
  one responsibility: a semantic rehome moves only the contract; a
  behavior rehome or consolidation moves only domain behavior; the
  boundary and split kinds reassign conversion, persistence, and
  implementation and reclassify foreign behavior that is entirely
  converters as conversion. Implementations never move.
- **Generation is signal-gated.** External: baseline, semantic center →
  strongest other center, behavior → home; both readings are emitted
  because the finding supports both. Drift: baseline, consolidate →
  home; a semantic rehome only under `allowWeakRehome`. Split: baseline
  plus consolidate → every center at ≥ `minObservedCenterShare`. Any
  signal: the boundary kind when a converter-bearing partner exists, the
  split kind when a foreign center holds implementation or conversion.
  Scenarios that reach the same canonical placement merge into one:
  the first kind in precedence is kept with its constraints and status,
  and the others add only rationale and cautions, since a constraint
  describes the kept move. An arrangement that already matches the code
  therefore folds into the baseline with its rationale. `maxScenariosPerFinding` truncates in
  precedence order.
- **Identity** is `finding::kind::canonical placement`; stable across
  runs and independent of evidence order.
- **Rationale** rows (`RecenteringScenarioEvidence`) name the evidence
  kind, package, and the direction it supports; counter-evidence stays
  visible as `counter-evidence` cautions. The baseline's rationale says
  why the current structure may be intentional: anchor, behavior kept
  home, representation center, converter boundary, parallel
  implementations, public contract, localized split.
- **Constraints and status.** `anchor` on the home blocks a semantic
  rehome (`blocked`, evidence retained); an anchor on a destination or a
  vacated package, a `public-contract` on the home (package-public and
  consumed outside), `structural-conformance-unknown` (the V8.1
  `unobserved-conformance` caution), and `representation-boundary` make a
  scenario `constrained`; otherwise `plausible`. Anchors constrain moving
  in as well as moving out.
- **Evidence confidence** is completeness, not correctness: `strong` at
  three or more distinct rationale kinds in the scenario's direction,
  `moderate` at two, `weak` below; any `structural-conformance-unknown`
  constraint caps at `weak`. Other cautions: `integration-center` (the
  destination constructs the concept at least as often as it governs it),
  `composition-root-unknown` (it constructs it at all; no composition-root
  detection exists to discount wiring), `unobserved-conformance`,
  `consumption-heavy`, `observed-center-anchored`.
- **Order** within a finding is kind precedence then destination name;
  never confidence.
- **Report.** `--concepts` ends with `RE-CENTERING SCENARIOS` (the top
  `scenarios.report.topFindings`, each with up to
  `topScenariosPerFinding` one-line scenarios); the concepts summary
  carries one `scenarios:` line; JSON carries placements, rationale,
  constraints, cautions, candidate centers, and per-finding generation
  diagnostics. `renderRecenteringScenarios` is the focused view, exported
  for callers; `--concept <name>` does not print it yet.
- `analyzeRecenteringScenarios(target, miscentered, facts, config)` runs
  over the V8.0 facts; `deriveScenarioFacts(finding, facts, config)` and
  `generateRecenteringScenarios(scenarioFacts, config)` are the pure
  halves.

## Scenario impact

`report.recenteringCandidates.impacts` (V8.3) simulates each V8.2
scenario against the current arrangement: what would certainly change,
what may change, what is preserved, and what stays unknowable. Every
analysis belongs to an existing scenario id and carries the same nine
dimensions, so a later version can compare vectors without reading
narrative. Nothing is scored, ranked, recommended, or costed; no file,
import, or manifest change is predicted; no scenario is regenerated. The
simulation is compositional over the V8.0 facts and V5 boundary
interactions: no scan, no graph recomputation, no history parse.

- **Baseline.** The comparison is always current placement → proposed
  placement; `preserve-current` yields zero placement delta with the full
  current snapshot (span, edges, boundaries, consumers, anchors), which is
  the baseline every other vector is read against.
- **Certainty** (`ImpactCertainty`): `certain` when the scenario's
  placement states it (a semantic center or behavior package set),
  `conditional` when it follows from module-level facts if the concept's
  modules move whole and an edge carries nothing else at symbol level,
  `unknown` when neither direction nor value is derivable. Metric deltas
  never fabricate a predicted number: source module counts, traversal
  distance, and shape are unknown whenever anything relocates, because
  V8.2 names packages, not target modules.
- **What moves.** A package leaving `domain-behavior` carries its return
  behavior; leaving `implementation` its adapters; leaving `conversion`
  its converters; the seed module follows the semantic contract. Weak
  behavior (parameter consumption, construction) and the reference halo
  never move, so a vacated package with consumers stays in the predicted
  span and keeps its edges; consumers are `unaffected` unless the contract
  they import moves, and then `unresolved`, never "all consumers change".
  A `composition-root-remains` uncertainty names packages that still
  construct the concept after their behavior leaves.
- **Boundaries and dependencies** are concept-scoped: the V7.4 behavior
  edges plus every package importing the seed module, measured with V5
  interaction data wherever the edge touches the target (foreign-to-
  foreign edges are unmeasured and `uncertain` when an endpoint changes).
  The concept's share of an edge is the import sites naming its modules.
  An edge is `preserved` when no concept module on it relocates,
  `reduced` when some do, and `eliminated` only when the concept's
  interaction ends **and** every import site on the edge names a concept
  module (`impact.boundary.requireExclusiveConceptContributionForElimination`;
  off, every importing module must be the concept's). A reduction whose
  concept interaction ends but whose edge other traffic keeps is marked
  `conceptInteractionEnds`. Elimination is at most `conditional`: module
  granularity cannot see other symbols a concept module exports. Under a
  semantic rehome, a plain consumer's edge into the old home is
  `uncertain` (an exposure strategy nobody chose decides it); only the new
  center itself certainly stops importing the contract. Edges are
  `added` where a package holding a non-consumption responsibility would
  need a contract now declared elsewhere, or a behavior destination needs
  the contract, without a current concept edge; under a rehome of
  `Session` the `@foundry/db → @foundry/studio` addition is the kind of
  consequence this surfaces. Fan-in and fan-out deltas count these
  concept-scoped edges at the home, never package gravity.
- **Locality** follows the predicted span: package count is `certain`,
  behavior edges are the current edges among remaining packages plus
  additions, disconnected pairs are the current pairs restricted to the
  remaining packages, and a shape is predicted only when the span
  collapses to one package that already holds at least
  `behavioralLocality.singlePackageDistributed.minModules` modules
  (`single-package-distributed`, `conditional`). `localityDecreases` in
  the summary is a span contraction, not a quality reading.
- **Surface.** A semantic rehome of a package-public seed is a
  `surface-relocation` with `reexportRequirement: unknown` and cautions
  saying the transition is unresolved; no re-export, facade, or consumer
  migration is chosen. Split scenarios note that new contract surfaces are
  unknown.
- **Representation and implementation.** Persistence-like partners and
  converters that stay put are `preserved`; a formalized boundary lists the
  partners it makes explicit and models no new type or module;
  `parallelImplementationPreserved` holds when two or more implementation
  centers stay where they are.
- **Evolution** is alignment with past co-change, not a forecast: strong
  source-source pairs whose modules the scenario would place together are
  `coLocated`, pairs split by a move `stillCrossBoundary`, pairs with an
  unplaced module `unknown`; `improves` means co-location with no new
  cross-boundary pair. Hotspot modules that relocate are counted; local
  complexity is never claimed to change. A `historical-future-assumption`
  uncertainty accompanies every co-location claim.
- **Intent.** Anchored packages that would gain or lose a responsibility
  make the scenario `constrained`; an anchored home losing its contract,
  or a V8.2 `blocked` scenario, is `incompatible`. Blocked scenarios keep
  their full vector as counterfactuals.
- **Changes, preservations, uncertainties, constraints.** `changes` use a
  fixed structural vocabulary (`semantic-center-change`,
  `behavior-consolidation`, `boundary-reduction`, `dependency-addition`,
  `surface-relocation`, `implementation-split-preserved`, …), each with a
  certainty and evidence rows naming their source; `preserved` says what
  the scenario deliberately leaves alone; `uncertainties` name the blind
  spots (`target-module-unknown`, `consumer-compatibility-unknown`,
  `structural-conformance-unobserved`, `composition-root-remains`,
  `shared-boundary-edge`, `surface-transition-unspecified`,
  `historical-future-assumption`); `constraints` restate each V8.2
  constraint as a consequence.
- **Status.** `simulated` when every dimension rests on measured facts or
  the placement; `partially-simulated` under unobserved structural
  conformance or an unmeasured edge whose endpoint changes (unresolved
  consumers and unknown target modules are expected answers, not gaps);
  `blocked` mirrors V8.2.
- **Report.** `--concepts` ends with `SCENARIO IMPACT` (the top
  `impact.report.topFindings`, one line per scenario: span delta, boundary
  outcomes, surface, intent, certainty counts); the concepts summary
  carries one `impacts:` line; JSON carries the full vectors.
  `renderScenarioImpacts(finding, scenarios?)` is the focused view,
  exported for callers; `--concept <name>` does not print it yet.
- `analyzeScenarioImpacts({ scenarios, miscentered, facts }, config)` runs
  over the V8.2 report and the V8.0 facts;
  `deriveScenarioImpactFacts(finding, facts, config)` and
  `simulateScenarioImpact(impactFacts, scenario, config)` are the pure
  halves. Runtime is reported in the summary (`runtimeMs`); the eight V8
  targets simulate in under 2 ms each.

## Architecture review

`report.recenteringCandidates.reviews` (V8.4) compares each finding's
V8.3 vectors against each other and against the baseline, and says which
scenarios are invalid, dominated, indistinguishable, or genuinely
tradeoff-bearing. It is composition over existing facts: no scan, no
simulation, no history parse, no score, no weight, no plan. Findings are
reviewed one at a time; nothing is aggregated into a repository pattern.

- **Comparison** (`ScenarioComparison`): every pair in a finding, one
  relation per V8.3 dimension (`left-better`, `right-better`,
  `equivalent`, `tradeoff`, `unknown`) with the weakest certainty the
  relation rests on. Locality reads predicted package span, behavior
  edges, and disconnected pairs; behavior reads packages holding governing
  behavior; boundary reads eliminations, concept import sites removed,
  and additions; dependency reads package edges removed and added;
  surface reads whether the package-public contract relocates; intent
  reads compatibility. Moving implementation responsibility is always a
  `tradeoff`, never a grade. A span difference made only of packages
  holding parameter consumption is not graded. The `uncertainty`
  dimension is descriptive and never grades.
- **Dominance.** Pareto only: every graded dimension no worse, at least
  one strictly better, no `unknown` relation, both scenarios fully
  simulated, and (`recentering.review.dominance.requireCertainEvidence`,
  default on) at least one strict advantage that is `certain`. A scenario
  whose only advantage is a conditional boundary reduction never
  dominates; a crossing advantage is a `tradeoff`.
- **Status** (`ReviewedScenario`): `baseline`; `invalid` when V8.3 intent
  is incompatible (anchor violation or a blocked scenario); `indistinguishable`
  when equivalent to an earlier scenario; `dominated`; `insufficient-evidence`
  when partially simulated or different from the baseline only through
  conditional or unknown consequences; otherwise `viable`. Invalid
  scenarios keep their structural comparison but never dominate anything.
- **Disposition** per finding: `credible-alternative` when a viable
  alternative dominates the baseline and no other dominator trades off
  against it; `multiple-tradeoffs` when viable alternatives remain that
  optimize different dimensions; `intent-blocked` when the only
  alternatives are invalid; `insufficient-evidence` when nothing differs
  from the baseline on certain, fully simulated evidence;
  `preserve-current` when every alternative is dominated or
  indistinguishable. The disposition is a review state, never an
  implementation recommendation.
- **Effects and character.** Each scenario lists descriptive effects
  (`center-alignment`, `locality-contraction`, `boundary-reduction`,
  `dependency-reduction`, `responsibility-clarification`,
  `surface-relocation`, `representation-preservation`, `intent-conflict`)
  and a `character`: `structural-reduction` only with a certain locality,
  behavior, or dependency advantage or an eliminated boundary;
  `relocation` when centers or surface move without one; `clarification`;
  `no-change`.
- **Evidence.** Every gain, cost, preservation, and uncertainty carries the
  dimension, the certainty, and the scenario it came from. History reads as
  alignment with observed co-change, never as a churn forecast, and is
  conditional, so it cannot carry dominance on its own.

Programmatic: `analyzeArchitecturalReviews({ scenarios, impacts }, config)`,
`reviewScenarioSet(impactFinding, scenarioFinding, config)`, and
`compareScenarioImpacts(left, right, config)` are pure over V8.2/V8.3
output. `renderArchitecturalReview(review, scenarioFinding)` renders one
finding's review.

## Workspace model

Every section above is one target's view. `WorkspaceReport` (V9.0) is the
canonical union of many package reports: no re-analysis, no Git, no
TypeScript, just ingestion of already-produced JSON.

```sh
bun run workspace -- <report-dir | manifest.json | report.json ...> [--json out.json] [--entity <id>]
```

Programmatic: `ingestWorkspaceReports(reports, { root? })` is pure over
parsed JSON values (bare `SurfaceReport` or the sweep's `{ seconds, report }`
envelope); `loadWorkspaceReports({ paths })` is the file wrapper;
`renderWorkspaceReport` and `renderWorkspaceEntity` print the summary and a
provenance view of one entity. The model has its own
`workspaceSchemaVersion` (3) and accepts package schemas 32 and 33.

- **Identity.** Every canonical fact reuses an id the package reports already
  carry: package name, root-relative module path, symbol id for concepts,
  `from→to` for dependency edges and boundaries, sorted ids for coupling
  and overlap pairs (directional fields are flipped to match), and the V8
  finding, scenario, and review ids. Nothing is keyed by display name.
- **Provenance, not duplication.** A fact observed by several reports is
  one entry with `provenance.observedBy`. Counts are never summed across
  observations; a second observation is cross-checked instead, and
  `verified` records agreement.
- **Authority.** The destination report leads a boundary's symbol facts (it
  measures its own declared surface; the source counts import
  declarations, a different population, kept as `perspectives.source`).
  Only `moduleEdges` is one shared fact. The seed package's report leads a
  concept's distribution, ownership, and locality; other reports contribute
  overlap-partner observations only. A file's own package leads its churn.
- **Conflicts.** Disagreements are recorded, never chosen silently:
  `target-scoped` for perspective and history-window differences,
  `preferred-authority` where a rule picked, `unresolved` otherwise.
- **Sources.** Identical duplicate reports collapse with a diagnostic; two
  differing reports for one target reject that target as ambiguous. Mixed
  or missing policy versions and partial coverage are diagnostics, not
  errors. Orphan scenarios, impacts, and reviews stay with
  `resolved: false`.
- **Determinism.** Every collection is sorted by id and the result is
  independent of input order; no timestamps enter the canonical indexes.

### Workspace graph

`analyzeWorkspaceGraph(workspace, config?)` (V9.1) reads only the canonical
graph and boundary indexes and analyzes the package and module graphs as one
system. Every metric is recomputed from canonical nodes and edges; the
per-package gravity each report derived from its own perspective is never
merged. The CLI attaches the result as `intelligence.graph`
(`workspaceSchemaVersion` 5 since V9.4) and prints a `WORKSPACE GRAPH` section;
`--package <id>` shows one package's place in it.

- **Two levels.** Package and module graphs are measured separately and
  never collapsed. Package edges are the canonical dependency edges with at
  least one import module edge; edges seen only through re-exported usage
  are listed as `usageOnlyEdges` and excluded, matching the population V5
  gravity measures. Package reports persist only boundary-crossing module
  edges, so the module level describes cross-package topology and says so
  with a caution.
- **Per node.** Fan-in/out, cycle-safe transitive dependents and
  dependencies, reach shares, condensation depth, weak component, SCC
  membership, and a sink-oriented layer: layer 0 depends on nothing in the
  workspace, layer n is one above the deepest layer it depends on, and a
  cycle is one layer unit. Packages also carry exact Brandes betweenness
  and whether they are a weak articulation point. Roles are `source`,
  `sink`, `isolated`, or `intermediate`; there is no hub or bridge role,
  betweenness is ranked instead.
- **Per edge.** Independent weights (module edges, import sites, distinct
  symbols, references), edge betweenness, `severedPairs` (reachable pairs
  beyond the edge's own endpoints that only this edge carries),
  `alternativeRoutes`, and weak-bridge status.
- **Seams** are edges with `severedPairs ≥ 1`, or weak bridges whose two
  sides each hold at least two packages; a pendant leaf is not a seam.
  Boundary volume is carried as context, never as the criterion.
- **Corridors** are path segments of at least two edges shared by the
  shortest routes of at least two distinct package pairs, not contained in
  a longer qualifying segment; enumeration is capped per pair and the cap
  is a caution.
- **Reachability** counts ordered pairs at both levels and lists the
  longest source-to-sink chains on the condensation, a cycle shown as
  `[a|b]`.
- **Coverage.** `certainty` follows V9.0 coverage; under partial coverage
  edges touching unanalyzed packages are known from one side only, so
  fan-in, fan-out, reach, seams, and corridors are lower bounds. Anchors are
  attached as context and change no metric. Concepts, history, and V8
  findings are not read.

### Workspace concepts

`analyzeWorkspaceConcepts(workspace, graph, config?)` (V9.2) places every
canonical concept onto the V9.1 package graph. `analyzeWorkspace(workspace)`
attaches both layers as `intelligence.graph` and `intelligence.concepts`
under one `policyVersion` (`WORKSPACE_INTELLIGENCE_POLICY_VERSION`, bumped
independently of the package policy). The CLI prints a `WORKSPACE CONCEPTS`
section; `--concept <id|name>` shows one concept and refuses an ambiguous
name; `--package` gains the package's concept roles, directions, and
boundaries. Since workspace schema 3, ingestion also preserves each
concept's per-package participation, per-package source behavior, and the
seed report's member couplings and hotspot modules, so nothing is
recomputed from package reports or sources.

- **Roles, not presence.** A package `declares`, `implements` (an
  `implements` representation), `represents`, `uses` (references),
  `behaves`, or `converts`. `behaves` means implementing or converting
  source behavior; behavior that only names the concept in a signature is
  listed as `contractBehaviorPackages` and never becomes a role, so
  parameter consumers do not read as behavioral flow. A package that holds
  the concept only through a re-export path has no role.
- **Two directions.** A concept direction runs from the declaring package to
  a role package (`semantic-to-implementation`, `-behavior`,
  `-representation`, `-usage`, `-conversion`) and carries the static
  dependency path separately: an implementation usually imports its
  contract, so the direction reads `core → store` while `dependencyPath`
  reads `reverse: 1`. Nothing collapses the two.
- **Paths and flow.** Every role package is measured against the declared
  package on the V9.1 package graph: `direct`, `indirect`,
  `reverse-directed`, `disconnected`, or `unmeasured`. Re-export-only
  (usage-only) edges are flow context, never a structural edge.
- **Spans and shapes.** Layer spans are kept per role; `responsibility`
  covers behavior and implementation only, because V7.0 representations
  include type users and track usage. Shapes are `local`,
  `downstream-implemented`, `upstream-consumed`, `cross-layer`
  (responsibility span ≥ `workspaceConcepts.shapes.crossLayer.minLayerSpan`),
  `parallel-implementation`, `representation-split`, and `multi-region`
  (complete coverage only). V7.3 centers are carried unchanged with their
  graph layer; a graph-central package is never promoted to a center.
- **Boundaries.** A concept edge is a package edge whose two endpoints both
  take part; its roles are what the importing side does. Boundary concept
  loads count distinct concepts and roles per edge beside V9.1 volume and
  raw severance; every seam is listed with its load, including zero.
- **Aggregations.** Package concept-role rows (declared, V7.3 centers,
  participating by role, raw asymmetry), directional pairs, boundary loads,
  contract families (package level: implementation names are not
  ingested), and overlap-pair topology (same package, layer, component,
  direct edge, path, converter packages, declaration-file coupling).
  Source-source member couplings are the architectural history; test and
  story pairs stay contextual. V8 reviews are an annotation on the concept
  and change nothing else.
- **Coverage.** `authoritative` concepts have a seed report with ownership
  and locality; `foreign-only` partners get presence only, no centers,
  shapes, or directions. Partial graph coverage is a caution on every
  affected concept and keeps `multi-region` off.

### Workspace patterns

`analyzeWorkspacePatterns(workspace, graph, concepts, config?)` (V9.3)
synthesizes V9.2 placements, V9.1 topology, V9.0 history, and V8 reviews
into repository-wide architectural patterns; `analyzeWorkspace` attaches
it as `intelligence.patterns`. Workspace schema is 4: ingestion also
preserves each review's unresolved uncertainty kinds and each impact's
V8.3 uncertainty kinds and unmeasured edges, so analyzer blind spots can be
clustered without rereading package reports. The CLI prints a
`WORKSPACE ARCHITECTURE` section (strong and moderate patterns only;
limited ones stay in the JSON) and `--package` gains the package's roles,
pair patterns, boundary patterns, and review context.

- **Recurrence, not renaming.** Every pattern needs support above the
  `workspacePatterns.support` minimums (distinct concepts, distinct
  declaring packages, reviewed concepts, couplings, or conversion pairs)
  and carries that support explicitly: concept ids, packages, boundaries,
  and the observations it rests on. A `thresholds` list reports candidate
  counts one step below, at, and above each minimum.
- **Package roles.** `semantic-center` (cross-package concepts flowing to
  several packages), `implementation-center`, `representation-center`
  (foreign concepts represented here with explicit converters),
  `conversion-center`, and `consumption-center`, each from concepts
  declared elsewhere across at least `minSourcePackages` packages. Roles
  are independent and several per package are normal; a package with none
  still reads through its raw counts. `integration-center` is never
  emitted: wiring behavior is not measured per concept, so consumption
  centers with an integration-like profile surface as a
  `composition-root-gap` instead.
- **Package pairs.** One record per semantic direction `from → to` with
  role concept lists, the static path kept apart, crossing couplings,
  conversion pairs, and a review overlay counting only reviews whose
  strongest competing center is `to`. Direction patterns:
  `implementation-channel`, `repeated-consumption`,
  `representation-projection` (needs distinct concepts on both sides),
  and, with enough reviewed concepts, `stable-responsibility-split`,
  `repeated-externalization` (baselines dominated by re-homing), or
  `mixed`.
- **Boundaries.** `high-volume-channel` and `high-concept-diversity` stay
  distinct; `implementation-channel`, `representation-channel`, and
  `consumption-channel` need a role share of the boundary's concept load;
  `structural-seam` reads raw severance; `historically-reinforced` counts
  distinct source-source couplings crossing the edge.
- **Concept, evolutionary, and review patterns.**
  `parallel-contract-implementations` groups families by external
  implementation package set; `cross-package-conversion-projection` needs
  several distinct concepts on each side (a fan from one concept is not a
  projection); `shared-semantic-primitive` and `cross-layer-contract` are
  per declaring package; `repeated-behavior-externalization` groups
  dominated baselines by the finding's strongest competing center.
  Evolutionary patterns count distinct couplings per package pair and
  read `static-temporal-alignment` or `-tension` against the graph. Review
  patterns aggregate dispositions, dominating scenario kinds, and
  unresolved causes by declaring package, gravity center, and direction;
  review-independent patterns are byte-identical with reviews removed.
- **Strength and coverage.** `strong`, `moderate`, `limited` describe
  evidence completeness (support multiple, independent sources, every
  supporting package analyzed), never probability. Under partial coverage
  every count is a lower bound and strength caps at `moderate`.
  `coveragePatterns` (partial package coverage, structural-conformance
  gaps, unmeasured edges, composition-root gap) are diagnostics kept apart
  from architecture. `statements` are factual sentences built from
  patterns with their pattern ids; there is no score and no recommendation.

### Workspace projections

`createWorkspaceProjectionContext(workspace)` (V9.4) takes a
`WorkspaceReport` with every V9 layer attached (`analyzeWorkspace`) and
builds one context: the four layers plus serializable id indexes
(patterns under one family-prefixed namespace, concepts by package,
patterns by package/concept/boundary, boundaries by package, the V8
gravity center per finding, and the entity index) and in-memory lookups.
Pure functions then project question-specific views from it. Nothing is
inferred here: every count is copied from V9.0–V9.3 under its canonical
id, the V9.3 gravity-center definition is imported rather than restated,
and the projection layer adds no threshold, so the workspace policy
version is unchanged. Projections carry
`WORKSPACE_PROJECTION_SCHEMA_VERSION` (1) on the overview and manifest.

- **Scopes and focused projections.** `projectWorkspaceOverview` (counts,
  topology, every package role / concept pattern / boundary pattern as a
  summary, statements, review totals, coverage, and the union of every
  layer's limitations), `projectWorkspacePackage` (graph facts, surface,
  roles with their concept ids, concept-role counts, incoming and outgoing
  semantic directions, boundaries, pattern ids, and review context as
  declaring package and as gravity center), `projectWorkspaceConcept` (the
  V7→V9 story: centers with layers, ownership, distribution shares with
  numerator and denominator, locality with the source/test/story behavior
  split, per-package participation vector, topology, span, flow,
  relationships with pair paths, history, re-centering finding →
  scenarios → impacts → review, pattern ids, cautions),
  `projectWorkspaceBoundary` (volume, symbol usage, structure, concept
  role counts, concepts per import site with both operands, boundary
  pattern, evolutionary pattern, cautions), `projectWorkspacePattern`
  (family, kinds, support, structure, review context, one
  headline/support/detail/evidence insight), and `projectWorkspaceReview`
  (the V8.4 disposition chain verbatim). `detail` is `standard` or
  `evidence` (adds `evidenceRefs`: source, kind, entity ids); `summary`
  views are field-picked from the standard object
  (`summarizeWorkspacePackage`, `summarizeWorkspaceConcept`), never
  recomputed.
- **Semantic ≠ static direction.** Every direction projection keeps
  `from`/`to` as the semantic direction (declaring package → role package)
  and `staticDependencyDirection` (`forward` / `reverse` / `usage-only` /
  `none`) as a separate field.
- **Graphs.** `projectWorkspaceGraph(context, preset, filter?)` returns
  package nodes (layer, graph role, architectural roles, fan-in/out,
  concept counts, cautions) and typed edges with no coordinates, styling,
  or combined weight. Presets are field selections over canonical edges,
  spelled out in `GRAPH_PRESETS`: `dependency-topology` (package
  dependency edges carrying import sites, module edges, references, the
  concept role load, severed pairs, seam flag, and boundary pattern
  kinds), `structural-seam` (the same edges restricted to V9.1 seams),
  `implementation-flow` / `behavior-flow` / `representation-flow` /
  `usage-flow` / `conversion-flow` (V9.2 semantic directions of one role,
  edge metric = concept count), `architecture-review` (declared package →
  gravity center review directions), and `architecture-overview` (all of
  the above together). Filters: `packages`, `minConcepts`,
  `connectedOnly`. Groups are layers and weak components from V9.1; no
  community detection. `projectConceptGraph(context, conceptId)` is the
  focused concept map: the concept, its packages, its overlap partners,
  role edges (`declared-in`, `implemented-in`, `behavior-in`,
  `represented-in`, `used-in`, `converted-in`), overlap edges, and the
  dependency edges among those packages only.
- **Matrices and ranked lists.** `projectWorkspaceMatrix` builds sparse
  matrices (a missing cell is zero; heatmap-ready as is):
  `package-concept-roles` (packages × declared / centers / participating
  roles), `package-direction` with one role metric (declaring package ×
  role package, cells carry concept ids), `boundary-concept-load` with one
  metric (`concepts`, `importSites`, `moduleEdges`, `severedPairs`, or a
  role count), and `review` with one metric (declaring package × gravity
  center). `rankWorkspace` ranks packages, boundaries, or concepts on one
  explicit metric, sorted value desc then id; the only ratio,
  `conceptsPerImportSite`, carries numerator and denominator.
  `listConceptDirections` and `listWorkspaceReviews` filter without
  ranking.
- **Queries and names.** `queryWorkspace(context, query)` dispatches a
  typed `WorkspaceQuery` (overview, package, concept, boundary, pattern,
  review, graph, concept-graph, matrix, rank, directions, reviews,
  search) to the functions above and returns a typed result, so a future
  MCP layer wraps it directly. Entity queries accept an id or a name;
  `resolveWorkspaceEntity` resolves exact id, then exact name or alias, and
  a name matching several entities returns them all (`ambiguous`), never
  the first. `searchWorkspace` is exact / prefix / contains over the
  entity index (packages, concepts, boundaries, patterns, reviews), no
  fuzzy matching. `workspaceProjectionManifest` lists scopes, presets,
  matrices, and query kinds.
- **CLI and renderers.** `bun run workspace <reports> --overview |
--package <id|name> | --concept <id|name> | --boundary <from→to> |
--pattern <id> | --review <concept> | --graph <preset> | --concept-graph
<concept> | --matrix <kind[:metric]> | --rank <kind>:<metric>[:limit] |
--directions [from=,to=,role=,min=] | --reviews [disposition=,
dominated=true] | --search <text> [--detail summary|standard|evidence]
[--json <out|->]`. Text output is rendered from the projection object
  only (`renderProjectionResult`); `--json` writes the projection JSON
  (`-` for stdout). The focused `--package` and `--concept` views are
  these projections; the whole-workspace summary and `--entity` still
  read the canonical report.

### Architectural operators

V11.0 represents a selected architectural change as an explicit,
immutable operator: what responsibility changes, what must stay, what must
hold first, and what must later be proven. Operators never say how source
files change; nothing here mutates, plans edits, or runs.
`OPERATOR_SCHEMA_VERSION` (1) is independent of the package and workspace
schemas.

- **Model.** `ArchitecturalOperator` = `kind`, `subject` (symbol, concept,
  package, boundary, or a concept's behavior in named packages), `intent`
  (reason plus source: manual, architectural-review, existing-plan, with
  scenario / review / plan ids), `placement` (current and target package;
  module refinement is later planning), `preconditions` (facts read when
  the operator was built), `preservations` (what must not change),
  `expectedEffects` (architecture-level before → after per dimension, with
  certainty), `verification` (what execution must prove), `constraints`
  (anchor, public contract, representation boundary, structural conformance
  unknown, incomplete coverage; each informational, constraining, or
  blocking), evidence refs (pointers into canonical analysis, never copies),
  a fingerprint over the precondition facts, and a status. Every array is
  canonically sorted, so input order never changes the operator; it
  round-trips through JSON.
- **Catalog.** `listOperatorDefinitions()` describes six kinds as data:
  `internalize` (a package-public symbol leaves the surface; executable
  through the legacy `internalize-export` operator), `move` (generic
  placement change), `rehome-concept` (the semantic center moves),
  `rehome-behavior` (the semantic center stays; behavior elsewhere
  consolidates toward one package), `redirect-dependency` (a consumer's
  dependency targets another package), and `preserve-boundary` (explicit
  intent that a boundary survives). Definitions carry no `apply` or
  `verify`.
- **Sources.** Operators come from an explicit manual request
  (`createRehomeConceptOperator`, `createRehomeBehaviorOperator`,
  `createRedirectDependencyOperator`, `createPreserveBoundaryOperator`,
  `createMoveOperator`, all taking canonical ids and throwing on unknown
  ones), from one explicitly selected V8.2 scenario
  (`createOperatorFromScenario(context, scenarioId)`), or from an existing
  V3 internalize plan (`createInternalizeOperator(context, planId)`).
  Workspace patterns and reviews never create operators on their own: a
  `credible-alternative` review or a dominated baseline is evidence, not a
  selection. Scenario kinds map `rehome-semantic-center → rehome-concept`
  and `rehome-behavior` / `consolidate-behavior → rehome-behavior`;
  `preserve-current` (no change), `formalize-representation-boundary`, and
  `split-responsibility` return `unsupported` with the exact gap, and
  `operatorCatalogGaps` counts them per workspace.
- **Context.** `createOperatorContext(projectionContext, reports?)` pairs
  the V9.4 projection context with the package reports, because the
  workspace only digests V8 scenarios: placements, impact vectors, and
  reviews live in each package's `recenteringCandidates`. Scenario-derived
  operators copy the V8.3 impact's `changes` and `preserved` verbatim into
  expected effects and preservations and keep the scenario, impact, and
  review ids; nothing is re-simulated.
- **Validation.** `validateArchitecturalOperator(operator, context)`
  re-reads every precondition against the current facts and returns
  `valid`, `blocked` (a blocking constraint: the semantic center would leave
  an anchored package, mirroring V8's intent rule; an unobserved-conformance
  concept under `rehome-concept` or `move`; an unanalyzed package under
  those two kinds), `stale` (a fact moved since the fingerprint, such as
  behavior no longer in the `from` package, or the scenario record is gone),
  or `unsupported` (identical current and target placement, or a subject
  the kind does not accept). Anchored destinations and behavior leaving an
  anchored package are constraining cautions, never blocks. Internalize
  operators delegate to the legacy `validateReductionPlan`.
- **CLI.** `bun run workspace <reports> --operator-from-scenario
<scenario-id> [--json <out|->]` renders the operator with its validation;
  `--operator-definitions` lists the catalog. No execution flag exists.

### Operator decomposition

V11.1 expands one operator into a dependency graph of structural actions:
what must change or stay at the responsibility, exposure, dependency, and
boundary level, one layer above source edits. `decomposeArchitecturalOperator`
reads the operator and the workspace facts it was built from; it predicts
nothing new. Records are plain JSON under `DECOMPOSITION_SCHEMA_VERSION`.

- **Actions.** Ten kinds: `relocate-semantic-declaration`,
  `relocate-behavior-responsibility`, `redirect-concept-dependency`,
  `establish-target-exposure`, `preserve-public-exposure`,
  `internalize-old-exposure`, `preserve-representation-boundary`,
  `preserve-implementation-split`, `remove-boundary-participation`,
  `preserve-anchor-boundary`. Subjects are concept, symbol, behavior (with a
  role), boundary, exposure, dependency, or package, always by canonical id.
  Locations are package-level; a module is never invented. Ids derive from
  the operator id, kind, subject, and placement.
- **Rules per kind.** `internalize` → one `internalize-old-exposure` action
  (complete). `preserve-boundary` → one `preserve-anchor-boundary` action
  (complete). `rehome-behavior` → per source package, relocate governing
  behavior and redirect its concept dependency (internal when the target is
  the semantic center, carried otherwise); generic consumers are never
  targeted. `rehome-concept` → relocate the declaration, establish target
  exposure, redirect each consumer, and redirect what stays behind; the old
  exposure is preserved only when the operator carries a
  `consumer-import-path` preservation, otherwise the surface transition is
  a gap. `redirect-dependency` → establish target exposure and redirect the
  whole boundary; no removal of the old edge. `move` is unsupported.
- **Effects and preservations.** Each action carries the subset of the
  operator's own expected effects it accounts for (V8.3 edge labels are
  matched to redirect actions; a certain `boundary-elimination` becomes an
  explicit `remove-boundary-participation`). Every operator preservation is
  `covered` by an action, `implicit` (no action conflicts with it), or
  `uncovered` (a defect). Every verification requirement maps to related
  actions.
- **Dependencies and order.** Edges are `requires` or
  `preserve-before-remove`; the graph must be acyclic. Actions are sorted by
  dependency layer, then group (preservation, placement, surface,
  dependency), kind, id. Order carries no execution meaning beyond the edges.
- **Gaps and status.** `target-module-unresolved` (every rehome; not
  blocking), `surface-transition-unspecified`, `dependency-target-unresolved`,
  `structural-conformance-unknown` with a blocking
  `behavior-members-unresolved`, `behavior-members-unresolved` under partial
  coverage (blocking when an involved package is unanalyzed),
  `representation-strategy-unspecified`, `unsupported-action-kind`. A
  blocking gap means the action set may be incomplete; it does not change
  the status. Status is `blocked` when the operator validates blocked
  (change actions marked blocked, anchors preserved explicitly), `stale`
  when the operator no longer matches the facts (no actions; refresh the
  operator), `unsupported` for `move`, `partial` with any gap, else
  `complete`.
- **Validation.** `validateOperatorDecomposition` recomputes coverage from
  the actions, checks kinds, subjects, targets, required actions, and
  cycles, and is `stale` when the operator fingerprint or the
  decomposition's own fact fingerprint (coverage, analyzed flags, consumers)
  moved.
- **CLI.** `--operator-from-scenario <id> --decompose` renders the
  decomposition with its validation; `--json` emits operator, validation,
  decomposition, and decomposition validation together.

### Operator composition

V11.2 combines several operators and their decompositions into one
structural action graph. `composeArchitecturalOperators(operators,
decompositions, context)` takes exactly the operators the caller supplies
(nothing is selected from the workspace), merges actions that name the same
work, merges and infers dependencies, and reconciles preservations, effects,
verification, and gaps across operators. It never picks between
contradictory intents and never adds an action no decomposition asked for.
Records are plain JSON under `COMPOSITION_SCHEMA_VERSION`.

- **Inputs.** A stale operator is reported and contributes no actions. A
  decomposition that is missing, behind its operator's fingerprint, or
  behind the facts while the operator still validates is rebuilt and listed
  in `diagnostics.redecomposed`. Two operators with one id must be
  identical; extra decompositions are ignored.
- **Shared actions.** The canonical key is kind, subject key, current
  package, and target package (`canonicalActionKey`). Actions with one key
  become one `composed/<key>` action carrying `sourceOperators` and
  `sourceActions`; preconditions, preserved invariants, effects, and evidence
  are unions, the status is the strongest (`blocked` > `required` >
  `conditional` > `unsupported`), and the wording comes from the first
  source by id. `sharedActions` lists every merge with more than one source.
- **Dependencies.** Explicit edges are remapped and deduped by endpoints
  (`preserve-before-remove` wins over `requires`). Six fixed rules infer
  cross-operator edges with provenance and a rule id: target exposure
  before a redirect to that package, redirect before the old exposure closes,
  relocation before the target exposure, behavior relocation before boundary
  removal, target exposure before a forwarding old exposure, and an
  anchor before any placement touching its package. Concept scopes agree
  when equal or when either side is the whole boundary.
- **Conflicts.** Nine kinds, all listed, none decided: `target-conflict`
  (one concept relocated to two packages by the same operator family),
  `placement-conflict` and `dependency-conflict` (one placement or one
  concept-scoped dependency subject with two targets), `exposure-conflict`
  (an old exposure both kept and closed, or a preserved import path whose
  home stops exposing the concept with no forwarding action),
  `preservation-conflict` (a `semantic-center` or `public-contract`
  preservation contradicted by another operator's action, concept-scoped
  where the preservation is), `anchor-conflict` (responsibility leaves an
  anchored package another operator preserves), `action-effect-conflict`
  (two operators describe the same step with different other ends),
  `action-order-conflict` (the merged graph loops; the loop members are
  listed), `operator-intent-conflict` (a semantic center moves into a
  package whose governing behavior another operator moves out).
- **Preservations, effects, verification.** Preservations group by id with
  `requiredByOperators` and are `covered`, `implicit`, `conflicted`, or
  `uncovered`. Effects group by dimension, change, and operator subject and
  are `duplicate`, `compatible`, or `conflicting`; nothing is summed.
  Verification requirements group by kind and expected value; two
  concept-center, behavior-location, or public-surface expectations for one
  subject are `conflicting`.
- **Gaps.** Every decomposition gap is carried with its source operator and
  a resolution entry. Only `surface-transition-unspecified` can be resolved,
  by another operator's `preserve-public-exposure` or
  `internalize-old-exposure` of the same concept at the old home (both at
  once is `conflicted`). Module choice, boundary scope, conformance,
  coverage, representation, and unsupported gaps stay.
- **Status.** `stale` > `unsupported` > `conflicted` > `blocked` >
  `partial` > `complete`. Conflicted precedes blocked because a
  contradiction means there is no combined intent to be blocked. Any
  conflict, conflicting verification, or conflicted gap resolution makes
  the composition conflicted.
- **Identity.** The id hashes the sorted operator ids and fingerprints with
  the schema version; the fingerprint also covers decomposition fingerprints
  and `COMPOSITION_RULES_VERSION`. Output is byte-equal whatever the input
  order. `validateOperatorComposition` rebuilds the composition from the
  same inputs and compares it part by part: `stale` when an input moved,
  `invalid` when the record no longer matches what its inputs compose to.
- **CLI.** `--compose-operators <a.json> <b.json ...>` reads files written
  by `--decompose --json` (or bare operators), composes them against the
  workspace given by the paths, and renders the graph with its validation;
  `--json` emits composition and validation together.

### Operator planning

V11.3 resolves a composition against the actual sources into an
`OperatorExecutionPlan`: exact, dependency-ordered transformations naming
files, symbols, imports, exports, and manifests. This is the first V11 step
that reads TypeScript; it still writes nothing. `planOperatorComposition(
composition, operators, planningContext, operatorContext)` is the primary
path; `planArchitecturalOperator` composes one operator first. Records are
plain JSON under `OPERATOR_PLAN_SCHEMA_VERSION`; resolution rules carry
`OPERATOR_PLANNING_POLICY_VERSION`, part of the plan id.

- **Planning context.** `createOperatorPlanningContext` takes a root, an
  optional tsconfig, and optional package ids; it builds one ts-morph
  project over the workspace (the same `createProject` the analyzer uses),
  reads each package manifest for its
  declared dependencies and entrypoints, and indexes parsed files by owning
  package. Symbols resolve from `<file>#<Name>` to their single top-level
  declaration; two declarations of one name with different kinds are
  `ambiguous-symbol`.
- **Transformations.** `move-symbol`, `move-module`, `create-module`,
  `add-export`, `remove-export`, `rewrite-import`, `rewrite-reexport`,
  `update-package-dependency`, `preserve-compatibility-export`,
  `delete-empty-module`, `update-test-import`, and `verify-only`. Each names
  its file, subject, and a before/after source state; its id hashes those
  and nothing else, so two actions asking for one edit share one
  transformation (`actions` lists both). `update-package-export` is in the
  vocabulary but never emitted: no rule chooses a new subpath entry.
- **Relocation.** Members of a `relocate-semantic-declaration` are the
  concept symbol; members of `relocate-behavior-responsibility` are read
  from the sources of the source package: classes that `implements` the
  concept and functions whose return type names it. Parameter-only
  consumers stay. Method movement between classes is never planned.
- **Movement closure.** Identifiers inside the moved declarations resolve to
  their declarations: module-local siblings move along
  (`requiredInternalSymbols`) unless remaining code needs them too
  (`closure-incomplete`, no duplication); everything else is classified as
  `import-from-source-package`, `import-from-target-package`,
  `import-from-third-package`, or `external`, with `typeOnly` when every
  reference sits in a type position or the declaration is a type. A source-
  package need that no entrypoint of the source exposes is a blocker, not a
  new export.
- **Target module.** One ordered rule list, no name similarity: the
  concept's own declaring module when it sits in the target; the target
  module holding the most V7 representations of the concept (a tie is
  unresolved); the single non-entrypoint target module importing the concept
  today; else a new module mirroring the source module's path under the
  target's source directory, only when that path is free. Granularity is
  `module` when every declaration of the source file moves and the target is
  new, `new-module` when the target is new but the file keeps other
  declarations, `symbol` otherwise, `unresolved` when nothing resolves. A
  target module already declaring a moved name is `target-module-collision`;
  nothing is renamed. Modules that run code on load are not split.
- **Imports.** Every import or re-export site binding a moved symbol is
  found through the project; sites in the target package become relative
  (or local) imports, sites in the source package import the target's root
  entrypoint, consumer sites belong to the composition's redirect actions,
  test files get `update-test-import`. Namespace and default imports have no
  exact rewrite and are `unsupported-import-form`. Package-internal imports
  through the package's own entrypoint are redirected to the module before
  an internalized exposure closes; a symbol declared in the entrypoint
  itself and imported that way cannot be internalized.
- **Surface.** Exposure is added at the target's root entrypoint as a named
  or type re-export (or nothing when a star export already covers the
  module); code never lands in a barrel. A `preserve-public-exposure` action
  becomes `preserve-compatibility-export` at the old route (or in the old
  module behind a star). Strategy per relocation is derived, never chosen:
  `compatibility-reexport`, `target-public-old-internal` (an internalize
  action closes the old path), `direct-relocation` (no outside importer, or
  every one is redirected; the old route is dropped), else `unresolved` with
  a gap. `breaking-relocation` is never the default. Internalizing a
  star-exported or otherwise unmodelled route is `unsupported-export-form`.
- **Manifests.** Every new package edge (moved code's needs, redirected
  imports, compatibility forwards) becomes `update-package-dependency` when
  the manifest lacks it; a removal is planned only when every import site
  carrying an edge is rewritten away, and then as `conditional`. A runtime
  need landing on a type-only edge is recorded as a
  `runtime-dependency-escalation` delta. Cycles through added edges over the
  remaining import graph are `dependency-cycle-risk`.
- **Graph.** Transformation edges come from fixed pairs (a declaration lands
  before imports follow it, consumers are redirected before the old
  exposure goes, a manifest declares a package before imports reach it) and
  from the composition's action order, where a transformation shared by
  actions at different depths sits at the deepest; cleanup steps carry no
  order forward. Cycles block. Every composition action gets a realization
  (`realized`, `partial`, `blocked`); every preservation is `transformed`,
  `proven` by a verification step, or `unproven`; operator effects map onto
  the transformations realizing their actions, never recomputed.
- **Verification.** Source-aware steps (`verify-symbol-location`,
  `verify-public-surface`, `verify-imports`, `verify-dependency`,
  `verify-anchor`) precede `typecheck`, `tests`, `analyze-package`, and
  `analyze-workspace` over the affected packages; nothing runs.
- **Identity and staleness.** The fingerprint hashes only the files the
  plan names, the manifests and entrypoints it read, and the composition's
  facts; an unrelated file may change freely. The plan id hashes the
  composition id and fingerprint, the transformation ids, the file hashes,
  and both versions, so input order does not matter.
  `validateOperatorExecutionPlan` is `stale` when a fingerprinted file's
  bytes moved, `invalid` when a fresh plan disagrees with the record.
- **Status.** `stale` (a source fact contradicts the operator) >
  `unsupported` (a required transformation has no exact form) > `blocked`
  (conflict, cycle, collision, constraint) > `partial` (an action or gap is
  unrealized) > `ready`. Ready means planning is complete, not that writing
  is safe; that proof is V11.4.
- **CLI.** `--compose-operators` with `--plan --source <repo root>` (and an
  optional `--tsconfig <file>`) plans the composition against the sources
  under `--source` and renders composition and plan; `--json` emits
  composition, its validation, the plan, and the plan validation together.

### Operator readiness

`assessOperatorPlanReadiness` is the last read-only gate before a mutator
touches the repository. It takes the V11.3 plan as it is, judges it against
the repository as it is now, and answers with one `MutationAuthorization`:
`authorized`, `not-authorized`, `stale`, `blocked`, or `unsupported`. It never
repairs the plan, never chooses a transformation, never writes, and never
authorizes a subset: seven supported transformations and two unsupported ones
are one unauthorized plan. `authorizeMutationPlan` wraps it and, only on
`authorized`, returns the V12 handoff record of ids and fingerprints.

- **Source state.** Every fingerprinted file is re-hashed and every file the
  plan creates must still be absent. A changed or missing planned file is
  `stale` and short-circuits everything that reads sources; an unrelated
  file may change freely. Git working-tree state is context: a planned file
  with uncommitted changes whose bytes still match the plan is a caution,
  never a gate, because staleness already covers the decisive case.
- **Completeness.** Every required composition action has a realized
  transformation; every composition verification requirement has a plan
  step; no planning gap is open. A transformation the plan marks
  `conditional` (relocation actions inherit that from V11.1) is settled now:
  `required` when fresh planning against the unchanged sources still yields
  it, `unresolved` otherwise, and nothing conditional reaches V12.
- **Consistency.** The transformation graph is re-checked for unknown ids
  and cycles; destinations, import rewrites, exposure changes, and manifest
  edits are checked for contradictions against each other and against the
  current sources (a move target that already declares the name, a manifest
  that already declares the dependency); and the plan must re-plan to the
  same record.
- **Constraints.** Twelve checks, each `pass`, `fail`, or `not-applicable`:
  anchor, representation boundary, and implementation split (no
  transformation moves what a preservation keeps); public surface (an
  exposure may leave only by operator intent or with a compatibility export
  at the old route); consumer compatibility; type or value import kind and
  runtime escalations an operator effect predicts; manifest declarations for
  every rewritten import and no removal while imports remain; package cycles
  through added edges; module cycles a relocation would close; load-time
  side effects in a moved-from module; analysis coverage by operator kind
  (`internalize` needs its subject package, relocations need source, target,
  and consumers); and structural conformance, which blocks relocations and
  only cautions internalize.
- **Realizability.** A `MutationCapabilityRegistry` says which transformation
  kinds and syntax forms a mutator executes atomically and reversibly. The
  default mirrors the legacy internalize path (export narrowing, re-export and
  named or type import rewrites, compatibility exports) and nothing more;
  a kind or form outside it is `unsupported`, and widening the registry is a
  V12 decision taken after the mutator exists. Every closure must be complete.
- **Verification.** Plan steps resolve into structured commands (the test
  script of the package that declares one) or analyzer queries; a step that
  cannot run here is `not-authorized`. Baseline checks run before
  authorization, only for a plan that is otherwise clean: typecheck through
  the package's own script when it declares one (project diagnostics, which
  inherit the planning project's compiler options, are the fallback), tests
  through the resolved command, both with `CI=1`. A pre-existing failure is
  tolerated only through an explicit `VerificationBaselineAllowance` naming
  the exact failure identities; any failure beyond the allowance blocks.
  Expected architectural effects become assertions naming the query V12
  runs afterwards.
- **Rollback.** Every file the plan edits, creates, or deletes gets a
  byte-snapshot contract: restore edited bytes, delete a created file that
  was proven absent, recreate a deleted file from its hash. A file that
  cannot be read, or a transformation the registry calls irreversible, is
  `rollback-incomplete`.
- **Authorization and identity.** Precedence is `stale` > `unsupported` >
  `blocked` (a positive contradiction) > `not-authorized` (something
  required is missing) > `authorized`. Risks are descriptive kinds with
  evidence, never a score. The authorization fingerprint hashes the plan,
  the current source bytes, the capability registry, the resolved
  verification with its baseline results, and the rollback contract; V12
  must revalidate it before its first write, and the record carries that
  contract in words. Wall-clock timings sit outside every fingerprint.
- **CLI.** `--readiness` after `--plan` renders and emits the readiness with
  the plan; `--allowances <file>` supplies a JSON array of allowances. There
  is no `--apply`.

## Semantics dataset

`bun run semantics` (V12.0, from the monorepo root) turns the workspace into
one static, self-describing dataset under `.foundry/semantics/`;
`bun run semantics serve` serves `.foundry/` over localhost so plain HTML
and JavaScript can fetch it. Nothing new is analyzed here: the command
orchestrates the canonical package analyzer, V9 ingestion and
intelligence, and the V9.4 projections, then writes what they return.

```sh
bun run semantics                      # generate .foundry/semantics/
bun run semantics -- --concurrency 4   # more worker processes (default 2)
bun run semantics -- --json            # generation result as JSON
bun run semantics serve                # http://127.0.0.1:4173 → .foundry/
bun run semantics serve -- --port 5000 --host 127.0.0.1
bun run semantics -- --serve           # generate, then serve
```

- **Discovery.** Each configured root (`apps`, `packages`, `plugins`,
  `tooling` by default) is read one level deep; a directory is a unit when
  its `package.json` names it and it holds TypeScript sources. Generated
  directories (`node_modules`, `dist`, `.foundry`, …) are skipped as
  `generated output`, manifest-less directories as `no package manifest`,
  source-less packages as `analysis unsupported`, configured exclusions as
  `excluded`; every skip is recorded in the manifest. Configuration lives
  under `semantics` in an optional root `foundry.config.json`
  (`roots`, `exclude`, `output`); no file is needed for the defaults.
- **Generation.** Six phases, each timed into the manifest: discover,
  analyze, ingest, intelligence, project, write. Package analysis runs in
  `bun` worker processes (`src/semantics-worker.ts`, one per unit, bounded
  by `--concurrency`) that call `analyzeSurface` under one shared clock, so
  every report carries the same history window. A failed unit is recorded
  as `status: "failed"` with its error and the run continues (`--fail-fast`
  stops instead); the workspace is then built from the reports that
  succeeded and the manifest says `coverage: "partial"`. Output is written
  to `.foundry/semantics.tmp-<pid>` and renamed into place only when
  complete, so a failing run leaves the previous dataset untouched and a
  vanished package leaves no stale record.
- **Layout.** `manifest.json` is the entry point: schema and policy
  versions, counts, one record per unit (status, report, projection,
  module shard), every skip, and the generation metadata. Every reference
  is dataset-relative; a scoped name such as `@foundry/db` becomes the
  file stem `@foundry__db`, reversibly (npm names never contain `__`).
  `workspace.json` is the canonical V9 workspace with graph,
  concept, and pattern intelligence attached; `packages/<id>.json` is the
  full package report and `packages/<id>.projection.json` the V9.4 package
  projection; `projections/` holds the overview, dependency graph,
  implementation and behavior flows, package-role and boundary-load
  matrices, direction list, pattern index, and projection manifest;
  `concepts/index.json` lists every concept with its declaring package,
  presence, and centers; `modules/index.json` lists every module with its
  shard, and `modules/<package>.json` holds the per-module records of one
  package (id, role, file kind, V9.0 gravity, V9.1 graph facts, concept
  roles by file, cross-package module edges, churn, hotspot, couplings,
  cautions). The file kind (`source`, `test`, `story`, `config`, `other`)
  is classified once by path in `file-kind.ts`, attached to every module
  node of the package report, and carried through the workspace node and
  the module index entry, so a client can split source from tests before
  any shard loads.
  Concept roles per module come from the package reports' concept
  families, behavior maps, and conversions.
  `modules/edges/<package>.json` (dataset schema 3) holds every directed
  module edge whose source the package owns: intra-package edges copied
  from that package report's `dependencyGravity.internalEdges` (schema 35,
  the same cruise that always produced the cross-boundary edges, now kept
  instead of dropped) and cross-package edges from the merged workspace
  graph, each with `scope` and the cruise's `typeOnly` flag; the module
  index lists the shards with per-scope counts. Direction is import
  direction only. `history/couplings.json` copies every workspace co-change
  pair with its raw values (shared commits, per-side commits and
  conditionals, jaccard, last co-change); no combined strength is written.
- **Serve.** `createSemanticsServer({ root, app, host, port })` is a
  `node:http` static file server: GET and HEAD only,
  `Cache-Control: no-cache`, MIME by extension, `index.html` for `/`, 404
  for anything else (no SPA fallback), and paths resolved and
  realpath-checked against the root so nothing outside `.foundry/` is
  reachable. `app` overlays a second directory on every path outside
  `/semantics/` (the CLI defaults it to `examples/explorer`, `--no-app`
  turns it off) so a committed client can sit beside the gitignored
  dataset. It never analyzes, watches, or regenerates: rerun
  `bun run semantics` to refresh the dataset.
- **Client.** A page needs only the manifest:

  ```js
  const base = "/semantics/";
  const manifest = await fetch(`${base}manifest.json`).then((r) => r.json());
  const json = (file) => fetch(base + file).then((r) => r.json());
  const overview = await json(manifest.files.projections.overview);
  const modules = await json(manifest.files.moduleIndex);
  const shard = await json(modules.shards[0].file);
  ```

- **Programmatic.** `generateSemantics(options)` takes `root` plus optional
  `config`, `now`, `concurrency`, `failFast`, `analyze`, and `onProgress`,
  and returns the generation result
  (counts, phase timings, file count and bytes, largest files, errors);
  `discoverSemanticsUnits`, `loadSemanticsConfig`, `encodePackageFile` /
  `decodePackageFile`, and `resolveServedFile` are exported for tests and
  future clients.

## Semantics history dataset

`bun run semantics history` (V12.3, from the monorepo root) reconstructs a
sequence of real historical semantic checkpoints from Git and writes them as
a second static dataset under `.foundry/semantics-history/`, a sibling of
`.foundry/semantics/` with its own schema and lifecycle (the current-state
dataset is wiped and rewritten by `bun run semantics`; keeping history
beside it rather than inside it means one command never destroys the
other). Nothing new is analyzed in a new way: each checkpoint runs the
**current** analyzer over historical source, so the twin gains a memory
without trusting whatever analyzer shipped at that commit.

```sh
bun run semantics history                       # .foundry/semantics-history/
bun run semantics history -- --range 1y         # window back from HEAD (default 1y)
bun run semantics history -- --checkpoints 12   # newest N kept (default 12)
bun run semantics history -- --strategy monthly # monthly | evenly-spaced | every-n-commits
bun run semantics history -- --every 100        # spacing for every-n-commits
bun run semantics history -- --concurrency 4    # package workers per checkpoint
bun run semantics history -- --json             # generation result as JSON
```

- **Configuration.** `semantics.history` in `foundry.config.json`
  (`range`, `checkpoints`, `strategy`, `every`) sets the defaults; flags
  override. `range` is `<n>y`, `<n>m`, `<n>d`, or `all`, relative to the
  HEAD commit's own time (not wall-clock).
- **Timeline.** First-parent history only
  (`git log --first-parent --diff-merges=first-parent`), so a merge is one
  point on the mainline, never its branch's internal commits. Two passes:
  `--numstat` for parents, timestamps, and rename pairs; `--name-status`
  for per-commit module additions and deletions. Module paths are `.ts`
  / `.tsx`, never `.d.ts`. No author field is read or stored.
- **Checkpoint selection.** `monthly` keeps the last commit of each UTC
  month; `evenly-spaced` spreads N across the range including both ends;
  `every-n-commits` walks back from HEAD. HEAD is always included; the
  newest `checkpoints` are kept.
- **Historical source isolation.** Each checkpoint is analyzed in a
  detached temporary worktree (`git worktree add --detach` under the OS
  temp dir), discovered and analyzed with the current analyzer at the
  `temporal` profile, then removed (`git worktree remove --force` +
  `git worktree prune`). No `bun install` is run, so historical
  dependency trees are never materialized; the working tree, index,
  branch, and `HEAD` are never touched (a test asserts the tree hash,
  index, branch, status, and worktree list are byte-identical afterward).
  A checkpoint fails only when units exist but every one throws; a
  zero-unit tree is a valid empty checkpoint.
- **Temporal analysis profile.** `analyzeSurface({ profile: "temporal" })`
  runs every semantic, behavioral, and representation stage but reports
  external symbol usage as unmeasured and Git history as
  `not-collected` — the per-commit churn a single checkpoint cannot see is
  exactly what the timeline supplies instead. It is meaningfully faster
  than the full profile (usage analysis is the removed cost).
- **Identity.** Lineage is replayed oldest→newest from Git rename
  evidence only: a rename or cross-package move carries identity, a
  delete-plus-add does not, a deleted-then-recreated path is one identity.
  No probabilistic matching. A lineage id is its newest path; concept ids
  are re-keyed to their declaring module's lineage so a concept keeps its
  identity across a rename.
- **Snapshots and deltas.** Each checkpoint is one compact snapshot
  (modules, dependencies as index pairs, concepts with all placements,
  packages, boundaries, coverage); deltas between consecutive successful
  checkpoints are **derived** from the snapshots (packages, modules
  added/removed/renamed/moved/role-changed, dependencies, concept span
  and centers, boundaries) — the snapshots are authoritative, deltas are a
  convenience.
- **Cache and atomicity.** Each checkpoint is cached by SHA plus a
  fingerprint of the analysis policy (`.foundry/cache/semantics-history/`);
  an unchanged policy reuses every checkpoint (0 re-analyzed), a policy
  change (e.g. a new `exclude`) invalidates them. The dataset is written
  to a temp dir and swapped into place only when generation succeeds, so a
  failed run leaves the previous dataset byte-identical.
- **Layout.** `manifest.json` (its own `schemaVersion`) points at
  `timeline.json`, `entities.json` (module lineages and package
  lifetimes), `snapshots/<sha>.json`, and `deltas/<from>__<to>.json`, with
  per-checkpoint status, timings, and byte counts. Every path is
  dataset-relative; no absolute or temp path is ever written.
- **Serve.** `bun run semantics serve` already serves the whole of
  `.foundry/`, so `/semantics-history/*` is reachable with no change; the
  server never analyzes, watches, or touches Git.

## Incremental materialization

`bun run semantics -- --incremental` (V12.5) rebuilds the current dataset
by reusing every package report whose inputs are unchanged, recomputing
workspace intelligence from the reused and fresh reports, and carrying
byte-identical artifacts into the new tree instead of rewriting them. The
invariant it is built around: **an incremental build of repository state X
is canonically equivalent to a clean full build of X.** Speed is secondary
to that; nothing is skipped on a guess.

```sh
bun run semantics                           # full build (default); also fills the cache
bun run semantics -- --incremental          # reuse cached package reports
bun run semantics -- --incremental --explain   # why each package was reused or rebuilt
bun run semantics -- --incremental --dry-run   # the plan only: no analysis, no output
bun run semantics -- --full                 # explicit authoritative rebuild
rm -rf .foundry/cache/semantics             # discard the cache; the next build recovers
```

- **What a package report depends on.** The V12.5 audit found that the
  package analyzer is not package-local. Every analysis loads the whole
  workspace into one TypeScript project (external usage, concept evidence),
  cruises the whole module graph (gravity reach, change radius, and every
  file an import reaches: manifests, styles, plain JavaScript), indexes
  every declaration in the workspace by name and property for concept
  overlap, and ranks churn against the history of every tracked file. So
  the sound input set of one report is the whole workspace, and the
  fingerprint says so: `analysis` (report schema and policy through the
  stage graph), `config` (roots, exclusions, profile), `clock`, `sources`
  (content hash of every workspace source file, cruised module, and
  manifest), and `history` (every commit hash in the root's log plus every
  tracked path). Packages differ only by identity; a report is reusable
  exactly when nothing the analyzer can read has moved. No tsconfig is an
  input: the worker never passes one, the project uses fixed compiler
  options plus workspace aliases from the manifests, and the cruise uses a
  synthesized tsconfig built from the same aliases.
- **Consequences.** A no-change build, a build after edits to files the
  analyzer never reads (docs, styles outside the graph, tool configuration),
  and a build after an analyzer-schema-neutral cache miss reuse every
  report. Any source, manifest, or commit change re-derives every
  assembled report (since V12.6 only the packages whose own sources moved
  are re-analyzed; see the next section); a comment-only edit re-derives
  too, but the fresh report canonically equals the cached one, the cached
  bytes are kept, and the artifact is reused (`unchanged` in the result).
  The explorer under
  `examples/explorer/` is imported by this package's tests, so it is part
  of the workspace module graph and an explorer edit invalidates the
  reports; that is the analyzer's truth, not a cache defect. The analysis
  clock defaults to the start of the current UTC day so builds within a day
  share every history input; the first build after a day boundary
  reanalyzes every package with history (`daysSinceLastChange` and the
  churn windows depend on the clock).
- **Stage graph.** `semantics-stages.ts` declares the stages
  (`packageLocalAnalysis` and `workspaceDerivation` since V12.6,
  `packageAnalysis`, `workspaceIngestion`, `workspaceIntelligence`,
  `workspaceProjection`, `materialization`, `historySnapshot`), their
  schema and policy versions, and their direct dependencies. A stage
  fingerprint hashes the versions of its transitive closure, so a
  projection schema bump invalidates projections and the dataset but not
  package reports or history snapshots, while a package policy bump
  invalidates everything downstream. The history checkpoint cache is keyed
  by the `historySnapshot` closure plus roots, exclusions, and profile;
  its directory now carries the cache schema (`v2/<fingerprint>/` since
  V12.6), a
  cached snapshot is validated (parse, schema, commit) before reuse, and
  entries are written whole (temp then rename). Entries from V12.3 are
  orphaned by the new key; delete `.foundry/cache/semantics-history` to
  reclaim the space.
- **Cache.** `.foundry/cache/semantics/` holds one current report per
  package (`packages/<id>.json`, plus `packages/<id>.local.json` since
  V12.6) with a sidecar
  `packages/<id>.meta.json` (cache schema, entry kind, id, path,
  fingerprint and its components, report schema, informational
  `analyzedAt`),
  `workspace-inputs.json` (path → hash of the last build's inputs, so
  `--explain` can name the changed files), and `lock.json` while a build
  runs. `SEMANTICS_CACHE_SCHEMA_VERSION` (2) is independent of every
  dataset schema; an entry is reused only when the cache schema, kind, package
  id, fingerprint, and report schema all match and the report parses, and
  anything else is a miss with a recorded reason (`cache-missing`,
  `cache-corrupt`, `cache-schema-changed`, or the fingerprint component
  that moved). Entries land with a rename after each analysis, so a build
  that dies after twenty packages keeps twenty. A package that disappears
  from discovery has its entry removed. The cache is never truth: deleting
  it changes nothing but the next build's time, a full build ignores it on
  read and still fills it, and a failed analysis is recorded as failed
  rather than served from a stale entry.
- **Lock.** One build per cache directory. `lock.json` records the pid and
  start time; a lock whose process is dead is taken over, a live holder
  fails the new build before it touches anything.
- **Materialization.** The new tree is still built under
  `.foundry/semantics.tmp-<pid>` and swapped in by one rename, so the
  previous dataset survives any failure. Before writing an artifact the
  writer compares its bytes with the previous dataset's file and, when they
  are equal, hardlinks the old file into the new tree (copy where the
  filesystem refuses), so unchanged artifacts keep their inode and mtime.
  Workspace ingestion, intelligence, projections, and the module shards
  are always recomputed from the reports in hand: they cost about a tenth
  of a second on this repository, and partial repair would be a second
  analysis system.
- **Equivalence.** `compareSemanticsDatasets(left, right)` compares two
  datasets artifact by artifact after `canonicalizeSemanticsArtifact`
  removes the documented volatile fields (`SEMANTICS_VOLATILE_FIELDS`):
  the manifest's `generatedAt` and `generation`, the package report's
  `recenteringCandidates.{impacts,reviews}.summary.runtimeMs`, and the
  history manifest's `generatedAt`, `generation`, and per-snapshot
  `durationMs` and `cached`. Nothing architectural is removed. The result
  lists path-addressed differences; the fixture suite asserts equivalence
  after every scenario, and the comment-only case uses the same
  canonical text to decide that a fresh report may keep its cached bytes.
- **Result and manifest.** The generation result reports `mode`, the
  package counts (analyzed, unchanged, reused, failed), the artifact
  counts (generated, reused, removed), the invalidation list (one record per package with
  status, direct reason, changed inputs, and fingerprint; one per workspace
  stage with the reports it was recomputed from), cache statistics, and a
  `fingerprint` phase timing. The manifest's `generation` block carries
  `mode`, `packagesAnalyzed`, `packagesReused`, `artifactsGenerated`, and
  `artifactsReused` as provenance; clients never need them.
- **Not built.** No watcher, daemon, database, distributed or cloud cache,
  browser-side invalidation, stage-level package-report reuse, or partial
  workspace repair. Analyzer intelligence is untouched.

## Package-local analysis and workspace derivation

V12.6 splits the package analyzer into two halves along one question:
could this fact be computed the same way if the unchanged package were
copied into a different workspace with different neighbours? What can is
**package-local** and is computed from the package's own files alone; what
cannot is **workspace-derived** and is computed once per workspace from
every local report. The invariant:

> Package-local facts describe the package. Workspace-derived facts
> describe the package's relationship to its current environment.

`SurfaceReport` is unchanged and remains the compatibility boundary: it is
now the join of a `PackageLocalReport` and the package's
`WorkspaceDerivedPackageFacts`, assembled by `assembleSurfaceReport` with
no analysis of its own. Every consumer (workspace ingestion, projections,
history, the explorer) reads the same shape it did.

```
packages ──► analyzePackageLocal ──► PackageLocalReport (one per package, cacheable)
                                            │
             deriveWorkspaceSurface ◄───────┘   one shared program, cruise, git log,
                     │                          reference index, concept sweep
                     ▼
             WorkspaceDerivedPackageFacts (one per package)
                     │
             assembleSurfaceReport ──► SurfaceReport (unchanged shape)
```

- **Package-local analysis** (`package-local.ts`) loads the package-owned
  sources — `packageSourceFiles`, the same rule the local fingerprint and
  the leak tests enumerate by — into an in-memory-file-system ts-morph
  project holding only those files plus the package's own manifest aliases
  (and any tsconfig `paths` that point into the package). A foreign import
  cannot resolve there, so workspace facts are unreachable by construction
  rather than by discipline. The report records identity (name, path,
  boundary type, declared entrypoints and subpaths), sources with file
  kinds, symbols with their intrinsic fields (`exported`, `packagePublic`,
  declaration file, line), imports as addresses (specifier, names, scope
  `internal`/`external`, never a resolution), concept seeds, module roles,
  local complexity, and the local half of the summary. It reads no clock
  and no Git. `PACKAGE_LOCAL_REPORT_SCHEMA_VERSION` (1) versions it apart
  from `SurfaceReport`.
- **Workspace derivation** (`workspace-derive.ts`) builds the shared
  program once, cruises the module graph once, collects Git history once,
  indexes every identifier in the program once (`reference-index.ts`,
  replacing one `findReferences` call per exported symbol), sweeps concept
  evidence once over the union of every package's seeds, builds the concept
  overlap index once, and then runs the V2–V8 chain per package against
  those shared indexes. It produces the usage fields of every symbol,
  dependencies, gravity, profiles, boundary interactions, pressure, churn,
  hotspots, coupling, radius, evolutionary pressure, concept evidence and
  distribution, overlap, ownership, locality, re-centering, and the derived
  half of the summary. One local metric is re-measured here:
  `localComplexity` `parameters.boolean` resolves annotation types, and an
  annotation naming another package's type is only known to be boolean or
  not on the shared program (`patchBooleanParameters`).
- **Fact locality** (`fact-scope.ts`, read by the leak tests):

  | `SurfaceReport` field                                                                                                      | scope             |
  | -------------------------------------------------------------------------------------------------------------------------- | ----------------- |
  | `target`, `anchor`, `symbols[].{id,name,kind,declarationFile,exported,packagePublic}`                                      | package-local     |
  | `summary.{totalSymbols,moduleExportedSymbols,packagePublicSymbols,moduleOnlyExports,declaredSurfaceRatio}`                 | package-local     |
  | `localComplexity` except `parameters.boolean`                                                                              | package-local     |
  | `dependencyGravity` module roles and file kinds; `conceptInventory` seeds                                                  | package-local     |
  | `symbols[].{externalReferences,externalImportSites,consumer*,primaryConsumerShare,usageNamespace,usageContexts,access}`    | workspace-derived |
  | `summary.{externallyUsedSymbols,unusedExternalExports,externalSurfaceRatio,exportUtilization}`                             | workspace-derived |
  | `dependencies`, `opportunities`, `ineligibleOperations`, `plans`, `operators`                                              | workspace-derived |
  | every gravity measurement, `architecturalProfile`, `boundaryInteractions`, `structuralPressure`                            | workspace-derived |
  | `churn`, `hotspots`, `changeCoupling`, `changeRadius`, `evolutionaryPressure`                                              | workspace-derived |
  | concept evidence, distribution, `conceptOverlap`, `conceptOwnership`, `conceptBehavioralLocality`, `recenteringCandidates` | workspace-derived |

- **Two cache tiers** (`SEMANTICS_CACHE_SCHEMA_VERSION` 2).
  `packages/<id>.local.json` holds the package-local report, keyed by the
  package's own sources and manifest plus the `packageLocalAnalysis` stage
  version; `packages/<id>.json` holds the assembled report, keyed by the
  V12.5 workspace fingerprint because its derived half reads everything.
  A build analyzes only the packages whose local key moved, then either
  reuses every assembled report (no report key moved) or derives once for
  all packages. Derivation is all-or-nothing by design: its inputs are the
  whole workspace, and a per-package derived cache would be keyed by the
  same fingerprint as the assembled report. A fresh derived report that
  canonically equals the cached one keeps the cached bytes (`unchanged`).
  Schema-1 entries are rejected as `cache-corrupt`, never read as local.
  A derivation failure aborts the build and leaves the previous dataset.
- **Explain.** `--explain` now prints two sections, headed
  LOCAL ANALYSIS (recompute = LOCAL INPUT INVALIDATION) and
  WORKSPACE DERIVATION (recompute = WORKSPACE DERIVED CHANGE). The first
  lists each package as reused (`local facts unchanged`) or recomputed
  with the own-source paths that moved (`own sources changed`). The
  second says whether derivation runs
  and from how many changed local reports, then lists each assembled
  report as reused or recomputed with the workspace cause, which is a
  workspace-derived change: workspace sources changed (naming the files,
  in any package), git history changed, analysis clock changed, or
  semantics config changed. A
  consumer edit therefore shows the provider's local report reused and its
  assembled report re-derived, which is the split made visible.
- **History.** Each checkpoint runs local analysis per package, then one
  derivation under the `temporal` profile. Historical locals are cached by
  content alone, one file per local fingerprint under
  `.foundry/cache/semantics-history/local/v1/`: a package unchanged
  between two checkpoints is analyzed once, and a derivation-policy change
  (which invalidates every snapshot) reanalyzes no package. Checkpoint
  timings record `localsReused`.
- **Equivalence.** The rewrite was checked against the monolithic analyzer
  run in the same process at the same instant on every one of the 27 real
  packages, on the fixtures, and against a full V12.5 dataset and a V12.5
  temporal build of the same frozen checkout. Seven findings surfaced:
  four were resolved by reproducing the old result exactly, one is a
  deliberate normalization of the output, and two are documented
  exceptions:
  1. ts-morph's `findReferencesAsNodes` resolves a reference span to a node
     by comparing the node's _width_ with the span's _end_ (a ts-morph
     bug), so some references land on the wrong ancestor. The index
     reproduces that resolution exactly rather than fixing it, so
     classification does not drift.
  2. Program files outside the project (`dist/*.d.ts` reached through
     resolution) count as consumers in the old analyzer. The index walks
     the program's files, not the project's, and wraps them without
     marking them in-project.
  3. Concept overlap listed shape properties in the checker's resolution
     order, which depends on what was resolved earlier. Properties are now
     sorted by name, and `SEMANTICS_UNORDERED_FIELDS` names the
     overlap structure lists so canonical comparison ignores order.
  4. A property keyed by a unique symbol is named `__@name@<id>` by the
     checker, where the id is the resolving program's allocation counter.
     It was never a fact about the type and moved with every program, so
     the id is now stripped (`__@asyncDispose`). This is the one place
     V12.6 reports deliberately differ from V12.5 reports; nine packages
     carried such names, and every one is equivalent once the id is
     removed from the old side. Matching still uses the checker's full
     name, so two distinct unique symbols with one base name (the four
     `captureRejectionSymbol` declarations in `@types/node`) stay
     distinct and appear as repeated names in a structure list.
     Downstream, six cross-package overlap
     pairs that V12.5 ingested as conflicts (each package's program had
     named the same unique-symbol property with a different id) now agree
     and are `verified`; the workspace conflict count drops from 45 to 39.
  5. The monolithic analyzer chose a seed's overlap declaration through a
     map keyed by symbol id over every collected symbol, last write wins
     and no kind filter, so a function declared after a same-named
     interface hid that interface from overlap generation (one seed in
     `@foundry/ui`). Reproduced as-is; a fix belongs with a policy bump.
  6. _Exception:_ enumerating the properties of a union such as
     `Float32Array | ArrayBuffer | Buffer` follows type-id creation order
     in the checker, so a fresh per-package program can list six shared
     properties where the shared program lists three. The old result was
     itself order-dependent; one candidate in `@foundry/models` differs.
  7. _Exception:_ raw JSON key order inside overlap structure lists differs
     from the old reports (sorted now); canonical equivalence holds.
- **Measured on this repository** (27 packages, 3 001 workspace sources,
  frozen checkout, pinned clock, `bun` workers, 4 concurrent). The V12.5
  column holds the two full builds measured this session (the V12.5 CLI
  from the same checkout, 4 workers: 423 s; a 2-worker in-process
  baseline: 574.5 s); every other V12.5 cell is inferred from V12.5's
  rule that any source, commit, or clock change reanalyzes all 27
  packages, and is marked as such.

  | scenario                                      | V12.5             | V12.6 | locals analyzed | reports derived   |
  | --------------------------------------------- | ----------------- | ----- | --------------- | ----------------- |
  | cold full build                               | 423 s             | 83 s  | 27              | 27                |
  | no change                                     | fingerprint only  | 6.8 s | 0               | 0 (27 reused)     |
  | `@foundry/db` public interface edit           | all 27 (inferred) | 104 s | 1               | 27 (24 unchanged) |
  | formatting-only edit in `@foundry/db`         | all 27 (inferred) | 74 s  | 1               | 27 (26 unchanged) |
  | README edit                                   | fingerprint only  | 7.0 s | 0               | 0 (27 reused)     |
  | explorer `app.js` edit (in the cruised graph) | all 27 (inferred) | 72 s  | 0               | 27 (27 unchanged) |
  | clock rollover                                | all 27 (inferred) | 68 s  | 0               | 27                |
  | git-only change (one commit)                  | all 27 (inferred) | 83 s  | 0               | 27                |
  | history, cold (2 checkpoints)                 | 110 s             | 43 s  | 42 distinct     | 2 derivations     |
  | history, cold (9 monthly checkpoints)         | not measured      | 109 s | 95 distinct     | 9 derivations     |
  | history, warm                                 | not measured      | 1.8 s | 0               | 0 (9 cached)      |

  The formatting-only row inserted a blank line, which moves the start
  line of every later symbol, so the local report legitimately changed.
  Local analysis of `@foundry/db` alone takes 0.5 s where the monolithic
  analyzer took 35 s; all 27 locals take 7 s. Derivation is 62–98 s,
  of which the per-package V2–V8 chain over the shared indexes is about
  34 s, the concept sweep 16 s, the reference index 10 s, the cruise 5 s,
  symbol collection 4 s, history 2 s, and the overlap index 1 s.
  Fingerprinting (hashing every workspace file and the Git log) is a
  constant 5–7 s. The cache holds 49 MB of local reports beside 207 MB of
  assembled reports. Peak resident memory of the derivation process is
  about 20 GB (`process.resourceUsage().maxRSS`, one in-process run over
  all 27 locals; the 27 local analyses alone peak at 1.9 GB): the shared
  program, the reference index, and the overlap index are all held at
  once, where V12.5 held one workspace program per worker.

- **Not built.** No per-package derived cache (the derived half of every
  report depends on the whole workspace; partitioning derivation by
  affected package would be a second invalidation system), no watcher,
  daemon, or database, no file-level incremental compilation, no
  stale-fallback, no analyzer retune. The explorer and every browser
  artifact are untouched.

## Internal package topology

V13.0 looks inside one package: `analyzeInternalPackageTopology(local)`
is a pure function of a `PackageLocalReport` that reconstructs the
package's module graph, symbol flow, directory tree, path-region seams,
layers, cycles, aggregators, and structural bridges. It reads no file,
builds no program, and knows nothing of the workspace; the same package
yields byte-identical topology in any workspace, under any Git history,
on any day. Facts only: no score, no recommendation, no label beyond the
role vocabulary below.

```sh
bun run analyze -- @foundry/studio --topology          # rendered
bun run analyze -- @foundry/studio --topology --json   # full model
```

`--topology` runs local analysis and derivation only, never the
workspace analyzer, and prints both timings to stderr. The model
(`InternalPackageTopology`, `INTERNAL_PACKAGE_TOPOLOGY_SCHEMA_VERSION`
= 1, versioned apart from the local report) holds:

- **Modules** — every owned source file, id = package-relative posix
  path. Each carries its file kind, owning directory, path region,
  syntactic role (V4 aggregator/internal), declared and exported symbol
  counts, `fanIn`/`fanOut` (distinct primary neighbours), incoming and
  outgoing import sites, provided symbols (own declarations other
  modules consume, directly or through a barrel), symbol consumers,
  consumed symbols, `contextFanIn` (test/story/config importers),
  `externalFanOut` (distinct external specifiers), layer, and cycle id.
- **Edges** — one directed edge per (source, target) pair aggregating
  every import and re-export site that resolved between them: site
  counts by kind (re-export, type-only, value, namespace, side-effect),
  the named symbols crossing with their resolved declaring module and a
  `mediated` flag when a re-export chain sits between, summed binding
  occurrences, path locality (`same-directory`, `same-region`,
  `cross-region`), and directory-tree distance. A self-import is listed
  in `selfImports`, not as an edge.
- **Primary topology** — the subgraph whose endpoints are both
  `source`-kind files. Test, story, and config modules stay as nodes and
  their edges stay in `edges` (`summary.contextEdgesByKind`), but fan
  counts, cycles, layers, seams, roles, and distributions are measured on
  primary edges only, so a large test suite never becomes the package's
  shape.
- **Directories** — the complete tree above every owning directory
  (`"."` is the package root), with direct and descendant module counts,
  children, and primary edges internal to, entering, and leaving the
  subtree. `directoryEdges` aggregate primary edges by owning-directory
  pair for drill-down.
- **Path regions and seams** — a module's region is the first directory
  segment after stripping one leading technical root
  (`config.internalTopology.technicalRoots`: `src`, `source`, `lib`), or
  `"."` when nothing remains; `src/canvas/editor/a.ts` → `canvas`,
  `src/index.ts` → `.`, `test/x.test.ts` → `test`. A seam is one ordered
  region pair with module edges, import sites, distinct symbols,
  participating source and target modules, each side's participation
  share, the dominant source, target, and symbol with their shares, and
  the share of edges landing on an aggregator. `canvas → tasks` and
  `tasks → canvas` are separate seams. Regions are path facts, not
  responsibility regions; that is V13.2.
- **Cycles** — every strongly connected component of size > 1 on the
  primary graph (the V5 Kosaraju condensation, seeded in sorted module
  order), ids `cycle-1…` by size then first member: members, internal
  edges and sites, distinct symbols, directories and regions spanned,
  scope (`directory`, `region`, `cross-region`), entry and exit edges,
  and the most-imported internal symbols. Simple cycles are not
  enumerated; the component is the fact.
- **Layers** — the workspace convention: a module's layer is the longest
  primary dependency chain from its component to a sink on the
  condensation, so layer 0 depends on nothing internal. A graph position,
  not a quality.
- **Roles** — independent, overlapping, every criterion explicit:
  `dependency-source` (fan-in 0), `dependency-sink` (fan-out 0),
  `isolated` (both 0), `high-fan-in` / `high-fan-out` (at or above the
  90th percentile of the package's connected modules, never below 3;
  `config.internalTopology.highFan`, the resolved cutoff is in
  `summary.highFanCutoff`), `aggregator` (V4 syntactic role),
  `bridge` (articulation point of the undirected projection, recorded as
  `policy.structuralConnectivity: "undirected-projection"` because it
  says nothing about dependency direction), `satellite` (exactly one
  neighbour, not an aggregator), `cycle-member`.
- **Consumed surface** — every owned declaration consumed by another
  primary module, attributed to its declaring module: consumers with
  sites, type-only sites, binding occurrences, and the barrel they came
  through; consumer directories and regions. Export declaration and
  internal consumption stay separate fields. Not the package-public
  surface.
- **Summary** — counts, the high-fan cutoffs, and min/median/p90/max of
  fan-in, fan-out, edge symbols, modules per directory, and seam volume.

Two local facts were added for it (local report schema 2): each internal
import site now records `targetModule`, and each site that binds a local
name records `bindingOccurrences`, the syntactic count of that identifier
in the module outside import and export declarations (not
checker-resolved; a shadowing local of the same name counts). The local
project now also honours the `paths` of the package's own
`tsconfig.json` that point inside it (`~/*` in `@foundry/studio`), which
the shared workspace program never did; before this, 642 of studio's
internal edges were recorded as external. Symbol resolution through
barrels follows named re-exports, `export *`, and import-then-export
forwarding from report facts alone. Since V13.1 (local report schema 3,
topology schema 2) a default import resolves through the module's
recorded `defaultExports` entry to the named declaration behind `export
default Foo`, `export default function Foo`, `export { Foo as default }`,
or a forwarded default; an anonymous or expression default stays
unresolved rather than being named after its file. A namespace import
contributes only the members actually accessed through the binding
(`ns.member` in value or type position, recorded as `members` on the
site) as `namespaceSites` on the edge symbol; a bare use of the namespace
names no symbol and is never fanned across the target's exports. Every
aggregate sorts canonically; the model carries no absolute path,
timestamp, or timing.

Derivation is linear in modules, edges, sites, and directory depth, and
costs 3–41 ms against 0.2–3 s of local analysis (`@foundry/artifacts` 9
modules → `@foundry/ui` 985 modules, 2,423 edges), with no measurable
heap growth beyond the model itself (33 KiB–3.2 MiB serialized). It has
no cache of its own: the V12.6 local cache already holds the expensive
input. The stage registry lists it as `internalPackageTopology`, a leaf
under `packageLocalAnalysis` that no workspace stage consumes.

## Symbol locality

V13.1 asks, for every internally consumed symbol, where it is declared
and where its consumers sit. `analyzeSymbolLocality(local, topology)` is
a pure function of the local report and its topology: no file, no
program, no workspace, no Git. It describes placement tension; it names
no better place, and there is no locality score.

```sh
bun run analyze -- @foundry/ui --locality               # rendered
bun run analyze -- @foundry/ui --locality --json        # full model
bun run analyze -- @foundry/ui --topology --locality    # both sections
```

The model (`SymbolLocalityReport`, `SYMBOL_LOCALITY_SCHEMA_VERSION` = 1,
stage `symbolLocality` under `packageLocalAnalysis` and
`internalPackageTopology`) holds one finding per consumed-surface symbol
plus the scope hierarchy it was measured against:

- **Scopes** — `package:<id>`, `region:<id>`, `directory:<path>`,
  `module:<path>`, each with its parent and primary modules. Modules sit
  in directories, directories nest to the root, regions partition the
  modules beside that tree; both roll up to the package.
- **Declaration** — module, directory, region, depth, the symbol kind,
  whether it is a concept seed, module-exported, and package-public.
  External usage never enters locality; the public flag is context.
- **Consumers** — modules, directories, regions, import sites, namespace
  sites, binding occurrences, how many reached the symbol through a
  barrel, how many are type-only. Gravity attaches to the declaring
  symbol, never to the barrel. Usage is `type`, `value`, or `both`.
- **Common scope** — the deepest directory holding every consumer; the
  region when that directory is the root or a technical root; the package
  across regions; the module for one consumer. Beside it, whether the
  declaring directory is the `same`, an `ancestor`, a `descendant`, or
  `disjoint`.
- **Concentration** — every consumer region with its share of consumer
  modules, import sites, and binding occurrences, ranked; the top region
  is `dominantRegion` at or above `dominantShareThreshold` (0.6) and a
  region is `significant` at or above `significantShareThreshold` (0.1).
  Shares that classify are over consumer modules, so one heavy file never
  becomes the center; the binding share sits beside it for the
  one-heavy-consumer case. `dominantModule` is the consumer with the most
  binding occurrences, `dominantDirectory` the one with the most modules.
- **Distribution shape** — `module-localized`, `directory-localized`,
  `region-localized`, `multi-region` (one dominant region, or a two-way
  split), `package-distributed` (several regions, neither).
- **Placement** — `aligned`, `broader-than-consumers` (declaring
  directory above the common consumer directory), `narrower-than-consumers`
  (below it, with at least two significant regions), `cross-region` (the
  dominant region is not the declaring one), `cross-directory` (a sibling
  directory inside the same region), `split` (exactly two significant
  regions, none dominant, together reaching the dominant threshold),
  `distributed`, `unclear` (fewer than `minimumConsumers` = 2). A
  package-wide primitive such as `cn` is `distributed`, not tension.
- **Seams** — `consumerRegion→declarationRegion` for every consumer
  outside the declaring region, regardless of which module mediated.
- **Structure** — weakly connected groups of the primary graph induced on
  the consumers alone, layer span, the cycle holding the most consumers,
  and the bridge and aggregator shares among them. Path locality says
  little in a flat package; this is the evidence beside it.
- **Behavior** — whether the declaration owns measured functions
  (`behavior`), is an interface or type alias (`contract`), or a value;
  the consumer modules' executable statements by region, the
  behavior-heaviest region, and whether it is the module-heaviest one.
  Usage locality and behavior locality are kept apart on purpose.
- **Evidence and limitations** — `complete`, `partial`, or `limited`,
  from evidence completeness only; per finding `single-consumer`,
  `namespace-member-derived`, `namespace-bare-use`; globally, that
  intra-module usage is not measured, that consumer-side concept
  evidence (the local report's participation index, V13.2) is not folded
  into findings, and that binding occurrences are syntactic.
- **Summary** — counts by distribution, placement, usage, and
  declaration shape; median/p90/max of consumer modules, directories,
  regions, and top-region share; identity gaps (unresolved default
  import sites, anonymous defaults, bare namespace sites).

Thresholds live in `config.internalLocality` and are echoed in
`report.policy`. Derivation is linear in consumer evidence and topology
indexes and costs 0–15 ms after topology (1.8–2.5 MB serialized for the
three largest packages).

## Internal responsibility regions

V13.2 stops treating the directory tree as the architecture. It asks
which modules of a package form coherent responsibilities, using path
structure as a prior rather than an answer.
`analyzeInternalResponsibilities(local, topology, locality)` is a pure
function of the three package-local models: no file, no program, no
workspace, no Git, no clustering algorithm, no score, no move target.

```sh
bun run analyze -- @foundry/studio --responsibilities            # rendered
bun run analyze -- @foundry/studio --responsibilities --json     # full model
bun run analyze -- @foundry/studio --topology --locality --responsibilities
```

Since V13.2 the local report (schema 4) also carries
`conceptParticipation`: the V7 relationship sweep (`implements`,
`extends`, `alias`, `type-reference`, `parameter-type`, `return-type`,
`property-type`, `constructs`) run over the package's own program, folded
per concept seed and module with the top-level declarations holding the
occurrences. It is the part of each concept's structural family that
lives inside the package, under the same seed and symbol ids V7 and V9
use. One cache refresh follows the schema bump; nothing in the V12
analyzers reads the new field.

The model (`InternalResponsibilityReport`,
`INTERNAL_RESPONSIBILITY_SCHEMA_VERSION` = 1, stage
`internalResponsibilities` under the three V12.6–V13.1 stages) is built
in five deterministic steps, each echoed in `report.policy`:

1. **Units** — every nontrivial cycle is one atomic unit; every other
   primary module is its own unit. A cycle is never split.
2. **Connectors** — modules holding the topology roles `aggregator`,
   `high-fan-in`, or `high-fan-out` contribute no join evidence, even
   inside a cycle unit. This is what keeps `cn`, `Button`, `api`, `t`,
   `index.ts`, and composition roots from pulling a package into one
   region.
3. **Joins** — two units join when a rule fires on a direct primary edge
   between their non-connector modules. A symbol is _localized_ when its
   V13.1 finding is neither `package-distributed` nor `split` and its
   consumer modules stay below the topology's high-fan-in cutoff; a
   mediated symbol pairs the consumer with its declaring module, not the
   barrel. `concept-flow`: the edge carries a localized concept seed.
   `directory-dependency`: the edge carries a localized symbol and both
   endpoints share a directory below the root and technical roots.
   Neither rule has a weight; both are yes/no facts. Split symbols
   connect regions instead of merging them.
4. **Unclaimed modules** — a single module no rule claimed that holds the
   `bridge` role and has localized-symbol edges into several groups is
   `unresolved` (reason `bridge`). The rest fall back to their shared
   directory below the root (`directory-fallback`, evidence `path` only);
   modules directly under the root or a technical root stay alone, so a
   flat `src/` never becomes one region by fiat.
5. **Attachment** — each connector joins the one region its
   localized-symbol edges reach (or, lacking any, the one region any edge
   reaches); several candidates leave it `unresolved` with the candidates
   ranked (`aggregator`, `distributed-primitive` for high-fan-in,
   `wide-dependent` for high-fan-out).

Region identity is a sha256 over the sorted member modules, so an
unrelated change elsewhere leaves an id intact; order is modules
descending then first module; the label is the shared directory below
the root, else the declared concept with the most region participants,
else the highest fan-in module. Every region carries its construction
trace (joins with reasons and symbols), the evidence kinds present
(`path`, `dependency`, `cycle`, `concept`, `behavior`, `symbol-flow`,
`seam`; the complement is what it lacks), a path profile with
`matches-path-region` / `within-path-region` / `spans-path-regions`, a
topology profile, declared and referenced concepts with the relationship
kinds region modules hold to them, source behavior mass (executable
statements of its measured functions, with concept-owned mass and owners
beside it), and a symbol profile (declared, responsibility-local,
crossing, consumed from outside, distributed primitives consumed, and
V13.1 usage/behavior disagreements). Behavior is a profile, never a join
reason.

Beside the regions: `relationships` (primary edges aggregated by ordered
region pair, with symbol flow, concepts crossing, dominant symbols, how
many edges stay inside one path region, and mediated edges),
`regionCycles` (strongly connected responsibilities), `pathSeams` (each
V13.0 seam split into edges within one responsibility, across
responsibilities, or touching an unresolved module), `symbols` (each
V13.1 finding with its declaring and consumer responsibilities and
`responsibility-local` / `responsibility-crossing` / `unplaced`),
per-module evidence (unit, status, region, roles, concepts, behavior
mass, localized symbols, whether its directory agrees with the region,
and affinities to other regions), and the unresolved list. The summary
counts path agreement, path regions split, responsibilities spanning
paths, concept and behavior support, relationships hidden inside one
path region, path seams collapsed inside one responsibility, and
unresolved modules by reason. Query helpers: `getResponsibilityRegion`,
`getModuleResponsibility`, `getRegionsByPath`, `getRegionsByConcept`,
`getResponsibilityRelationship`.

Only list sizes live in `config.internalResponsibilities`; the join rules
reuse the topology's high-fan cutoff and V13.1's shapes. Derivation is
linear in edges, findings, and participation entries plus one union-find
over units, and costs 2–24 ms after locality (29 KB–1.6 MB serialized).
Anchors are package-level in the local report, so no internal anchor
constrains a join yet.

## Primitives and conventions

V13.3 moves the unit of understanding from the file name to the symbol.
A `types.ts`, `constants.ts`, `config.ts`, or `shared/` module is
explained by what its symbols are (architectural role), which V13.2
responsibilities they serve (scope), and how comparable symbols are
already placed elsewhere in the package (conventions).
`analyzePrimitiveConventions(local, topology, locality, responsibilities)`
is a pure function of the four package-local models; `--primitives`
renders it (combinable with `--topology`, `--locality`, and
`--responsibilities`; `--json` nests several under `primitives`,
`topology`, …). The report has its own
`PRIMITIVE_CONVENTION_SCHEMA_VERSION`.

Roles come from declaration shape and explicit concept relationships,
which the local report now records per symbol (schema 5:
`declarations[]` with the variable initializer form, `as const`, the
callee root of a call and the import specifier that bound it, the type
alias shape, callable versus data members, `abstract`, the local type
named by an annotation, `typeof` queries, whether a function body holds
JSX, and the symbol's own V7 relationships to local seeds). The
vocabulary: `identifier` (branded primitive, or a scalar alias named as
an id), `constant` (enum, or a literal/array/object initializer),
`configuration` (a constant object annotated with or named as a
config/options/settings/policy type, and the type such a value is
annotated with), `contract` (callable members, abstract class, or
something local implements it), `schema` (a call into a configured
schema library, or into another schema), `factory` (constructs the local
class it returns, or constructs/returns a local seed under a
create/make/build name), `adapter` (an implementation holding another
local contract as a property type), `implementation` (implements or
extends a local seed, or an object annotated with a local contract),
`representation` (a data-only type derived from a seed by extension or
alias, or from a schema through `typeof`), `utility` (a free function
without JSX, no concept relationship, few statements, several consumer
modules), `behavior`, `type`, `value`, and `unknown`. A symbol may hold
several roles (`ANALYSIS_CONFIG` is `configuration` and `constant`); the
primary role is the first in a fixed precedence. Naming patterns are
supporting evidence only: a name that suggests a role the structure does
not support is recorded as a `naming-disagrees` ambiguity, never applied.

Scope is read from V13.2's consumer responsibilities, not from the
declaring module's placement: a symbol declared inside an unresolved hub
still gets a measured scope. `module-local` is structural (not
exported); `responsibility-local` is one consumer responsibility, with
`served.declarationAgrees` saying whether the declaration sits in it;
`cross-responsibility` is several; `package-wide` is at least the larger
of a floor and a share of the package's regions
(`config.primitiveConventions.packageWide`); `unplaced` is an unresolved
declaration with no placed consumer; `unclear` is an export with no
internal consumer or no placed one. Every finding keeps the V13.2 label,
the V13.1 distribution and placement, evidence completeness, and its
limitations.

Modules are described from their exported classified symbols: role
composition (`single-role` at the dedicated-role share, else
`mixed-role`), scope composition (one scope group, or `mixed-scope`
across several served responsibilities, cross-responsibility, and
package-wide), fragmentation counts, shapes (`primitive-hub`,
`contract-hub`, `configuration-hub` at the hub thresholds;
`implementation-module`; `aggregator` from V13.0, never a hub), and
colocation patterns (`contract+implementation`, `schema+type`,
`type+behavior`, `constant+behavior`). Private declarations count in the
totals but do not make a module mixed. The symbol universe is the
primary modules' declarations, as in V13.1 and V13.2.

A convention is a placement value recurring among symbols of one role
and scope, at or above `conventions.minimumSupport`, along three
independent dimensions: module (`dedicated-role-module` /
`mixed-role-module`), directory (`package-root`,
`dedicated-role-directory`, `outside-responsibility`,
`responsibility-root`, `inside-responsibility`, `no-responsibility`),
and colocation (with or without behavior, with or without types). Each
group reports every value seen and a status per dimension:
`convention`, `competing` (several values qualify; none is preferred),
or `insufficient-evidence`. Support and exceptions are raw counts with
symbol, module, and responsibility ids; provenance lists the basenames
among the support. Groups are also formed by role alone (`scope: "any"`)
so the two groupings can be compared. The summary carries the role ×
scope matrix, module composition and shape counts, role-named modules
that mix scopes, convention counts under both groupings, and how many
V13.2 unresolved modules now have a shape or a mixed composition. Query
helpers: `getSymbolRole`, `getModulePrimitives`, `getSymbolsByRole`,
`getConventions`. The rendered view ends with a module microscope: the
unresolved or mixed-scope modules broken down symbol by symbol.

Derivation is one pass over symbols for roles and scope, one over modules
for shapes, and one over each convention group per dimension (exceptions
are group members per qualifying value; schema-derived types are a scan
per schema); it costs 3–29 ms after responsibilities (125 KB–7.5 MB
serialized). Nothing here names a
move; a package-wide primitive is a valid shape, and unresolved hubs stay
unresolved.

## Internal rewiring scenarios

V13.4 moves from description to counterfactual: given the five
package-local models, which arrangements of a package's symbols,
modules, and internal dependencies could be more coherent, and what
would structurally change under each.
`analyzeInternalRewiring(local, topology, locality, responsibilities, primitives)`
is a pure function of those reports; `--rewiring` renders it (combinable
with the other four flags; `--json` nests it under `rewiring`). The
report has its own `INTERNAL_REWIRING_SCHEMA_VERSION`. Scenarios are
alternatives, not recommendations: every subject with a scenario also
carries a `preserve-current` baseline, several scenarios may coexist for
one subject, and nothing ranks them. No source is read or written.

The local report gains one additive fact for this (schema 6): each
internal, non-type import binding records how it is used (`uses`:
constructed, called, passed as an argument, placed in an object or array
literal, rendered as a JSX tag), by the same syntactic-by-name rule as
`bindingOccurrences`. From those uses the analysis describes how every
primary module consumes the responsibilities it depends on
(`composition[]`): `composition` (constructs or renders bindings from
several responsibilities), `registration` (collects them in literals),
`orchestration` (calls them, under an export cap), `provision` (passes
them into calls), `aggregation`, `ordinary-dependency`, or `unclear` (a
V13.2 wide-dependent module without such evidence). A composition root
holds a wiring role, depends on at least
`config.internalRewiring.compositionRoot.minimumResponsibilities`,
exports few symbols, and wires into several responsibilities; it
receives `preserve-composition-root`, never a move, while any
responsibility-local declaration stranded inside it keeps its own
scenario.

Candidates come from V13.3 findings, each with explicit eligibility
(`candidates[]` keeps the ineligible ones with reasons and missing
evidence). The vocabulary: `demote-primitive` (responsibility-local,
declared in a module placed in another responsibility),
`colocate-primitive` (the same, declared in an unresolved module),
`promote-primitive` (cross-responsibility or package-wide, declared
inside one placed responsibility, with at least two other consuming
responsibilities; one is an ordinary dependency),
`split-module-by-responsibility` (a mixed-scope module: a partial
scenario separates the strongest responsibility-local group, a full one
every group at the minimum size; cross-responsibility and package-wide
groups stay as the remainder), `split-module-by-role` (mixed-role at one
scope, with an observed dedicated-role-module convention),
`align-with-convention` (an exception to a strong dedicated-role-module
convention), `formalize-responsibility-surface` (one responsibility
reaching several deep modules of another),
`formalize-cross-responsibility-contract` (contract-family symbols
consumed across a relationship while declared beside behavior),
`redirect-internal-dependency` (the consumer edges that would follow a
demotion or colocation), `collapse-indirection` (one consumer, one
provider, few exports, little behavior, no concept, no contract or
implementation role), and the preservations `preserve-package-primitive`
and `preserve-cross-responsibility-contract`. Symbol scenarios are
grouped by declaring module and target; ids are a sha256 over the kind,
the sorted subject ids, and the proposed target.

Targets stop at an architectural scope (a responsibility, a shared
scope, dedicated-role modules, a surface) and list existing modules that
match by role, scope, concept, or convention; no path is fabricated.
Effects are simulated over the affected subgraph from canonical
topology: consumer edges lose the moved symbols (an edge carrying nothing
else disappears, a consumer reaching the symbol through a re-export
loses its edge to the forwarding module), each consumer gains an edge to
the target, and the counts of within-, cross-, and unresolved-endpoint
edges, crossing symbols, fan-in, scope and role groups, module count,
locality relation, and convention alignment are reported before and
after. Cycles are reported factually: unchanged, membership removed
(the module leaves its SCC once the removed edges go), or a potential
new cycle (a dependency that must be imported back while the declaring
module already reaches the target scope). The movement closure reads
declaration-level facts only (annotations, `typeof` queries, callees,
concept relationships): module-local dependencies used by the group
alone are `required`, exported ones `optional`, and a module-local
dependency shared with what stays, or a staying declaration that depends
on the group, is a `blocker`; the size is independent, small, large
(at `closure.largeShare` of the module), or unresolved. Each scenario
states what it preserves (symbol identity, module identity,
responsibility ownership, package-wide scope, cross-responsibility
contract, composition role, public exposure, cycle atomicity) and what
stays uncertain (unresolved consumers, package-public external impact,
namespace-derived evidence, an unclear composition role, the incomplete
closure, a large or blocked closure, cycle or composition-root
membership, no existing target module, and the missing internal-anchor
model on every movement). Provenance names the V13.0 modules, edges, and
cycles, the V13.1 findings, the V13.2 responsibilities, and the V13.3
symbols, modules, and conventions each scenario rests on. Query helpers:
`getRewiringScenario`, `getScenariosForSymbol`, `getScenariosForModule`,
`getScenariosForResponsibility`, `getScenariosByKind`,
`getCompositionEvidence`.

Derivation is one pass over primary modules for composition, one over
symbol groups, modules, conventions, and relationships for candidates,
and a bounded simulation per scenario (its consumer edges, the declaring
module's declarations, a reachability check for the cycle guard); it
costs 3–36 ms after primitives (43 KB–6 MB serialized). The largest real
outputs are hub decompositions: a 318-export type module splits into 14
responsibility-local groups with 41 closure blockers, which is the
evidence V13.5 needs rather than a verdict.

## Package architecture review

V13.5 closes the analysis side of V13: given the rewiring scenarios of
one subject, which alternatives are clearly weaker, which preserve
something the evidence requires, and where does more than one
arrangement remain credible. `reviewPackageArchitecture(rewiring)` is a
pure function of the V13.4 report alone (the earlier stages reach it
through each scenario's provenance); `--review` renders it, combinable
with the other five flags, and `--json` nests it under `review`. The
report has its own `PACKAGE_ARCHITECTURE_REVIEW_SCHEMA_VERSION`; the
`packageArchitectureReview` stage depends on `internalRewiring` only. No
source is read, nothing is scored, and no family gets a winner the rules
did not produce.

The unit of comparison is the scenario family; every family keeps its
`preserve-current` baseline (a preservation-only family uses its
preservation scenario as the baseline and says so). Each scenario's
simulated effects become separate dimensions, each with a raw direction
(reduced, increased, unchanged, mixed, unknown), a certainty, and the
before/after measures it rests on: `locality` (subject symbols declared
where their measured scope places them), `responsibility-boundaries`
(cross, unresolved, and crossing counts), `dependency-topology` (edges of
the affected subgraph; fan-in and fan-out as evidence),
`module-composition` (module count, scope and role groups),
`surface-indirection` (deep imports, symbols a surface exposes, behavior
an intermediary hands to its consumer), `cycles` (kept, left, potential
new), `movement-closure` (required declarations and blockers), and
`convention-alignment`, which is supporting evidence and never bears on
dominance. Preservation and uncertainty are the two blocking dimensions.
Certainty is `measured` (simulated with no open assumption),
`conditional` (a new module, unresolved consumers, an incomplete closure,
a redirect that follows a placement scenario which is itself not
credible, an intermediary with behavior), or `unresolved` (a blocked
closure; a promoted group whose target scope has no responsibility, so
its boundary effect cannot be classified). Package-public external
impact and the missing internal-anchor model are recorded on every
movement and never compared: V13.4 movements keep the symbol's public
exposure.

Dominance is strict. A dominates B when neither has an unresolved
dimension; on every dimension where they differ both are measured and A
is no worse (a dimension whose measures move both ways is a difference
that is not no-worse); A is strictly better on at least one; and A keeps
every architectural preservation B keeps that a preservation scenario of
the family asserts (`package-wide-scope`, `composition-role`,
`cross-responsibility-contract`). A baseline can dominate a move that
adds edges without a measured benefit; a move can dominate the baseline
when its every difference is measured and none is a cost. Scenario
status follows: `baseline`, `preservation`, `credible` (nondominated,
resolvable, measured better than the baseline somewhere or trading
measures inside a dimension), `uncertain` (an unresolved dimension, or
only conditional differences), `equivalent`, `dominated`,
`preservation-conflict`. Family dispositions, in precedence:
`insufficient-evidence` (every candidate was ineligible; the missing
evidence is listed), `multiple-tradeoffs` (two or more credible
alternatives), `credible-alternative` (one), `preservation-required` (a
preservation scenario and no credible alternative), `uncertainty-blocked`
(nondominated alternatives that cannot be compared), `preserve-current`.
Tradeoffs are stored per nondominated pair and dimension with the
differing measures, never as prose; a subject view groups the families
of one module or relationship with its composition evidence, the
questions its alternatives leave open, and a complexity record (a
subject is `complex` at two nondominated alternatives changing three
dimensions). Query helpers: `getReviewForScenario`,
`getReviewForFamily`, `getReviewForSubject`, `getReviewsByDisposition`,
`getNondominatedScenarios`.

Review is one pass over families with pairwise comparison inside each
(real families hold two or three scenarios); it costs 1–16 ms after
rewiring and serializes to 23 KB–2.9 MB compact, smaller than the report
it reviews because it references scenario ids. On the real packages the
strict rule dominates rarely (30 of 411 UI pairs, 34 of 480 in Studio: a
placement, split, collapse, or redirect over the baseline, and once the
baseline over a contract surface that only adds exposure) and never
between two alternatives; the common result is a credible alternative that trades
locality against dependency edges, or a comparison blocked by a closure
the declaration-level facts cannot resolve. Every package-wide primitive
and composition root of V13.4 reviews as `preservation-required`, with
its promote alternative visible and unresolved rather than absent.

## Architectural field explorer

`examples/explorer/` (V12.1, multidimensional since V12.2, temporal since
V12.3, coordinated since V12.4) is a disposable
prototype: plain HTML, CSS, and browser JavaScript that turns the static
dataset into an explorable field. No framework, bundler, or analyzer code
runs in the browser; it reads `/semantics/*` and nothing else, and refuses
a dataset whose schema it does not know.

```sh
bun run semantics          # once, ~9 min on this repository
bun run semantics serve    # then open http://127.0.0.1:4173
```

`?debug=1` (or the `d` key) shows FPS, visible nodes, loaded shards,
edge and coupling counts, concept tables, active dimensions, per-force
simulation time, energy, zoom, hover latency, and bytes transferred. `/`
focuses search, `f` refits the camera, `Space` freezes and resumes, `Esc`
clears the selection, `Backspace` steps back through prior selections, and
shift-click keeps a package or module lit as secondary focus. Selection
(module, package, boundary, concept, or pattern), concept focus, preset,
scope, trajectory visibility, and the timeline instant are mirrored into
the URL hash (`#module=…`, `#concept=…&lens=behavior`, `#pattern=…&traj=1`).

- **Timeline (V12.3).** When a `.foundry/semantics-history/` dataset is
  present the `Time` button (or the `t` key) enters timeline mode: a
  bottom scrubber shows commit density, checkpoint markers (hollow while
  loading, solid once solved, red for a failed checkpoint), and a cursor.
  Drag to scrub continuously, click to snap to the nearest checkpoint,
  `Space` plays and pauses, `←`/`→` step checkpoints and `Shift`+`←`/`→`
  jump to the oldest checkpoint or HEAD; the readout labels the instant
  `● measured` on a checkpoint or `○ interpolated between …` in a gap, and
  the events panel names what changed since the previous checkpoint
  (selected entity first). The instant is mirrored into the hash as
  `#t=YYYY-MM-DD`. Nothing temporal loads until the mode is entered: only
  `manifest.json` is fetched to enable the button. Interpolation is
  presentation only — positions between two measured checkpoints are
  linearly blended and clearly marked as such; no interpolated instant is
  ever reported as a fact.
- **Coordinated investigation (V12.4).** One selection coordinates the whole
  environment. A **boundary microscope** — click any package seam in any
  lens — fades the field to the modules that actually cross it (resolved
  from the loaded module edges, source and target kept apart), draws only
  those crossing edges, and fills the inspector with the seam's concept
  load by role (each role drills to its concepts through the directions
  projection), its structure, its patterns, and an edge-volume sparkline
  across checkpoints. **Concept trajectories** trace each role's centre
  (semantic, behaviour, implementation, representation, usage) through the
  measured checkpoints as distinct dashed, marker-shaped trails over the
  field (the `g` key toggles trails; the inspector lists every centre move,
  each jumpable); positions come from the snapshot's own centres, never
  inferred. **Pattern overlays** — a Patterns tab in the explorer and a new
  selection kind — highlight a pattern's packages, boundaries, and concept
  modules without exerting any force (a pattern explains the field, it does
  not shape it), and the panel says plainly that patterns are current-state
  intelligence with no historical classification. **Coordinated events**:
  the change rows in the timeline events panel are clickable and snap the
  instant, apply the relevant lens, and select the affected entity; each
  carries a provenance chip distinguishing an exact `GIT EVENT` (rename,
  move) from a `DERIVED DELTA` measured between two checkpoints, and the
  selected entity's own change markers appear under the scrubber. Every
  panel labels where its facts come from — `CURRENT ANALYSIS`, `MEASURED
CHECKPOINT`, `INTERPOLATED VIEW` — so current-state intelligence is never
  mistaken for measured history. No new backend, framework, score, or
  browser-side analysis: the coordination is projection and presentation
  over the same static dataset.
- **Files.** `index.html`, `styles.css`, and `js/`: `data.js` (the only
  place that fetches; caches by file and counts bytes), `state.js` (store
  and event bus), `model.js` (presentation nodes, shard application,
  emphasis), `simulation.js` (layout mathematics, DOM-free so it runs under
  bun), `canvas.js` (camera, drawing, hit testing, tooltip),
  `explorer.js`, `inspector.js`, `controls.js`, `app.js` (bootstrap and
  frame loop); and, for the timeline, `temporal.js` (the DOM-free union
  universe, per-checkpoint layout, and interpolation), `history.js` (the
  timeline controller: lazy loading, the HEAD-first load-and-solve queue,
  playback, and entity-history queries), `timeline.js` (the scrubber strip
  and coordinated events panel), and `patterns.js` (the on-demand pattern
  index and participant resolution).
- **Bootstrap.** Manifest, overview projection, module index, and
  dependency-topology projection (about 0.7 MB together) are enough for
  the first field. Then, in the background and in this order: module
  shards (5.4 MB, 27 files), edge shards (2.1 MB, 25 files, each arrival
  reheating the field slightly), the concept tables built once every
  module shard is in, and the coupling file (1.0 MB); the concept index
  (1.7 MB) loads in parallel for search. Concept and behavior forces are
  off until the tables exist and history springs until the couplings are
  in, so a half-loaded field never moves for a reason it cannot show; the
  _Semantic detail_ chip counts down until then, and says _Loading concept
  topology_ when a semantic preset is waiting. Clicking a module whose
  shard has not arrived loads that shard first. `workspace.json` is never
  requested.
- **Scope.** _Materialized_ (default) shows the packages this generation
  analyzed; _Referenced_ shows those the workspace knows only by mention
  (one, since fixture workspaces were excluded); _All_ shows both,
  referenced regions dashed and dimmed. Root filters narrow to `apps`, `packages`, or
  `tooling`. _Source only_ (default) drops test, story, and config modules
  from the field, its forces, and the per-package counts; _All files_
  brings them back, tagged in the inspector. Package boundaries stay
  package-level facts and are not re-derived by the toggle. The coverage
  chip repeats the manifest's own numbers.
- **Layout.** Two stages. Packages first: layer bands from the
  dependency-topology projection (sources at the top, sinks at the
  bottom), horizontal seed from a hash of the package id, then a short
  pairwise force run (dependency springs, region separation, centering)
  over at most 58 nodes; a referenced package with topology is homed at
  the mean height of the packages it touches, one without sits in a band
  below the lowest layer. Modules second: each starts on a hash-seeded
  disc inside its package region near a per-directory anchor, then moves
  under five independently weighted dimensions and a grid-bucketed
  collision. Fixed timestep, cooling temperature, settles in about 350
  steps; the same dataset, scope, and weights lay out identically on every
  run, and preset changes never restart the field: weights walk to the new
  values over 30 simulation steps, the field reheats, modules keep their
  identity and flow.
- **Dimensions.** _Package_: a weak pull toward the directory anchor
  (comparable to one spring) plus containment at the region edge that
  keeps a floor even at weight 0. _Dependency_: springs on every module
  edge, internal ones shorter (rest 24 px) than cross-package ones (40 px);
  each endpoint feels the mean of its neighbours, not the sum, and no
  spring pulls harder than a 150 px extension, so a barrel with a hundred
  consumers leans toward them without leaving its region. _Concept_: each
  concept with two or more participants has a virtual layout center, the
  weighted mean of its declared, behavior, and implementation modules
  (every participant when none of those are present); participants are
  pulled toward it by role (declared, behavior, implementation 1;
  conversion 0.6; representation 0.5; usage 0.2), scaled by 1/√participants
  for the concept and 1/√(concepts of that module) for the module, so a
  ubiquitous concept and a promiscuous module each dilute. Cost is linear
  in participations, never pairwise. _Behavior_: the same mechanism with
  the center taken from behavior-role modules only and every other
  participant pulled at 0.3; a concept without behavior participants has no
  behavior center. _History_: springs on co-change pairs with at least 3
  shared commits, strength = √(leftConditional × rightConditional), damped
  by coupling degree; churn and hotspots stay visual (radius, ring) and
  never move anything. The layout centers are presentation devices and are
  named as such in code; the canonical semantic centers stay in the concept
  index.
- **Presets and controls.** _Architecture_, _Dependency_, _Concept_,
  _Behavior_, _History_ are named weight sets in `state.js`; the
  _Dimensions_ drawer edits the six weights directly and turns the preset
  into _custom_. _Freeze_ (Space) stops positions while pan, zoom, hover,
  and inspection continue; weights changed while frozen apply on resume.
  The status chip reads _Flowing_, _Settled_, or _Frozen_; once settled or
  frozen no simulation runs and the loop draws only on interaction.
- **Inspection.** Hover fades everything but the module, its package,
  its edges, and its co-change partners; under the Concept and Behavior
  presets modules sharing a concept and modules carrying behavior for one
  are lifted too, under History the co-change partners outrank the
  dependencies. Click pins the module and fills the inspector: identity,
  architecture, _Field influences_ (one bar per dimension from a
  single-node probe of the same force formulas at full heat, labelled as
  current field influence, plus the strongest attractor of each dimension
  with real counts: internal and cross-package edges, concept centers and
  the package they sit over, behavior centers, the top co-change pair with
  its shared commits and both conditionals), concepts by role, dependencies
  (cross-package and internal, both directions), history. The canvas draws
  dashed vectors from the selected module to those attractors. Package mode
  reads `packages/<id>.projection.json`; boundary mode reads the
  dependency-graph edge. A focused concept shows its kind, declaring file,
  canonical centers, packages, the state of its layout and behavior centers
  (drawn as dashed rings), participants by role, and buttons that switch to
  the Concept or Behavior preset with the focus kept; the boundaries
  between the packages it spans light up.

### V12.1 findings

Measured headless (bun over the real dataset; browser frame rates and
the visual judgement calls still need a person at the screen):

- **Bootstrap** is 4 requests and 707 KB; the package layout takes 7 ms,
  the first field is drawn on the next frame. A normal session that
  streams every shard and the concept index lands at 7.0 MB in 32
  requests, 3.6% of the dataset.
- **Settling** takes 351 fixed steps at about 3 ms each on 3,193 modules,
  162 frames with the adaptive three-then-two substeps (about 2.7 s at
  60 fps); a reheat after edges arrive adds around 280 steps. Once settled
  the loop draws only on interaction. Hover hit testing averages 0.26 ms
  via the simulation's own grid.
- **Package geography works from topology alone.** Layer bands plus
  dependency springs put `studio` and `chat` on top, `agents`, `db`, and
  `ui` in the middle, leaf tooling at the bottom, without hand placement.
- **Dependency pull is real but must be damped.** Undamped springs
  dragged `packages/db/src/client/index.ts` (34 studio dependents) 527 px
  out of its region; degree damping keeps every module within about 200
  px of its package while still leaning toward its consumers. The
  cross-package bridges are exactly the modules that drift.
- **Intra-package topology is the missing data.** Only 668 of 3,193
  modules have any module edge, and `@foundry/semantic-surface` has none
  at all, so inside a region only the directory anchor gives shape. The
  co-change pairs are the one intra-package relation the dataset holds
  (2,037 pairs, most inside a package) and are worth more than expected.
- **Concept focus is the strongest cross-package view.** `ModuleStore`
  lights 18 modules across packages with declared, behavior,
  implementation, representation, and usage rings; the concept index must
  be loaded before concepts appear in search, and the concept-to-module
  inversion needs every shard, so it is the last thing to become
  available.
- **Not layout inputs.** Fan-in and churn move radius only, within a
  bounded range, and were kept out of the forces on purpose: the one hub
  effect observed (the undamped `db` client above) came from edge count
  alone. Hotspots are a ring, not a size or colour.
- **Referenced packages** carry 0–2 modules each, so in _All_ scope they
  are labels with dashed halos, not fields.
- **Next.** V12.2 should try concept and behaviour forces as first-class
  weights, and the dataset should grow intra-package module edges before
  any layout work inside regions is worth tuning.

### V12.2 findings

Measured headless again (bun over the regenerated dataset, source-only
scope, 1,910 active modules); a browser was still not available in the
coding environment, so visual smoothness and legibility remain unmeasured.

- **The topology was already there.** The dependency cruise had always
  produced every module pair; only cross-boundary pairs were kept. Keeping
  the rest adds 6,422 intra-package edges to 1,233 cross-package ones and
  takes modules with any module edge from 668 to 2,855 of 3,075. 24 of 27
  analyzed packages have internal topology; `@foundry/semantic-surface`
  goes from 0 edges to 626, `@foundry/db` to 299, `@foundry/studio` to 957
  (plus 1,059 cross-package), `@foundry/ui` to 2,440. Edge shards total
  2.1 MB (largest `ui` at 690 KB, `studio` 580 KB), the coupling file
  1.0 MB for 2,162 pairs; generation cost is unchanged within noise
  (analysis dominates at 544 s against 474 s before, with tests running
  concurrently). 1,852 edges are type-only.
- **Cost.** A full-detail step is 2.3 ms (collision 1.3, dependency 0.65,
  history 0.15, package 0.1, concept and behavior 0.03 each over 12,458
  participations in 2,194 concept and 1,751 behavior tables); settling
  stays at 305–356 steps; hit testing 0.001 ms; two fresh runs under the
  Concept preset differ by exactly 0. A session that streams everything
  is 10 MB in 58 requests.
- **Hubs decide the tuning.** With 1/√degree damping the summed pull on
  `packages/db/src/models/index.ts` (131 edges, 53 cross-package) still
  dragged it 155 px from its anchor under every preset and the strongest
  coupling in the workspace (that file and `models/schema.ts`, 26 shared
  commits) could not close from 121 px. Mean-of-neighbours damping and the
  150 px extension cap fixed both: the hub sits 31 px from its anchor and
  the pair settles 26 px apart under History. Uncapped springs across
  300 px package gaps were the reason internal edges got _longer_ when
  topology arrived.
- **Directory anchors had to drop 6×** (gain 0.05 to 0.008) before
  internal edges shaped anything; at the V12.1 strength one anchor beat
  ten springs. With the weak prior, `studio`'s mean internal edge shrinks
  from 71 to 62 px in Architecture and 57 px in Dependency while its region
  radius holds; compact packages (`db`, `semantic-surface`) see their hubs
  lean toward consumers instead, so their mean edge grows a little (33 to
  41 px, 40 to 48 px) without leaving the region (max 2 px outside in
  Architecture).
- **Concept centers gather without collapsing.** `ModuleStore` (18
  modules across `modules`, `db`, `studio`) tightens from a 264 px mean
  radius in Architecture to 179 px under Concept and 158 px under Behavior;
  `WorkspaceStore` 108 to 53/49 px; `RuntimeObservationStore` 332 to
  240/223 px. The broadest Studio-consumed concept, `Db` (119 modules, 91
  of them Studio usage), moves only 191 to 154/143 px, and no module leaves
  its region by more than 82 px under Behavior: the usage weight, the
  two normalizations, and the containment floor hold Studio in place.
  No concept named `ArtifactStore` exists in this dataset's concept index,
  so it could not be compared.
- **Behavior earns its own dimension, narrowly.** Its centers differ from
  concept centers only where behavior is concentrated away from the
  declaration; the flagship movers under Behavior are Studio adapters and
  registries with 3–20 behavior roles (`roadmap-view-adapter.ts` 329 px,
  `runtime-registry.ts` 267 px) that head for the packages whose concepts
  they govern. Where every participant carries behavior the two forces
  coincide, so the dimension reads as a sharper Concept rather than a new
  geography.
- **Ablation** from Architecture: removing dependency moves 1,172 of 1,910
  modules by more than 8 px (max 72), concept 690 (max 80), behavior 654
  (max 75), history 350 (max 46). Every dimension contributes; dependency
  is the structural one, concept and behavior move fewer modules further,
  history is the quietest, as intended.
- **Most interesting displacement.** Studio's
  `planning/adapters/roadmap-view-adapter.ts`: one declared concept,
  twenty behavior roles, twenty representations, six module edges, no
  co-change pairs.
  Architecture keeps it in Studio's planning directory; Concept and
  Behavior pull it 330 px toward the `ui` roadmap contracts it governs,
  and the inspector names the concept centers and the package they sit
  over.
- **Most confusing displacement.** The same module moves 235 px under
  History although it has no co-change pair at all: the History preset
  also lowers the package weight (0.8 to 0.55), and with the anchor that
  weak its five cross-package dependencies win. Likewise
  `packages/ui/src/settings/primitives.tsx` moves 254 px under History
  with no concept participation; its nine co-change pairs are real (the
  strongest with a Studio settings page, 3 shared commits) but nothing on
  the canvas names them until the inspector's history section is opened.
  A preset changes several weights at once, so a move under one preset is
  not always a move for that preset's reason; keeping the package weight
  constant across presets is the first thing to try next.
- **Still missing.** Per-edge import sites (the cruise gives none), so
  every edge weighs the same; concept participation for `ArtifactStore`
  and similar concepts declared in packages whose modules carry no roles;
  representation as a dimension was not tried (its participants overlap
  usage almost entirely here); a browser measurement.
- **Next.** V12.3 should stay temporal: the field model takes positions
  and tables as plain arrays, so a second snapshot can be interpolated in
  without touching the forces once historical materialization exists.

### V12.3 findings

Generation was measured on this repository (monthly, `range 1y`, 9
checkpoints selected: Jan 31 – Aug 31 month-ends plus HEAD, Sep 4 2026);
the temporal explorer's own draw and solve costs are reported as harness
timings only — no browser ran in the coding environment, so frame rate
and the "does interpolation feel truthful" judgement still need a person
at the screen.

- **The workspace's whole life is legible.** Module count over the nine
  checkpoints climbs 30 → 27 → 762 → 1,056 → 1,250 → 2,400 → 3,684 →
  2,907 → 3,004 (dependencies 51 → 7,606), so the field genuinely grows
  from a seed to today. The Aug 1 peak (3,684 modules) then the Aug/Sep
  contraction to ~3,000 is real and matches the recent module
  control-plane collapse and artifact folding in the commit log — a
  structural event the scrubber shows as packages and edges disappearing,
  not as a number.
- **Identity survives real churn.** Of 6,242 tracked module lineages,
  1,418 changed path at least once and 767 moved across a directory
  boundary. Concrete examples the inspector follows unbroken:
  `apps/chat/src/hooks/useMesh.ts` → `use-chat-session.ts` (rename),
  `packages/agents/src/agents/drafter.ts` → `apps/chat/src/agent/drafter.ts`
  (cross-package move), `apps/cli/source/cli.tsx` → `apps/cli/src/cli.tsx`
  (directory move). Each is Git rename evidence, never a guess.
- **Packages are born and die on the timeline.** 14 packages present in an
  earlier checkpoint are gone at HEAD — `@foundry/engine`,
  `@foundry/experiments`, `@foundry/files`, `@foundry/foundry`,
  `@foundry/library`, `@foundry/database`, `@foundry/mcp`,
  `@foundry/orchestra` and its desktop/plugin siblings — and many more
  appear after the near-empty January tree. Package births and deaths show
  as regions fading in at their topological home or out into the
  peripheral historical band.
- **The current shape, for reference.** At HEAD `@foundry/ui` is 994
  modules, `@foundry/studio` 834, `@foundry/semantic-surface` 168,
  `@foundry/db` 125; the `studio → ui` boundary carries 143 module edges —
  the workspace's heaviest single seam, and one whose weight the scrubber
  shows thickening as Studio grew against UI.
- **Cost scales with tree size, and dominates everything else.** Total
  uncached run 439 s: timeline extraction 1.9 s over 1,646 first-parent
  commits, checkpoint selection/lineage/deltas/write all under 0.1 s
  combined, and analysis 437 s — i.e. history cost _is_ analysis cost.
  Per checkpoint the temporal analysis ran 1.2 s on the tiny January tree
  up to 116 s on the Aug 1 tree (worktree add + cleanup stayed in the tens
  to low hundreds of milliseconds). A second run with an unchanged policy
  re-analyzed nothing (9/9 cached); a policy change (adding one `exclude`)
  invalidated the fingerprint and re-ran all of them.
- **Storage is snapshot-dominated and lazy on the wire.** 20 files,
  16.6 MB: `manifest.json` 7 KB, `timeline.json` 972 KB, `entities.json`
  1.5 MB, snapshots 10 MB (20 KB on the January tree to 2.56 MB on Aug 1,
  HEAD 2.3 MB), deltas 4.1 MB (2.5 KB to 1.53 MB, largest across the June
  → Aug growth). Before the timeline is entered the explorer fetches only
  `manifest.json` (7 KB); `timeline.json` and `entities.json` load on
  entry, and each snapshot and delta loads on demand as the queue reaches
  it, so a scrub session pays for the checkpoints it visits, not the whole
  16.6 MB.
- **No analyzer incompatibilities surfaced in this window.** All 9
  checkpoints analyzed cleanly (0 failed, no coverage gaps): the current
  analyzer runs on eight months of this repo's history without complaint.
  The failure path is exercised only by the fixture test (an analyzer that
  throws on a specific historical file), which confirms one failed
  checkpoint is recorded, its neighbours' delta bridges the gap, and its
  worktree is still removed. A longer `range all` reaching the repository's
  earliest, differently-shaped commits is where real incompatibilities
  would first appear, and is the natural next probe.
- **Browser honesty.** Harness numbers only: layout solving is sliced
  across frames at a 12 ms budget with a 400-step settle cap per
  checkpoint, seeded HEAD-first so a persistent module keeps its place; the
  interpolated view reuses its typed arrays between frames. Whether that
  reads as smooth motion, and whether concept diffusion and behavior
  migration are visually meaningful, is unmeasured here and is the
  outstanding human-evaluation step (spec §191).
- **Recommended V12.4 direction.** Temporal exploration makes the case for
  coordinated views _around_ the field — pattern overlays, boundary
  exploration, concept trajectories, and architectural-event views —
  without turning the interface into a metrics dashboard (spec §199).
- **Incremental semantics may deserve its own version.** The 437 s
  analysis cost, entirely re-paid whenever the fingerprint changes, is the
  clearest argument for incremental semantic recomputation. It was
  deliberately not solved here (spec §200); the checkpoint cache blunts
  reruns, but a policy change still re-analyzes every checkpoint.

### V12.4 findings

- **The boundary microscope is the standout.** Selecting `studio → ui` — the
  heaviest seam at HEAD, 143 module edges, 389 import sites, 680 references —
  fades the field to exactly its crossing modules and answers "what travels
  here" in one panel: 112 concepts cross it, almost all as representation
  (111) with a little behaviour (10) and conversion (10) and no
  implementation, and the analyzer already tags it
  `high-volume-channel · high-concept-diversity · consumption-channel ·
historically-reinforced`. High volume and high diversity are shown as
  separate facts, never fused into one number.
- **Direction stays distinct.** `ui → studio` does not exist as a boundary
  even though `studio → ui` does; the microscope never conflates the two.
- **The edge-volume sparkline reads as real history.** `studio → ui` is
  absent through the first five checkpoints, appears between 2026-05-27 and
  2026-06-30 at 180 edges, dips to 123 on 2026-08-01, and settles at 143 —
  the seam being born and then consolidating. Scrubbed before it exists the
  boundary panel says "not present at this checkpoint" rather than borrowing
  the HEAD figure.
- **Concept-role trajectories expose genuine splits.** `ModuleStore`
  (`packages/modules/src/store/contract.ts`) holds its semantic centre in
  `@foundry/modules` but its behaviour, representation, and usage centres in
  `@foundry/studio` — a real ownership/behaviour separation the distinct
  role markers make visible at a glance. `WorkspaceStore` is self-contained
  in `@foundry/workspaces`; `RuntimeObservationStore` is declared in
  `@foundry/environments` but used from `@foundry/studio`. Distributed
  centres (implementation is a package list) keep every package; the single
  drawn point is labelled a display centroid, not a fact.
- **A store concept can be absent.** `ArtifactStore` is not in this
  generation's concept index, so it has no HEAD centres or trajectory; the
  panel says so rather than inventing them — the same honesty the temporal
  inspectors already apply to missing entities.
- **Pattern overlays reveal repeated geometry, once.** The 99 pattern
  instances group as boundary (35), package-pair (27), concept (17),
  package-role (17), evolutionary (3). The single
  `parallel-contract-implementations` instance spans five packages
  (`db`, `environments`, `modules`, `workflows`, `workspaces`) and lighting
  it shows the same store-contract shape repeated across them. Patterns
  highlight but never pull, so the field a pattern explains is the same field
  every other lens shows.
- **Events became a workflow.** The delta rows are clickable: a rename or
  move (`GIT EVENT`) or a concept-centre change (`DERIVED DELTA`, measured
  between two checkpoints) snaps the instant, applies the fitting lens, and
  selects the entity — turning "something changed here" into a coordinated
  investigation in one click. The exact-vs-interval distinction is carried
  on every row so an interval change is never read as a pinpoint commit.
- **Provenance discipline held.** Everything semantic beyond edge volume and
  concept centres — concept load by role, severance, patterns, V8 reviews —
  is HEAD-only, and every panel labels its source (`CURRENT ANALYSIS`,
  `MEASURED CHECKPOINT`, `INTERPOLATED VIEW`, `GIT EVENT`, `DERIVED DELTA`).
  Selecting a current-only pattern while scrubbed says so explicitly.
- **Cost stayed at presentation prices.** No new dataset was generated for
  V12.4; the coordination reads the existing lite projections
  (`directions.json` 108 KB for boundary roles, `patterns.json` 165 KB for
  the pattern browser) plus the module edges already streamed at bootstrap.
  Boundary participants, pattern participants, and concept trajectories are
  each prepared once per selection, not per frame. First render is unchanged.
- **Browser honesty.** No browser ran in this environment, so smoothness and
  legibility are unmeasured; the coordination logic is covered by the
  temporal and coordination unit tests, and the figures above are dataset
  facts, not observed frame rates.
- **Recommended V12.5 direction.** V12.4 shows the experience leans hardest
  on the lite projections and the compact history snapshots, not the 41 MB
  `workspace.json`; that is the argument for incremental materialization —
  recomputing only the affected packages, modules, relationships, and
  checkpoints — which V12.4 deliberately did not attempt.

### V12.5 findings

Measured on this repository (27 units, 3,036 modules, 5,695 concepts,
121 artifacts, 199.9 MB), two workers, one UTC day, 2026-09-05.

| Build                                                | Analyzed | Unchanged | Reused | Artifacts written / reused | Time   |
| ---------------------------------------------------- | -------- | --------- | ------ | -------------------------- | ------ |
| full, cold cache                                     | 27       | 0         | 0      | 43 / 78                    | 568.9s |
| incremental, edits in `tooling/semantic-surface/src` | 27       | 5         | 0      | 27 / 94                    | 555.0s |
| incremental, formatting-only edits                   | 27       | 27        | 0      | 1 / 120                    | 562.4s |
| incremental, no change                               | 0        | 0         | 27     | 1 / 120                    | 6.2s   |
| incremental, one interface added to `@foundry/db`    | 27       | 0         | 0      | 37 / 84                    | 547.1s |
| full of the same state (equivalence check)           | 27       | 0         | 0      | 18 / 103                   | 557.0s |

- **The package analyzer is a whole-workspace function.** The audit found
  five reads that reach past a package: the shared TypeScript project
  (external usage, concept evidence), the whole-workspace cruise (gravity
  reach, change radius, module existence), concept overlap's name and
  property index over every declaration in the workspace, churn
  percentiles ranked against every tracked file's history, and the alias
  table from every manifest. The db benchmark confirmed it empirically:
  one added interface changed all 27 canonical reports, including packages
  with no dependency path to db at all. A closure-based invalidation rule
  (db's transitive neighbourhood is 12 of 27 packages) would therefore
  have been unsound; the fingerprint hashes the whole workspace instead.
- **What incremental buys today.** A no-change rebuild takes 6.2s instead
  of 568.9s: 5.5s of fingerprinting (one cruise, one `git log`, hashing
  about 3,100 files), 0.3s of cache reads, and about 0.3s of workspace
  recomputation and materialization; 120 of 121 artifacts are hardlinked
  from the previous dataset and only the manifest is rewritten. Any source,
  manifest, or commit change costs a full analysis again; the payoff there
  is the `unchanged` count and artifact reuse (formatting-only edits: 27
  reports reanalyzed, 27 canonically equal, 1 file written), the invalidation
  explanation, and the certainty that nothing stale is served.
- **Equivalence holds on the real repository.** The incremental dataset
  after the db change and a clean full build of the same tree compare
  equivalent across all 121 artifacts under `compareSemanticsDatasets`;
  the fixture suite asserts the same after every scenario (no change,
  source, comment-only, manifest, config, clock, package add, package
  remove, corrupt / missing / old-schema cache, worker counts 1, 2, and 4,
  and a seven-step edit sequence).
- **Where the analysis time goes.** `@foundry/studio` (120.7s),
  `@foundry/semantic-surface` (86.7s), and `@foundry/ui` dominate; the rest
  take 12 to 45s each. Fingerprinting, cache reads, workspace recomputation,
  comparison, serialization, and the swap together stay under 7s, so after
  V12.5 the only bottleneck is package analysis itself.
- **Coarse spots, by design.** (1) Every source edit reanalyzes every
  package, because the analyzer reads every package. (2) The first build
  after a UTC day boundary reanalyzes everything: churn windows and
  `daysSinceLastChange` are clock-relative, so the clock is a fingerprint
  component. (3) An explorer edit reanalyzes everything, because this
  package's tests import the explorer and it is therefore part of the
  module graph. (4) Workspace intelligence, the concept index, and the
  projections are recomputed whole; at about 0.3s that is not worth
  partial repair.
- **History cache.** The V12.3 key already excluded projection and
  dataset schemas; V12.5 makes that explicit through the stage graph,
  validates cached snapshots before reuse, and writes them atomically.
  With the new key the V12.3 entries are orphans and the first history run
  reanalyzes every checkpoint once.
- **The next question.** The measurements say V12's requirement is met
  for the unchanged and the non-source case and not for the source-edit
  case, and that the obstacle is the analyzer's shape, not the cache.
  Per-package reuse needs the analyzer partitioned into package-local
  facts (symbols, internal edges, local complexity, concept inventory)
  and workspace-derived facts (external usage, gravity reach, change
  radius, overlap, churn ranks) computed once from the local facts, the
  way V9 already derives workspace intelligence. That is an analyzer
  change, deliberately out of V12.5's scope, and the only path to
  "one package changed, one package analyzed".

## How it works

Each package is first analyzed alone (V12.6): its own sources go into an
in-memory ts-morph project with only the package's own aliases, which
yields the package-local report. Then one ts-morph project is built over
all workspace sources (excluding `node_modules`, `dist`, `build`, generated
output, `.d.ts` files, and any `test/fixtures/` below the analyzed root,
whose manifests would otherwise register phantom packages) and every
workspace-derived fact is computed from it in one pass.
Workspace package `exports` are mapped to source `paths` aliases so consumers
resolve to source declarations rather than built `dist` types. Exported-ness
resolves through barrels and re-export aliases back to the original
declaration, so a barreled symbol counts once. External usage comes from
one identifier walk over the whole program that resolves alias chains back
to their declarations, rather than a language-service reference search per
symbol.

Dependency context comes from dependency-cruiser's programmatic API cruising
the same workspace sources with the same alias map (written to a temporary
tsconfig when none is supplied, since the resolution plugin reads it from
disk). Its module-level edges are collapsed onto package boundaries; symbol
attribution for incoming edges reuses the per-consumer reference data from the
semantic pass rather than rediscovering it.

## Analysis policy

All tuning — shape-signal thresholds, opportunity eligibility gates, evidence
weights, report display caps — lives in `src/config.ts` as one typed
`ANALYSIS_CONFIG` object. These are internal defaults; there is intentionally
no user-facing config loader, CLI flag, or config file yet. Measurements
(consumer counts, shares, distributions) remain deterministic facts —
configuration only controls how they are interpreted into signals, gates,
confidence values, and presentation. Detectors accept an optional config
parameter (defaulting to `ANALYSIS_CONFIG`) for testing.
`ANALYSIS_POLICY_VERSION` bumps whenever a default changes, so reports from
different policies can be told apart.

Policy 24: a file belongs to the nearest ancestor that is a workspace package
(one matched by the root manifest's `workspaces` patterns). A manifest below
that, such as a skill nested inside a plugin, is not a boundary; its files
count for the enclosing package in churn, coupling, concepts, and ownership,
the same package whose local analysis already owns them. Earlier policies
stopped at the nearest manifest, which registered such directories as
phantom, never-analyzed packages.

Gates are tuned against the whole workspace, not sampled packages. Two
dev-only scripts (not part of the analyzer's runtime) keep that honest:
`bun run tune:sweep <outDir> [--now <iso>] [--only a,b]` analyzes every
workspace package with TypeScript sources and writes one report per
package; `bun run tune:report <sweepDir> [--git]` prints, for every
numeric gate, the repository-wide distribution of the metric it reads, how
many observations pass, how many sit within a small neighborhood of the
cutoff (brittleness), and — with `--git` — the raw commit and pair-support
distributions behind the shared history filter. The layering it checks:
raw facts → descriptive profiles → cross-signal pressure → evolutionary
evidence → static × history. Each layer is expected to add meaning, not
restate the previous one.

## Limitations

- Only named top-level declarations are inventoried; class/interface members,
  locals, and default-exported anonymous values are not counted.
- Dynamic usage is invisible: string-keyed access, `require(variable)`,
  reflection, DI-by-name, and consumers outside the TypeScript program.
- `externalReferences` excludes import/export specifiers; those are counted
  separately as `externalImportSites`.
- Access (public/deep) is derived from import specifiers; usage reached only
  through a namespace import falls back to how the consuming file imports the
  boundary, defaulting to `public` when no import is classifiable.
- Wildcard `exports` subpaths (`./*`) count as public because the package
  declares them; only the "import"/"default" conditions resolving to `.ts`
  sources are aliased.
- Unclassifiable reference roles are reported as `unknown`, not guessed.
- A cruiser edge with no symbol usage (e.g. a side-effect import) is kept as a
  consumer with zero counts; its namespace is `value` unless every import
  proved type-only.
- A consumer reaching a symbol only through another package's re-export keeps
  its symbol usage attributed to the owning package but may have no direct
  module edge to it (`moduleEdges: []`); the re-exporting package shows up
  separately through its `re-export` sites. Access paths are not modeled
  further.
- Tooling config files (`*.config.ts` and variants, e.g. `eslint.config.ts`,
  `vitest.config.ts`) are excluded from both the semantic and dependency
  passes: their symbols, references, and imports do not count.
- Test files count as modules too (matching the semantic pass): a package's
  own tests contribute outgoing edges, and another package's tests importing
  the target count it as a consumer.
- External npm packages are excluded from dependency context entirely.
- Behavioral locality (V7.4) reads V7.3 participants, so a class seed's own
  members are not behavior, and structurally conforming object literals
  and factories surface as contract or conversion behavior, never as
  implementations. Module distances run through package barrels, so in a
  barrel-first workspace nearly every foreign module sits at distance 2–3
  and the distributed shape is decided mainly by module count. A module
  whose imports resolve outside the owned graph can show no path to the
  seed (`disconnectedModules`) without being scattered.
- Re-centering (V8.0) reads boundary interactions at module level, so
  `boundary-friction` says the concept's modules take part in a heavy
  boundary, not that the concept's own symbols carry the traffic. Anchors
  are matched by package name against the configured list; a foreign
  package anchored by path is not recognized. Behavior kinds come from the
  evidence inside a participant's line range; a converter V7.3 never
  attributed has no range and reads as `conversion` by its tag alone.
- Mis-centering (V8.1) cannot see structural conformance: a factory in an
  adapter package returning an interface reads as governing behavior, so
  a contract without any `implements` clause can attract external gravity
  toward its adapters (flagged `unobserved-conformance`, never
  suppressed). No composition-root or system-boundary role exists, so
  construction-heavy wiring packages are not discounted. The composite
  gravity has no per-package dependency leg because import sites are only
  counted across boundaries.
- Scenarios (V8.2) inherit those gaps: a semantic rehome toward adapter
  factories is emitted `constrained`/`weak`, not omitted, and a wiring
  package is only cautioned, never discounted. `persistence` is assigned
  only to a projection-shaped partner that owns its converters, so a
  stored representation reached through conversion-only pairs reads as
  `representation` + `conversion`. A `public-contract` constraint applies
  to every package-public concept consumed outside its home, which is
  most of them, so semantic rehomes are rarely `plausible`. Scenarios
  describe placements, not costs: no delta, files, imports, or ranking.
- Impact (V8.3) simulates at package granularity with module-level edge
  facts. Target modules, consumer migration, re-export compatibility,
  composition-root effects, structural conformance, and the exclusivity of
  foreign-to-foreign edges are outside its evidence and are reported as
  uncertainties rather than guessed. Eliminations are rare by design: an
  edge goes only when every import site on it names a concept module, so
  most real consequences are reductions where the concept stops crossing
  an edge that unrelated traffic keeps. Shape, module count, and traversal
  distance after a move are unknown. Nothing is ranked or costed.
- Review (V8.4) grades only what V8.3 measured. A partially simulated
  scenario is `insufficient-evidence` even when its certain gains are
  large, because the unmeasured edge could reverse the comparison; real
  consequences are mostly conditional boundary reductions, so many
  findings end as `insufficient-evidence` rather than a verdict. Dominance
  is Pareto over independent dimensions, never a weighted preference, and
  a `credible-alternative` disposition is a review state, not an
  instruction. Findings are not aggregated into repository patterns.
- Workspace (V9.0) is ingestion only: it infers no repository-wide pattern,
  center, cluster, or score, and builds no visualization model. Facts that
  stay target-scoped are kept as perspectives or per-package entries rather
  than forced canonical: boundary import-site counts (source and destination
  measure different populations), overlap candidates (generated from one
  side's seeds, so a pair may be observed once), churn under differing
  history windows, change radius, and evolutionary pressure. Coverage is
  only as complete as the reports supplied.
- Workspace graph (V9.1) is structural only: no concept motif, no
  aggregation of V8 findings, no semantic cluster, no layout, and no
  importance score. Package reports persist only boundary-crossing module
  edges, so module-level depth, reach, and layers describe cross-package
  topology; internal package structure stays in each package's own gravity
  section. Betweenness on the real package graph is small and flat, so hub
  and bridge remain ranked lists rather than roles, and articulation
  packages and weak bridges include those caused by pendant leaves.
- Workspace concepts (V9.2) place concepts and count recurrence only: no
  repository-wide package role, no concept cluster, no V8 pattern, no
  layout, no score. Roles come from what package reports already record,
  so `implements` clauses bound implementation and structural conformance
  stays unobserved; contract families are package-level because
  implementation names are not ingested; `persistence` is not a role because
  no ingested fact supports it; concept-to-boundary reference counts are
  not available, so boundary loads are distinct concept counts beside
  import volume. Under partial coverage every path, span, and load is a
  lower bound.
- Workspace patterns (V9.3) describe recurrence, never quality: no
  recommendation, no re-centering scenario, no cluster, no layout, no score.
  `integration-center` is not emitted because per-concept wiring evidence
  is not ingested; `bridge` is not emitted because real package betweenness
  is flat; a pair-level `implementation-channel` needs several implemented
  concepts on one pair, which the real sweep (one per pair) does not reach,
  so convergence shows as an `implementation-center` role instead. Review
  overlays are sparse (19 reviewed concepts), so direction patterns that
  depend on them are mostly absent rather than resolved, and the competing
  center is the finding's strongest observed center, a definitional choice
  the review patterns name.
- Workspace projections (V9.4) expose only what the canonical model holds:
  module-level traversal distances, the reference halo, the change
  surface, and behavior by function/method/constructor from the
  package-level concept report have no package-level home and are not
  projected; ownership candidate share evidence is not ingested, so the
  usage share comes from the V7.1 distribution primary and the largest
  representation holder is arithmetic over per-package counts. The entity
  index is built for every canonical concept, so a workspace of thousands
  of concepts has an index of the same size; serialization of the index is
  optional. `--graph` and `--matrix` are workspace-wide by design; the only
  bounded graph is the concept graph.
- Architectural operators (V11.0) describe intent, not edits: no operator
  is realized as symbol moves, import rewrites, or file changes.
  Compositions (V11.2) combine only the operators they are given: no
  scenario is selected, no operator is generated from a pattern, and
  sharing on real scenario operators is rare because each scenario names
  its own concept; only a surface gap can be resolved by a companion
  operator, and with the current catalog only `rehome-concept` itself
  emits the forwarding action that resolves it, so real data resolves
  none. `preserve-boundary` carries a `public-contract` preservation that
  conflicts with any internalization in that package, and `move` still has
  no decomposition, so a composition holding one is `unsupported`.
  Decompositions (V11.1) stop at
  structural actions: every rehome is `partial` because no target module is
  selected, `rehome-concept` cannot say how consumers reach the new home
  unless the operator preserves the old import path, `redirect-dependency`
  redirects a whole boundary without concept scope, and actions carry no
  member modules even where V8.3 recorded them. Scenario-derived operators need the
  package reports because the workspace digests V8 scenarios without their
  placements and impact vectors. Manual `rehome-behavior` reads "source
  behavior in the `from` package" from workspace locality, not V8's
  governing-behavior count, which the workspace does not retain. The
  catalog cannot express `split-responsibility` or
  `formalize-representation-boundary`, and `preserve-current` yields no
  instance.
- Opportunities are derived for the analyzed package only. Multi-target
  analysis (`analyzeWorkspaceSurfaces`, V12.6) shares one program, cruise,
  history, reference index, and concept sweep across targets, but each
  report still reasons about its own package.
- Workspace derivation (V12.6) is all-or-nothing: any change to a
  workspace input (a source in any package, a commit, the clock, the
  configuration) re-derives every assembled report, even where the fresh
  report then proves canonically unchanged. Package-local analysis is the
  only per-package incremental unit. The union property-order case above
  (`Float32Array | ArrayBuffer | Buffer`) shows that a few checker results
  depend on what the program resolved earlier; the shared program is now
  the one place they are resolved, so they are stable across builds but
  not identical to the old per-package program.
- Opportunities are descriptive. The tool never edits exports, moves files,
  or rewrites imports — a fold recommendation means "this package boundary
  may be unnecessary", never "combine everything into one file".
