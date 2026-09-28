---
title: Atlas
description: A map of a codebase, generated from the code and served locally.
sidebar:
  label: Introduction
---

**Atlas draws a workspace as a map you can explore in the browser.**

Point it at a directory of TypeScript packages. Atlas reads the packages,
their files, and the imports between them, saves what it found outside the
workspace, and serves a local viewer. Packages are islands, files are the
settlements on them, and dependencies are the sea routes between islands.
Zoom in and an island resolves into districts, then into files. Select a
place and Atlas shows what it imports, what depends on it, and the evidence
behind where it was drawn.

```sh
atlas scan ./my-workspace
atlas serve ./my-workspace
atlas ./my-workspace
```

`scan` analyzes and saves. `serve` shows the last saved result. With no
subcommand, Atlas does both and opens the browser. The workspace itself is
never modified, and nothing leaves your machine.

Atlas is a package, `@foundry/atlas`, with one binary. It runs on Bun and
needs Git only when you ask for history.

- [Start here](/atlas/start-here): install, scan, and open the viewer.
- [How Atlas reads a codebase](/atlas/concepts/how-atlas-reads-a-codebase):
  what the scan computes.
- [Explore the map](/atlas/guides/explore-the-map): what you are looking at
  and how to move around.
- [CLI](/atlas/reference/cli), [configuration](/atlas/reference/configuration),
  and [output](/atlas/reference/output): the reference.
