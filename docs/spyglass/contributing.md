---
title: Contributing
description: Build, test, and maintain Spyglass and its documentation.
sidebar:
  hidden: true
---

From the Foundry repository root:

```sh
bun install --frozen-lockfile
bun run --filter @foundry.sh/spyglass build
bun run --filter @foundry.sh/spyglass typecheck
bun run check
bun run test --filter=@foundry.sh/spyglass
bun run --cwd=apps/spyglass test:package
```

`build` clears `dist`, bundles the CLI, the library entry, both workers,
and the chunks they share into `dist/lib` with Bun, writes the library's
declarations to `dist/lib/index.d.ts` with tsup, and builds the viewer into
`dist/web` with Vite. Every built file stays in `dist/lib`: the workers are
found beside the running file, and the viewer at `../web`. Vitest covers
the library and the renderer, apart from serving, which needs Bun; the Bun
test runs `serve`, the built CLI, worker, server, and browser loaders
together. `test:package` packs the tarball, installs it into a temporary
consumer, and drives the installed bin, the library under Bun and Node,
and a TypeScript consumer of its declarations. The release workflow runs
the same check before publishing.

Spyglass is published independently as `@foundry.sh/spyglass`, starting at
0.0.1 on npm's `alpha` channel. Release Please maintains its release PR,
version, and changelog. Merging that PR creates a `spyglass-vX.Y.Z` GitHub
Release, builds and tests its package archives, and automatically starts the
publisher. The protected `npm` environment requires maintainer approval before
CI publishes the tested tarball through OIDC. Marbles and the private libraries
keep their own versions. See the repository's
[release guide](https://github.com/Francois-Esquire/foundry/blob/main/CONTRIBUTING.md#versions-and-release-prs).

## Documentation

Spyglass pages live in `docs/spyglass`; `blume.config.ts` selects the published
content and the folder `meta.ts` files order it. Where a page and the code
disagree, the code wins and the page changes.

Every behavior a page claims is checked against the packed binary, not the
source: pack with `bun pm pack`, install the tarball into a scratch
consumer, and run `spyglass` from its `node_modules/.bin`. Scan a copy of
`apps/spyglass/test/lib/fixtures/semantics`, and, for the configuration and
history pages, a copy with a `foundry.config.json` and a copy committed to a
temporary Git repository. Compare the manifest and the output tree with what
the page says. Maintainer notes prefixed with `_` stay outside the rendered
site.
