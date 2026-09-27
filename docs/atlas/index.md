---
title: Atlas
description: A map of a codebase, generated from the code and served locally.
sidebar:
  label: Introduction
---

**Atlas draws a workspace as a map you can explore in the browser.**

Point it at a directory. Atlas analyzes the packages and files it finds, saves
the result outside the workspace, and serves a local web viewer that renders
packages as territories, files as settlements, and dependencies as the routes
between them.

```sh
atlas scan ./my-workspace
atlas serve ./my-workspace
atlas ./my-workspace
```

`scan` analyzes and saves. `serve` shows the last saved result. With no
subcommand, Atlas does both and opens the browser. The workspace itself is
never modified.

[Run your first scan](/atlas/start-here)
