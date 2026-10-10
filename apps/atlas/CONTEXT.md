# Atlas

Atlas scans a TypeScript workspace into a dataset that its viewer, its CLI,
and its library read. These are the terms the library, the dataset, and the
CLI expose.

## Language

### What is scanned

**Workspace**:
A directory of packages that Atlas scans as one, named by its root path.
_Avoid_: repository, project, monorepo

**Unit**:
A directory found by discovery as a candidate package, before it is
analyzed.
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

**Internals**:
One package's internal structure: topology, symbol locality,
responsibilities, primitive conventions, rewiring, and the review.
_Avoid_: internal survey, in-depth analysis

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

### What a scan saves

**Scan**:
One run of the analyses over a workspace or one of its packages; a
workspace scan ends in a saved dataset.
_Avoid_: survey, refresh, build

**Dataset**:
The files a scan saves: among them the manifest, the workspace report,
package reports, and projections, plus internals and history when the scan
includes them. The dataset is the product.
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

**Workspace report**:
The dataset's workspace-level analysis, `output/workspace.json`.
_Avoid_: workspace record

**Package report**:
The dataset's analysis of one package, `output/packages/<name>.json`, where
`<name>` is the package name with `/` encoded (`@s/a` is `@s__a`).
_Avoid_: surface report

**Projection**:
A shape of the reports that no renderer owns: the workspace's in
`output/projections/`, each package's in
`output/packages/<name>.projection.json`, with `<name>` encoded as for a
package report.

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
dataset.
_Avoid_: web assets, web root, app, explorer, client
