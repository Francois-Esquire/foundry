# Many workspaces in one atlas

Maintainer note, excluded from the Blume site. Dated 2026-10-09. What it
takes to draw several workspaces in one visualization. The questions were
decided on 2026-10-10 (5.0), by the orchestrator acting for the maintainer;
see [Decisions](#decisions).

## What assumes one workspace today

- **The CLI takes one path.** `parseArguments` rejects a second positional.
- **State is per path.** `lib/state.ts` names each state directory by the
  workspace id, the first 12 hex digits of the resolved root's SHA-256, as
  Marbles does: `<state>/<id>/`, with its own `output/` and `cache/`. Two
  workspaces never share a dataset, which is right for scanning and is the
  thing a merged view has to work around.
- **Identity is a package name.** Package ids are `package.json` names, and
  file ids hang off them. Two workspaces can both contain `@acme/utils`, and
  forks or checkouts of one repository will contain the same names on
  purpose.
- **The server serves one dataset.** `/data/<path>` maps to one `output/`.
- **The viewer loads one manifest.** `./data/` lives in one place,
  `DATA_ROOT` in `web/dataset.ts`, since effort 1.5; island layout, latitude, and
  attraction come from one graph; positions and pigment hash the package id
  alone.
- **State can be listed, but nothing lists it yet.** Since effort 1.3,
  `scan` and `scan.workspace` write a workspace record,
  `<state>/<id>/workspace.json` (root, id, and, once a dataset is saved,
  Atlas version and `lastScannedAt`), as Marbles does for `marbles status`.
  Nothing reads the records yet. A collection does not need them: it is
  named by its paths each time and keeps no state of its own (decision 5).
- **`@foundry/workspaces` is not the answer.** It is a live file catalog
  with watchers, not a registry of scanned repositories.
- **Cross-workspace relationships are not recorded.** An import of a
  package outside the workspace is external. The manifest records each
  package's declared dependencies (`packages[].declaredDependencies`),
  which is enough to match a dependency in one workspace to a package in
  another, at package level; matching is by name only.
- **History is one Git repository.** Checkpoints are commits in one log.

## Shapes

1. **One combined scan.** Treat several roots as one program and analyze
   them together. The compiler resolves imports across workspaces, so
   cross-workspace edges are as precise as in-workspace ones. Costs: one
   program over several tsconfig setups and package managers, one cache for
   all of them (any change re-derives everything), and name collisions
   inside one program.
2. **Separate scans, merged in the viewer.** Each workspace keeps its own
   scan, state, and cache, unchanged. A collection lists the workspaces; the
   server serves each dataset under its own prefix; the viewer loads them
   all and links them where a declared dependency in one names a package in
   another. Cross-workspace edges are package-level only, unless module
   imports of external packages start being recorded per file.
3. **Separate scans, merged into a collection dataset.** As 2, but a step
   after the scans writes a small collection dataset: the workspaces, the
   qualified ids, and the cross-workspace edges. The viewer reads one
   collection manifest and lazily loads each workspace's dataset. Other
   tools reading `output/` get the cross-workspace edges too.

Recommendation: 3. It keeps scanning and caching per workspace, which is
where the cost is, and puts the merge in the dataset rather than in the
viewer, in line with the dataset-first principle in [`_api.md`](./_api.md).

## What it changes elsewhere

- **API.** `atlas scan a b`, `atlas serve a b`, and `atlas a b` work on a
  collection. A collection is named by its paths each time, with no name
  and no file of its own (decision 5). Ids become qualified,
  `<workspace>:<package>`, in the collection and in the viewer, and stay
  bare inside a single workspace's dataset.
- **Viewer.** Either one archipelago where each workspace is a region with
  its own sea or coastline, laid out by the merged graph, or one chart per
  workspace side by side. See [`_viewer.md`](./_viewer.md). Decided: one
  archipelago per workspace, side by side (decision 6).
- **History.** Separate repositories have separate timelines. Aligning them
  by date is possible; aligning them by commit is not.

## Questions

Answered in [Decisions](#decisions): 1 by decision 1, 2 by 2, 3 by 3,
and 4 by 4.

1. **What is the use case?** A product split across several repositories
   that depend on each other, where cross-workspace edges are the point; or
   unrelated projects seen side by side, where they barely matter; or
   checkouts and forks of one repository, where the same names are expected
   and the interest is in the difference.
2. **Which workspaces first?** A concrete set to build against, such as
   Foundry and the repositories that consume its packages.
3. **Same name in two workspaces: one package or two?** For forks and
   checkouts, linking them is useful. For unrelated repositories, it is
   wrong. Probably a collection-level setting, defaulting to two.
4. **Module-level cross edges in 0.1?** Package level comes from the
   declared dependencies for free. File level needs the scan to record, per
   file, which external package specifiers it imports.

## Decisions

Decided 2026-10-10 (5.0), by the orchestrator acting for the maintainer,
who could not be asked.

1. **Use case: a product split across repositories that depend on each
   other.** The edges between workspaces are the point. Unrelated projects
   side by side work too, as the degenerate case with no edges. Forks and
   checkouts of one repository are read as unrelated workspaces that happen
   to share names (decision 3).
2. **First set: test fixtures.** Two small workspaces, `platform` and
   `product`, in which a package of one declares a dependency on a package
   of the other, and both hold a package of the same name. No repository
   under `~/code` depends on a `@foundry/*` package from another
   repository: every such range is `workspace:*`. The Agents checkout
   shares eleven package names with Foundry (`@foundry/core`, `lib`,
   `agents`, `tsconfig`, and others) and resolves each inside itself, so
   Foundry and Agents together are the manual check of decision 3 and of
   the case with no edges, not of the edges themselves.
3. **Same name in two workspaces: two packages.** Each package's id in a
   collection is qualified, `<workspace>:<package>`, where `<workspace>` is
   the workspace id, the 12 hex digits that name its state directory. A
   directory's name would collide in exactly the case this default is for
   (two checkouts both called `foundry`); the id cannot. People read a
   workspace by its label: the workspace's `package.json` name, else its
   directory's name, and `parent/name` where two labels in one collection
   are equal. Linking same-named packages is a later collection setting,
   not in 0.1.
4. **Edges between workspaces: package level only, from declared
   dependencies.** A dependency becomes a crossing when its name, after an
   `npm:` alias is resolved, is no package of the declaring workspace, its
   range does not use the `workspace:` protocol, and exactly one other
   workspace of the collection has a package of that name. A name that two
   or more other workspaces hold is recorded as ambiguous, with no edge. The
   range is recorded as written and not checked against the version found.
   No module-level edges: they would need the scan to record, per file,
   which external specifiers it imports.
5. **Shape: separate scans, and a collection manifest derived from them.**
   Shape 3, without persisting the result. Each workspace keeps its own
   scan, state, cache, and lock, unchanged. The collection manifest is a
   pure function of the saved workspace manifests: `serve` derives it per
   request, and `atlas export` writes it beside the copied datasets. Nothing
   is saved under the state root for a collection, so there is no
   collection record, id, or lock, and nothing to go stale: each viewer
   frame reads, and pins, the dataset its workspace holds at that moment.
6. **The viewer: one archipelago per workspace, side by side,** with the
   crossings drawn across the sea between them. Waits for Phase 4 (5.4).
7. **History stays per workspace.** `--history` applies to each
   workspace's scan; separate repositories cannot be aligned by commit.
8. **One workspace given twice, on the command line, is refused.** Ruled
   2026-10-10 during 5.1's review. Two or more paths that name one
   workspace, such as `atlas scan . .` or a path and a link to it, exit `2`
   and name the path given twice, so that the output's layout never changes
   silently between a workspace's and a collection's. One path, given once,
   runs the single-workspace commands unchanged; two or more distinct
   workspaces are a collection. The library's `resolveCollection` accepts a
   collection of one.
