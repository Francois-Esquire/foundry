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

## Current work

Started 2026-10-09 on the `feat/atlas` branch. What all of it serves: show
the shape of the code, what sits next to what, how it nests, and where
things live against where they are used, so that a misplaced part is
visible, and an intended one is labeled rather than hidden. Domains are
the workspace's side of that: [`_domains.md`](./_domains.md). The views
that show it are lenses: [`_lenses.md`](./_lenses.md).

The sequence and the ground rules, chief among them that the existing
analyses are built on rather than changed, are in
[`_phases.md`](./_phases.md). What already exists, found by reviewing the
code before building anything, is in [`_review.md`](./_review.md). The
external surface comes first, because
the others depend on it.

1. **The 0.1 API, CLI and library.** What ships in the first version, and
   the principles that shape it: [`_api.md`](./_api.md).
2. **Codemods.** Rules first, then `check`, `plan`, and `apply`, in that
   order: the decisions section of [`_codemods.md`](./_codemods.md).
3. **The viewer.** A diagnosis of where it stands and the questions to
   settle before reworking it: [`_viewer.md`](./_viewer.md).
4. **Many workspaces in one atlas.** What assumes one workspace today, and
   the shapes a collection could take: [`_workspaces.md`](./_workspaces.md).

## Before the first publish

Found while packaging on 2026-09-28. Each is small; together they decide
whether a first install feels finished. Each is now assigned to a phase 1
effort in [`_phases.md`](./_phases.md#phase-1-shape-the-api), except the
release tooling item.

- The release tooling publishes every non-private workspace under one
  shared version from one `v*` tag. Atlas and Marbles release together until
  the tooling learns per-package tags.

## Documentation

The public pages describe the packed binary as of 2026-09-28. The viewer's
components were being renamed while the pages were written, so the guides
name stable vocabulary and a few controls, not every panel. When the viewer
settles, "Explore the map" can grow screenshots and a controls table.
