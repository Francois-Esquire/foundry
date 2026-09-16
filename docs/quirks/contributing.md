---
title: Contributing
description: Build, test, and maintain Quirks and its documentation.
sidebar:
  hidden: true
---

From the Foundry repository root:

```sh
bun install --frozen-lockfile
bun run build --filter=@foundry/quirks
bun run --cwd=apps/quirks typecheck
bun run check
bun run --cwd=apps/quirks test
bun run --cwd=apps/quirks test:package
```

The library lives in `apps/quirks/src/lib/`; the CLI entry is
`apps/quirks/src/cli.ts`. One tsup build emits both entries with shared chunks so
a configuration and the CLI use the same registry.

The default tests mock harness operations. Package checks separately install a
tarball into a temporary consumer project and exercise the library, declarations,
and CLI. They also load a config outside any project installation and run a
deterministic step without harnesses on `PATH`. They require registry access.

The [contributor guide](https://github.com/Francois-Esquire/foundry/blob/main/CONTRIBUTING.md)
covers repository checks, changelog generation, and publishing. The packaged
changelog currently contains repository-wide release history.

## Documentation

Blume is installed at the repository root. Quirks pages live in `docs/quirks`;
`blume.config.ts` selects the published content and `docs/quirks/meta.ts` orders it.
Most pages use Markdown. Pages with Mermaid diagrams, callouts, or pattern cards
use MDX because Blume renders those components through its MDX pipeline. Internal
links use site routes such as `/quirks/start-here`.

```sh
bun run docs:dev
bun run docs:check
bun run docs:typecheck
bun run docs:build
```

The static site is generated in `dist/`. Blume's generated runtime lives in
`.blume/`. Both are ignored by Git. Maintainer notes prefixed with `_`, including
`_api-followups.md`, stay outside the rendered site.

The authored first-release introduction lives in `first-release.md`. It is kept
separate from the generated package changelog so regeneration cannot overwrite
it. Integrating that introduction into release generation is a tracked follow-up.
