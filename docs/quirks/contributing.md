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
a configuration and the CLI use the same registry. `bun run quirks` at the
repository root runs the built `dist/cli.js`, so rebuild before checking CLI
behavior.

The default tests mock provider operations: `vitest` for the library and
engine, `bun test` for the terminal views and source-position identity.
Package checks separately install a tarball into a temporary consumer project
and exercise the library, declarations, and CLI. They also load a config
outside any project installation and run a deterministic step without
providers on `PATH`. They require registry access.

The [contributor guide](https://github.com/Francois-Esquire/foundry/blob/main/CONTRIBUTING.md)
covers repository checks, changelog generation, and publishing. The packaged
changelog currently contains repository-wide release history.

## Skills

Project skills for coding agents live in the top-level `skills/` directory, one
folder per skill with a `SKILL.md`, laid out for the
[skills CLI](https://github.com/vercel-labs/skills)
(`npx skills add Francois-Esquire/foundry --skill quirks-config`). A skill is
self-contained: an installed copy cannot read this repository, so
`skills/quirks-config/references/api.md` restates the authoring API from
`_api-alt.md`. A change to the API doc changes the skill in the same commit.
The repository's own `.agents/skills` and `skills-lock.json` are skills
installed *from* elsewhere and are managed by the CLI, not by hand.

## Documentation

Blume and its configuration live in the top-level `docs/` package. Quirks
pages live in `docs/quirks`; `blume.config.ts` selects the published content
and `quirks/meta.ts` orders it. Quirks and Atlas are header tabs, each scoped
to its own folder. The home page is the custom `pages/index.astro`, rendered
without a sidebar; its links are not covered by `docs:check`, so confirm them
against the built site.

Most pages use Markdown. Pages with Mermaid diagrams, callouts, or pattern cards
use MDX because Blume renders those components through its MDX pipeline. Internal
links use site routes such as `/quirks/start-here`.

```sh
bun run docs:dev
bun run docs:check
bun run docs:typecheck
bun run docs:build
```

The static site is generated in `docs/dist/`. Blume's generated runtime lives
in `docs/.blume/`. Both are ignored by Git. Maintainer notes prefixed with `_`,
such as `_api-alt.md` and `_rebuild-gaps.md`, stay outside the rendered site.
Where a public page and the code disagree, the code wins and the page changes;
where `_api-alt.md` and the code disagree, the difference is recorded under
its open items.

Every code sample on a public page loads: extract it into a scratch config
with `zod` and `typescript` resolvable beside it, then run it with
`bun run quirks -- --config <path> --dry list` and, where a step is named,
`--dry once <name>`.

CI publishes the built site to GitHub Pages after a successful documentation
build on `main`. Pull requests only validate and build. The site lives at
`https://francois-esquire.github.io/foundry/`, so local previews also use the
`/foundry` deployment base.

The authored first-release introduction lives in `first-release.md`. It is kept
separate from the generated package changelog so regeneration cannot overwrite
it. Integrating that introduction into release generation is a tracked follow-up.
