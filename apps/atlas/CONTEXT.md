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
A unit that Atlas analyzes. Its id in the dataset is its `package.json`
name.
_Avoid_: territory, island (viewer words), module

**Internals**:
One package's internal structure: topology, symbol locality,
responsibilities, primitive conventions, rewiring, and the review.
_Avoid_: internal survey, in-depth analysis

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
The files a scan saves: the manifest, the workspace report, package
reports, projections, and package manifests, plus internals and history
when the scan includes them. The dataset is the product.
_Avoid_: output (that is its directory), semantics, survey (the viewer's
word)

**Output**:
The directory a dataset is saved in, `<state directory>/output`.
_Avoid_: dataset (that is its contents)

**Manifest**:
The dataset's index: its schema version, every package with its status,
and the files it holds. Not the dataset's `manifests/`, which holds a copy
of each package's `package.json`.

**Workspace report**:
The dataset's workspace-level analysis, `output/workspace.json`.
_Avoid_: workspace record

### Where a scan is kept

**State root**:
The directory that holds every workspace's state.

**State directory**:
One workspace's directory under the state root, holding its output and its
cache.

**Workspace record**:
The state directory's `workspace.json`, naming the workspace it belongs to.
_Avoid_: workspace report
