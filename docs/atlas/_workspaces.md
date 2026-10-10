# Many workspaces in one atlas

Maintainer note, excluded from the Blume site. Dated 2026-10-09. What it
takes to draw several workspaces in one visualization. Draft for discussion.

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
- **The viewer loads one manifest.** `./data/` is hard-coded in
  `codex/source.ts` and `load-internals.ts`; island layout, latitude, and
  attraction come from one graph; positions and pigment hash the package id
  alone.
- **State can be listed, but nothing lists it yet.** Since effort 1.3,
  `scan` and `scan.workspace` write a workspace record,
  `<state>/<id>/workspace.json` (root, id, and, once a dataset is saved,
  Atlas version and `lastScannedAt`), as Marbles does for `marbles status`.
  Nothing reads the records yet; a collection (5.1) lists the state root
  through them.
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
  collection. A collection may need a name and a file so it can be
  reopened (`atlas.collection.json`, or a `workspaces` key in the config).
  `scan` returns the collection's results. Ids become qualified,
  `<workspace>:<package>`, in the collection and in the viewer's URLs, and
  stay bare inside a single workspace's dataset.
- **Viewer.** Either one archipelago where each workspace is a region with
  its own sea or coastline, laid out by the merged graph, or one chart per
  workspace side by side. See [`_viewer.md`](./_viewer.md).
- **History.** Separate repositories have separate timelines. Aligning them
  by date is possible; aligning them by commit is not.

## Questions

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
