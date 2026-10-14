---
title: Spyglass
description: A map of a codebase, generated from the code and served locally.
sidebar:
  label: Introduction
---

**Spyglass draws a workspace as a map you can explore in the browser.**

Point it at a directory of TypeScript packages. Spyglass reads the packages,
their files, and the imports between them, saves what it found outside the
workspace, and serves a local viewer. Packages are islands and files are the
marks on them. Dependency decides an island's row: the foundation to the
south, the packages built on it further north; along a row, islands keep
their folders' order. Zoom in and
an island resolves into districts, then into files. Select a place and Spyglass
shows what it imports, what depends on it, and the evidence behind where it
was drawn; switch on the sea routes to see the trade between islands.

```sh
spyglass scan ./my-workspace
spyglass serve ./my-workspace
spyglass ./my-workspace
```

`scan` analyzes and saves. `serve` shows the last saved result. With no
subcommand, Spyglass does both and opens the browser. The workspace itself is
never modified, except where you point `spyglass export`, and nothing leaves
your machine.

Spyglass is a package, `@foundry/spyglass`, with one binary and a library. It
runs on Bun and needs Git only when you ask for history.

- [Start here](/spyglass/start-here): install, scan, and open the viewer.
- [Examples](/spyglass/examples): explore Spyglass's map of Foundry in your browser.
- [How Spyglass reads a codebase](/spyglass/concepts/how-spyglass-reads-a-codebase):
  what the scan computes.
- [Explore the map](/spyglass/guides/explore-the-map): what you are looking at
  and how to move around.
- [CLI](/spyglass/reference/cli), [library](/spyglass/reference/library),
  [configuration](/spyglass/reference/configuration), and
  [output](/spyglass/reference/output): the reference.
