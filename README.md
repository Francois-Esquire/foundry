# Foundry

Bun and Turborepo workspace for applications, shared packages, and repository tooling.

## Getting started

Use the Bun version in `packageManager`, then install the locked dependencies:

```sh
bun install --frozen-lockfile
bun run build
bun run quirks status
```

`apps/` owns runnable applications, `packages/` owns shared libraries, and
`tooling/` owns shared configuration. Shared libraries include
`@foundry/lib`, `@foundry/workspaces`, `@foundry/agents`, `@foundry/workflows`,
and `@foundry/models`. Quirks is the workflow runner in `apps/quirks`; its
terminal status view uses OpenTUI Core.

## Repository commands

| Command | Purpose |
| --- | --- |
| `bun run validate` | Combined code checks, dependency consistency, typecheck, and dead code |
| `bun run lint` / `lint:fix` | Check or fix lint issues with Ultracite's Biome rules |
| `bun run format` / `format:fix` | Check or fix formatting |
| `bun run check` / `fix` | Combined lint, formatting, and import organization |
| `bun run typecheck` | Run package typechecks through Turbo |
| `bun run lint:deps` / `lint:deps-fix` | Check or fix dependency consistency with Sherif |
| `bun run dead-code` | Find unused code and dependencies with Knip |
| `bun run build` | Run package builds in dependency order |
| `bun run test` / `test:coverage` | Run package tests or coverage scripts |
| `bun run test:watch` | Run package test watchers locally |
| `bun run clean` | Remove package outputs and root task caches |
| `bun run dev` | Start package development tasks |

`check-types` remains an alias for `typecheck` for existing callers. New package
scripts use `typecheck`. Use `bun run --cwd apps/tui typecheck` to run a package
script directly, or `bun run typecheck --filter=tui` to use Turbo filtering.

## Package conventions

Packages keep tests in `src/test/`; apps keep tests in root `test/`. Shared
test helpers go in the corresponding `test/helpers/` directory.

Keep build, test, and clean implementations in each package. Root commands only
orchestrate them. Declare actual build outputs in Turbo; typechecking waits for
dependency builds, and tests wait for their package build. Watch tasks and cleaning
are never cached. Cleaning preserves installed dependencies and environment files.

Linting and formatting use one root Biome configuration extending Ultracite.
Knip analyzes the repository's workspace graph; entry points and exceptions belong
in `knip.json`. Keep exceptions specific to actual dynamic or public entry points.

Use explicit dependency versions or ranges in package manifests and `workspace:*`
for internal dependencies. There is no catalog. Sherif checks consistency across
manifests.

Bun's automatic `.env` loading is disabled in `bunfig.toml`. Quirks currently
uses the environment inherited from its launching process. Varlock is installed
for application environment loading and validation, but Quirks does not yet
invoke it or define an environment schema. Export required variables before
launching the app. Declare task-specific environment inputs in Turbo.

## Continuous integration

PRs, pushes to `main`, and manual runs perform a frozen install and separate code,
dependency, typecheck, and dead-code checks. A second job runs package build and
test scripts. These gates build and test the libraries and Quirks. The TUI scaffold
currently has typechecking but no build or test script.

Run `bun run validate`, `bun run build`, and `bun run test` before opening a PR.
CI uses read-only repository permissions, cancels superseded PR runs, and requires
no secrets. Dependabot checks GitHub Actions updates weekly.

The pre-commit hook runs combined code checks for staged paths. Use
`bun run prepare` to install it. It does not replace full validation.
