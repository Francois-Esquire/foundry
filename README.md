# Foundry

Bun and Turborepo workspace for applications, shared packages, and repository tooling.

## Getting started

Use the Bun version in `packageManager`, then install the locked dependencies:

```sh
bun install --frozen-lockfile
bun run dev:tui
```

`apps/` owns runnable applications, `packages/` owns shared libraries, and
`tooling/` owns shared configuration. No application packages have been migrated
from the agents repository yet.

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

Keep build, test, and clean implementations in each package. Root commands only
orchestrate them. Declare actual build outputs in Turbo; typechecking waits for
dependency builds, and tests wait for their package build. Watch tasks and cleaning
are never cached. Cleaning preserves installed dependencies and environment files.

Linting and formatting use one root Biome configuration extending Ultracite.
Knip analyzes the repository's workspace graph; entry points and exceptions belong
in `knip.json`. Keep exceptions specific to actual dynamic or public entry points.

Use explicit dependency versions or ranges in package manifests and `workspace:*`
for internal dependencies. There is no catalog. Sherif checks consistency across
manifests. Keep dependency upgrades separate from migration where possible.

Bun's automatic environment loading is disabled in `bunfig.toml`. Applications
use Varlock for environment loading and validation. Varlock is intentionally
retained as root tooling and excepted from Knip until app-level wiring lands.
Environment schema generation is not configured yet. Declare build/test environment inputs in Turbo
when adding applications that consume them.

## Continuous integration

PRs, pushes to `main`, and manual runs perform a frozen install and separate code,
dependency, typecheck, and dead-code checks. A second job runs package build and
test scripts. These two commands currently have no runnable tasks; their gates
become meaningful as migrated packages add real scripts. No test coverage claim
is made for the current scaffold.

Run `bun run validate`, `bun run build`, and `bun run test` before opening a PR.
CI uses read-only repository permissions, cancels superseded PR runs, and requires
no secrets. Dependabot checks GitHub Actions updates weekly.

The pre-commit hook runs combined code checks for staged paths. Use
`bun run prepare` to install it. It does not replace full validation.
