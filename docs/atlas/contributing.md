---
title: Contributing
description: Build, test, and maintain Atlas and its documentation.
sidebar:
  hidden: true
---

From the Foundry repository root:

```sh
bun install --frozen-lockfile
bun run --filter @foundry/atlas build
bun run --filter @foundry/atlas typecheck
bun run check
bun run test --filter=@foundry/atlas
bun run --cwd=apps/atlas test:package
```

`build` bundles the CLI and its analysis worker into `dist/cli` with Bun and
the viewer into `dist/web` with Vite. Vitest covers the library and the
renderer; the Bun test runs the built CLI, worker, server, and browser
loaders together. `test:package` packs the tarball, installs it into a
temporary consumer, and scans and serves a fixture through the installed
bin. The release workflow runs the same check before publishing.

Atlas is a separate public package, `@foundry/atlas`, not yet published.
The repository's release tooling publishes every non-private workspace
under one shared version from a `v*` tag, so Atlas and Marbles will release
together until the tooling learns per-package tags.

## Documentation

Atlas pages live in `docs/atlas`; `blume.config.ts` selects the published
content and the folder `meta.ts` files order it. Where a page and the code
disagree, the code wins and the page changes.

Every behavior a page claims is checked against the packed binary, not the
source: pack with `bun pm pack`, install the tarball into a scratch
consumer, and run `atlas` from its `node_modules/.bin`. Scan a copy of
`apps/atlas/test/lib/fixtures/semantics`, and, for the configuration and
history pages, a copy with a `foundry.config.json` and a copy committed to a
temporary Git repository. Compare the manifest and the output tree with what
the page says. Maintainer notes prefixed with `_` stay outside the rendered
site.
