---
title: Contributing
description: Build, test, and maintain Marbles and its documentation.
sidebar:
  hidden: true
---

From the Foundry repository root:

```sh
bun install --frozen-lockfile
bun run build --filter=@foundry/marbles
bun run --cwd=apps/marbles typecheck
bun run check
bun run --cwd=apps/marbles test
bun run --cwd=apps/marbles test:package
```

The source has three layers under `apps/marbles/src/`. `lib/` is the engine: the
`Engine` class, the managers it builds over the package instances it is
handed, its registry, and everything that runs a definition. It imports
nothing outside itself and is published as `@foundry/marbles/lib`. `authoring/`
is what a `marbles.config.ts` imports: the builders and the prebuilt steps,
which collect into a catalog private to Marbles. Everything else is the CLI and
the dashboard, entered at `apps/marbles/src/cli.ts`; `src/create.ts` builds the
engine they run and copies the catalog into it. One tsup build emits every
entry with shared chunks so a configuration and the CLI use the same catalog. `bun run marbles` at the
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
(`npx skills add Francois-Esquire/foundry --skill marbles-config`). A skill is
self-contained: an installed copy cannot read this repository, so
`skills/marbles-config/references/api.md` restates the authoring API from
`_api-alt.md`. A change to the API doc changes the skill in the same commit.
The repository's own `.agents/skills` and `skills-lock.json` are skills
installed *from* elsewhere and are managed by the CLI, not by hand.

## Documentation

Blume and its configuration live in the top-level `docs/` package. Marbles
pages live in `docs/marbles`; `blume.config.ts` selects the published content
and `marbles/meta.ts` orders it. Marbles and Atlas are header tabs, each scoped
to its own folder. The home page is the custom `pages/index.astro`, rendered
without a sidebar; its links are not covered by `docs:check`, so confirm them
against the built site.

Most pages use Markdown. Pages with Mermaid diagrams, callouts, or pattern cards
use MDX because Blume renders those components through its MDX pipeline. Internal
links use site routes such as `/marbles/start-here`.

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
`bun run marbles -- --config <path> --dry-run list` and, where a step is named,
`--dry-run roll <name>`.

CI publishes the built site to GitHub Pages after a successful documentation
build on `main`. Pull requests only validate and build. The site lives at
`https://francois-esquire.github.io/foundry/`, so local previews also use the
`/foundry` deployment base.

The authored first-release introduction lives in `first-release.md`. It is kept
separate from the generated package changelog so regeneration cannot overwrite
it. Integrating that introduction into release generation is a tracked follow-up.
