# Atlas

Atlas scans a TypeScript workspace into a dataset that its viewer, its CLI,
and its library read. These are the terms the library, the dataset, and the
CLI expose.

## Language

### What is scanned

**Workspace**:
A directory of packages that Atlas scans as one, named by its root path.
_Avoid_: repository, project, monorepo

**Workspace declaration**:
The package patterns the workspace's package manager reads, from
`pnpm-workspace.yaml`, or else `package.json#workspaces`. Discovery and
import analysis both follow it.
_Avoid_: workspaces, roots

**Package pattern**:
A glob in the workspace declaration that matches directories that may be
packages, such as `apps/*` or `docs`.
_Avoid_: root, pattern alone

**Unit**:
A directory a package pattern matches: a candidate package. Discovery skips
a unit with a reason the manifest records; every other unit is analyzed as a
package.
_Avoid_: target, candidate

**Package**:
A unit that Atlas analyzed or tried to; the manifest lists each with its
status. Its id in the dataset is its `package.json` name.
_Avoid_: territory, island (viewer words), module

**Declared dependencies**:
What a package's `package.json` names under `dependencies`,
`devDependencies`, `peerDependencies`, and `optionalDependencies`, each name
with its range as written. The manifest holds them for each package.
_Avoid_: dependencies alone (that is the import graph), package manifest

**Dependency layer**:
A package's depth in the package dependency graph, 0 for a package that
depends on no other.

**Internals**:
One package's internal structure: topology, symbol locality,
responsibilities, primitive conventions, rewiring, and the review.
_Avoid_: internal survey, in-depth analysis

**Fan-in**:
How many modules import a module, which takes a qualifier, since three
counts go by the name. *Internal fan-in* is the topology's: the distinct
source modules of the same package that import it; imports from other
packages and from tests do not count. *Gravity fan-in* counts the
import edges of the workspace module graph that end at it, across packages;
it equals the viewer's *incoming imports*. The two are different measures,
and neither contains the other: the module graph can miss imports the
topology resolves, such as path aliases.
_Avoid_: fan-in unqualified where two of them could be meant

**High fan-in**:
A topology role: a module whose internal fan-in is at least the package's
high fan-in cutoff. The cutoff is the topology's, saved with the internals:
the larger of a minimum and a percentile among the package's modules that
have any dependent. The workspace graph's `highFanInModules` is a different
measure: the modules ranked by gravity fan-in across the workspace.
_Avoid_: hub, prominent, most-imported

**File role**:
What a file does in its package's architecture, from its internals, first
match wins: `junction` (a composition root), `mixed` (its exported symbols
serve more than one scope), `commons` (they serve no single responsibility
but are consumed across responsibilities or package-wide), or `unknown`
(every symbol's scope is unplaced or unclear). The `file-roles` lens saves
it, beside each module's internal fan-in and high fan-in.
_Avoid_: role alone, architecture kind, `unknown` for a responsibility's
`unresolved` belonging

**Evolution**:
What every scan reads from the Git log, when there is one: churn, hotspots,
change coupling, and change radius, in the workspace report and each file's
record.
_Avoid_: history (that is checkpoints)

**History**:
Past checkpoints of the workspace, read from Git; part of the dataset when a
scan asks for it.

**Checkpoint**:
A past commit of the workspace that history analyzes.

**Snapshot**:
One checkpoint's saved analysis.

**Configuration**:
What a workspace declares to Atlas in its configuration directory,
`.foundry/atlas/`: exclusions, history settings, and domains. Analysis thresholds are
not configuration; they are built in.
_Avoid_: config, semantics config, analysis config

**Configuration directory**:
`.foundry/atlas/` at the workspace root; each configuration file in it
declares part of the configuration, and a key is declared in one file only.
_Avoid_: source, authoring folder, state directory

**Configuration file**:
A file in the configuration directory that default-exports part of the
configuration; `_`-prefixed helpers are not configuration files.
_Avoid_: module, source

**Setting**:
One entry of the configuration, such as `history.range`; a top-level
setting is a key.
_Avoid_: option (that is the command line)

### The workspace's own model

**Place**:
A package, folder, file, or top-level symbol, addressed by
workspace-relative path or `path#name`.

**Domain**:
A named part of the workspace's own mental model: a set of facets, and of
domains nested inside it, that may span packages. A place in a nested
domain is in its parent too. Its name is its id, unique across the
workspace. A domain labels observations and never hides one.
_Avoid_: concept (the scan's observation), anchor (AnalysisConfig's built-in
pin), domain behavior, bounded context, area

**Facet**:
A reference by which a domain claims places, a path or `path#name`; it may
match none.
_Avoid_: member, path, scope, region, anchor (AnalysisConfig's built-in pin)

### What a scan saves

**Scan**:
One run of the analyses over a workspace or one of its packages; a
workspace scan ends in a saved dataset.
_Avoid_: survey, refresh, build

**Dataset**:
The files a scan saves: among them the manifest, the workspace report,
package reports, projections, and lens outputs, plus internals and history
when the scan includes them. The dataset is the product.
_Avoid_: output (that is its directory), semantics, survey (the viewer's
word)

**Output**:
The directory a dataset is saved in, `<state directory>/output`.
_Avoid_: dataset (that is its contents)

**Manifest**:
The dataset's index: its schema version, every package with its status and
declared dependencies, and where the dataset's files are. Not
`history/manifest.json`, which indexes history, nor
`projections/manifest.json`, which describes the projections, nor a
package's `package.json`.

**History manifest**:
History's index, `output/history/manifest.json`: its own schema version,
the checkpoints, and where history's files are. Published after the rest of
the dataset, and present only when the scan includes history.
_Avoid_: manifest alone (that is the dataset's)

**Workspace report**:
The dataset's workspace-level analysis, `output/workspace.json`.
_Avoid_: workspace record

**Package report**:
The dataset's analysis of one package, `output/packages/<name>.json`, where
`<name>` is the package name with `/` encoded (`@s/a` is `@s__a`).
_Avoid_: surface report

**Projection**:
A shape of the reports that no renderer owns; it copies and never infers.
The workspace's are in `output/projections/`, each package's in
`output/packages/<name>.projection.json`, with `<name>` encoded as for a
package report.

**Lens**:
A read-only derivation over the dataset, plus the settings it names, that
produces a view: labels, groupings, and measures. A scan runs every lens
and saves each one's output as `output/lenses/<id>.json`, with the lens's
own schema version. Unlike a projection, which copies and never infers, a
lens may derive, rank, and label.
_Avoid_: projection (that copies and never infers), map layer (the viewer's
Belonging / Files control)

### Where a scan is kept

**State root**:
The directory that holds every workspace's state.

**State directory**:
One workspace's directory under the state root, named by the workspace's
id, holding its workspace record, its output, and its cache.

**Workspace id**:
The short digest of a workspace's resolved root that names its state
directory.

**Cache**:
Per-package results and the workspace fingerprint that let the next scan
reuse work, kept in `<state directory>/cache`.

**Workspace record**:
The state directory's `workspace.json`: which workspace it belongs to and
when a scan last saved its dataset.
_Avoid_: workspace report

### What reads a dataset

**Viewer**:
What a browser loads to show a dataset; `serve` hosts it beside the
dataset, and `atlas export` copies it into a static viewer.
_Avoid_: web assets, web root, app, explorer, client

**Static viewer**:
The viewer and a copy of one dataset, written as static files by
`atlas export`.
_Avoid_: export (the command; also a symbol a module exposes), site,
example
