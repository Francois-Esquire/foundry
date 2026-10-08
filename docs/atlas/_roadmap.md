# Atlas roadmap

Maintainer note, excluded from the Blume site. Where Atlas is going and what
stands between it and a first publish. Dated 2026-09-28.

## Direction

Atlas is its own package, published separately from Marbles. Today it is a
scan and a viewer. The next layers, in the maintainer's words:

1. **Ways of understanding the codebase.** Each analysis the scan computes
   gets described on its own, with what it measures and what it is for. The
   concepts page today lists them in one table; each deserves a page once
   the viewer exposes it directly.
2. **Rules, from package level to workspace level.** Rules a workspace
   declares about its own structure, checked against the dataset: what a
   package may expose, what may depend on what, where a concept belongs.
   The code already has the read-only pieces: opportunities with
   eligibility gates, plans, scenarios, and a review that compares without
   ranking. Rules would make the gates the workspace's own.
3. **Codemods.** Applying what the plans describe. One mutating operator
   exists in the library, `internalize-export`, which previews by default
   and writes only when asked, restoring files if verification fails. The
   CLI does not expose it, and nothing should until rules say when it may
   run. Research and an opinion on tooling: [`_codemods.md`](./_codemods.md).

## Before the first publish

Found while packaging on 2026-09-28. Each is small; together they decide
whether a first install feels finished.

- The release tooling publishes every non-private workspace under one
  shared version from one `v*` tag. Atlas and Marbles release together until
  the tooling learns per-package tags.
- `dist/cli/atlas.js.map` ships in the tarball; `files` could exclude it.
- Analysis workers are spawned as `bun` from the PATH rather than the
  running executable, so a Bun on the PATH is required even when the CLI
  was started by an absolute path.
- The missing-assets error tells the user to run
  `bun run --filter @foundry/atlas build`, which means nothing to an npm
  install.
- Foundry-specific strings in the code: the `@foundry/workspaces` anchor in
  the analysis policy, which blocks `fold-package` for any package of that
  name in any scanned repository, and the idle caption "The Foundry
  archipelago".
- `semantics.output` is read from the config file and ignored by the CLI.
- `history.strategy` is not validated; an unrecognized value behaves as
  `every-n-commits`.
- A `--history` scan replaces `output/history/` and drops the
  `history/couplings.json` a plain scan wrote there, while the manifest
  still points at it. Confirmed on the fixture.
- The viewer's `atlas-world` class loses its space when settings are open
  (`atlas-worldatlas-settings-open`), so the wide-layout shift stops
  applying.
- Discovery reads `package.json#workspaces` only; `pnpm-workspace.yaml` is
  not read, and the default roots are Foundry's.

## Documentation

The public pages describe the packed binary as of 2026-09-28. The viewer's
components were being renamed while the pages were written, so the guides
name stable vocabulary and a few controls, not every panel. When the viewer
settles, "Explore the map" can grow screenshots and a controls table.
