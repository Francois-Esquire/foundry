---
title: How Atlas reads a codebase
description: The ways a scan understands a workspace, and where each result lands.
---

A scan understands a workspace in layers. Each layer is computed from the
one below it and written to the [dataset](/atlas/reference/output); the
viewer draws from all of them. Nothing in a scan modifies the code. Where an
analysis produces plans or scenarios, they are read-only descriptions of
what the graph would support, never applied.

## Package by package

The first pass looks at one package at a time, from its own sources only:

- **Symbols and scope.** What the package declares, and which declarations a
  declared entry point actually exposes. A symbol is package-public only if
  an entry point reaches it.
- **Module roles.** Whether a file is an aggregator that re-exports others or
  an internal module, from syntax alone.
- **Local complexity.** Per function: control flow, nesting, and exits, as
  raw facts without a score.
- **Concept seeds.** The named things a package introduces, which the later
  passes follow across the workspace.
- **File kinds.** Source, test, story, configuration, or other, from the
  path.

## Across the workspace

The second pass builds one program over the whole workspace and relates the
packages to each other. Every row lands in `packages/<name>.json` unless it
says otherwise.

| Family | Analysis | What it computes |
| --- | --- | --- |
| Structure | Dependencies | The import graph between files, sliced per package, with the edges that cross a boundary |
| Structure | Gravity | Fan-in, fan-out, transitive reach, cycle membership for each package and file |
| Structure | Architectural profile | Descriptive shape signals: foundation-like, leaf-like, shared hub, surface-heavy |
| Structure | Boundary interactions | Traffic per package boundary, from usage, imports, and module edges |
| Structure | Structural pressure | Where independent measurements converge on the same place |
| History | Churn | Commits, line churn, recency, and authors per file over the last year, following renames |
| History | Hotspots | Files where churn and complexity meet |
| History | Change coupling | File and package pairs that change together, and whether a static edge or path explains it; also `history/couplings.json` |
| History | Change radius | How many files, packages, and static edges each commit touched |
| History | Evolutionary pressure | Whether history reinforces, contradicts, or leaves unsupported the structural findings |
| Concepts | Inventory and distribution | Each concept, and how it spreads across packages, files, and references |
| Concepts | Overlap | Concepts that may be the same thing: shared shape, properties, converters, or name tokens |
| Concepts | Ownership | Where a concept is declared, represented, used, and acted on, and the tensions between those centers |
| Concepts | Locality | How far apart the files and packages that share a concept sit in the graph and in history |
| Concepts | Re-centering | Concepts whose declared home differs from their observed center, with alternative scenarios, their simulated impact, and a review that compares them without ranking |
| Opportunities | Reduction opportunities and plans | Gated structural operations the graph supports: internalizing an export, folding a package. Each comes with evidence, cautions, and a read-only plan |

History rows need Git; without it they are empty and the rest is
unaffected.

## The workspace as a whole

The package reports are merged into `workspace.json`, and three more results
are computed on top:

- **Graph.** Package and module graph metrics.
- **Concepts on the graph.** Where each concept sits across packages, in
  `concepts/index.json`.
- **Patterns.** Recurring architectural patterns, in `projections/patterns.json`.

From these, renderer-neutral projections are written under `projections/`.
The viewer lays islands out from `dependency-graph.json`.

## Inside a package

After the dataset is published, each complete package gets an internal
survey in `internals/<name>.json`, computed fresh every scan:

1. **Topology.** The import graph among the package's own source files.
2. **Symbol locality.** For each symbol used inside the package, where it is
   declared against where its consumers are.
3. **Responsibilities.** Regions of files that rule-fired edges bind
   together, and how the regions relate. The viewer draws these as
   districts.
4. **Primitive conventions.** Symbol roles, consumer scope, and recurring
   placement conventions.
5. **Rewiring scenarios.** For each candidate, the current arrangement, a
   target, its simulated effects, and what it preserves.
6. **Review.** Pairwise comparison within each scenario family, with
   dispositions such as credible alternative, trade-off, or preservation
   required. Nothing is weighted, scored, or ranked.

This is what the viewer's **Evidence & alternatives** panel shows.
