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

## Source ownership

| Location | Responsibility |
| --- | --- |
| `src/lib/` | The engine, registry, resource managers, and execution. Imports no code from the authoring or CLI layers. Published as `@foundry/marbles/lib`. |
| `src/authoring/` | Builders and prebuilt steps. Collects declarations in the catalog used by the CLI. |
| `src/cli.ts`, `src/host.ts`, `src/create.ts` | Starts the CLI or dashboard, builds the engine, and copies the catalog into it. |
| `src/source.ts`, `src/onboarding/` | Discovers automation modules and creates starters. |

These paths are under `apps/marbles/`. One tsup build emits the entry points
with shared chunks, so modules and the CLI use the same catalog.
`bun run marbles` runs the built `dist/cli.js`; rebuild before checking it.

The default tests mock provider operations: `vitest` for the library and
engine, `bun test` for the terminal views and source-position identity.
Package checks separately install a tarball into a temporary consumer project
and exercise the library, declarations, and CLI. They also load a module
outside any project installation and run a deterministic step without
providers on `PATH`. They require registry access.

The [contributor guide](https://github.com/Francois-Esquire/foundry/blob/main/CONTRIBUTING.md)
covers repository checks, changelog generation, and publishing. The packaged
changelog currently contains repository-wide release history.

## Build a distributable package

From the Foundry repository root, build the package and write its archive
outside the checkout:

```sh
bun install --frozen-lockfile
bun run build --filter=@foundry/marbles
cd apps/marbles
bun pm pack --ignore-scripts --filename /tmp/foundry-marbles-0.1.0.tgz
```

Distribute that archive for [standalone installation](/marbles/get-started/installation).
`--ignore-scripts` avoids a second build after the explicit build above.
The archive includes declarations, the CLI, and bundled Foundry libraries;
third-party runtime dependencies install from its manifest. This creates a
local archive and does not publish a release.

## Skills

Project skills for coding agents live in the top-level `skills/` directory, one
folder per skill with a `SKILL.md`, laid out for the
[skills CLI](https://github.com/vercel-labs/skills)
(`npx skills add Francois-Esquire/foundry --skill marbles-config`). A skill is
self-contained: an installed copy cannot read this repository, so
`skills/marbles-config/references/api.md` restates the public authoring API from
`reference/api.md`. Public docs and current source own the supported contract;
underscore-prefixed proposals are historical design material. Update the
companion API reference in the same commit when that contract changes.
The repository's own `.agents/skills` and `skills-lock.json` are skills
installed *from* elsewhere and are managed by the CLI, not by hand.

## Documentation

Blume and its configuration live in the top-level `docs/` package. Marbles
pages live in `docs/marbles`; `blume.config.ts` selects the published content
and `marbles/meta.ts` orders it. Marbles and Atlas are header tabs, each scoped
to its own folder. The home page is the custom `pages/index.astro`, rendered
without a sidebar; its links are not covered by `docs:check`, so confirm them
against the built site.

Each Marbles section has one job:

- **Get Started** installs the standalone CLI, gets one small TypeScript
  automation running, then introduces capabilities in Using Marbles.
- **Foundation** explains the API, definitions, instances, callback contexts,
  composition, resource lifetimes, and execution.
- **Use Cases** builds useful automations. Software Factory is a sequence of
  runnable stages; smaller use cases stay on one page.
- **Reference** holds exact commands, options, state rules, troubleshooting,
  and the advanced remote and embedding boundaries.
- **Roadmap** describes current priorities and planned capabilities in a
  Now, Next, and Later sequence. Keep proposed APIs separate from supported
  reference material; the private `_roadmap.md` preserves delivery history.

A section heading does not need a duplicate child landing page. Software
Factory's first page explains its specific workflow and prerequisites.
Tutorials state the outcome, required setup, files to create, how to verify
success, and the next extension. Shared setup has one canonical home.

Safety and dry-run boundaries live in `reference/safety.mdx`. Old public
routes redirect through `blume.config.ts`; update internal links to the new
routes. Keep contributor setup outside the product quickstart. Parked
proposals live under underscore-prefixed paths and stay unpublished.

### Writing a page

Start with what the reader will do or understand. Use one term for each
concept: a definition describes work, a run executes it, a session keeps a
conversation, and an artifact version keeps output files.

Introduce an operation with its input and result, then explain the rules
needed to use it correctly. Keep setup, failure cases, resource lifetime,
and replay requirements near the relevant example. Put detailed options
in Reference and link to them from tutorials.

Name sample steps after their work. Keep workflow composition visible and
put long supporting implementations in expandable sections. Label complete
modules and partial replacements; a reader should know what to copy and
what result to expect. Avoid new abstractions used by only one example.

Most pages use Markdown. Pages with Mermaid diagrams, callouts, or pattern cards
use MDX because Blume renders those components through its MDX pipeline. Internal
links use site routes such as `/marbles/get-started/quickstart`.

```sh
bun run docs:dev
bun run docs:check
bun run docs:typecheck
bun run docs:build
```

If the development server is running, build in isolation with
`bun run --cwd=docs docs:build --isolated`. This keeps the preview's generated
runtime intact and writes output under `docs/.blume-verify/dist/`.

The static site is generated in `docs/dist/`. Blume's generated runtime lives
in `docs/.blume/`. Both are ignored by Git. Maintainer notes prefixed with `_`,
such as `_api-alt.md`, `_rebuild-gaps.md`, and `_findings.md`, stay outside
the rendered site. When a guide or recipe has to work around the library,
the page says what it does instead, and `_findings.md` records the limit
with a proposal.
Where a public page and the code disagree, check the implementation and
tests, then correct the page. Historical proposals do not establish current
capabilities.

Every complete code sample on a public page must load and typecheck.
Clearly label API syntax excerpts and incremental replacements. For the
Software Factory, the canonical TypeScript files live in
`use-cases/software-factory/_example/`. Blume includes those files as code
blocks, so validation checks the same source readers see. Assemble the named
files in chapter order and check each version of the launch module.

Use a scratch project with `zod` and `typescript` resolvable beside the sample,
then run `bun run marbles -- --source <path> --dry-run list`. Dry execution
substitutes command output; examples that parse GitHub JSON or require real
commit IDs need a local Git fixture and mocked provider and GitHub responses
for behavior checks. Do not publish test pull requests to validate a guide.

CI publishes the built site to GitHub Pages after a successful documentation
build on `main`. Pull requests only validate and build. The site lives at
`https://francois-esquire.github.io/foundry/`, so local previews also use the
`/foundry` deployment base.

The authored first-release introduction lives in `first-release.md`. It is kept
separate from the generated package changelog so regeneration cannot overwrite
it. Integrating that introduction into release generation is a tracked follow-up.
