# Contributing to Foundry

Use the Bun version in the root `packageManager` field. Install dependencies
with `bun install --frozen-lockfile`. Build and test commands run through
Turborepo, with implementations owned by each workspace.

```sh
bun run validate
bun run build
bun run test
bun run test:package
```

`validate` runs Ultracite, Sherif, TypeScript, and Knip. `test` runs the default
package suites. `test:package` separately installs packed public packages into
temporary projects, so it needs registry access. Quirks checks its installed
library, TypeScript declarations, CLI, and the registry shared by CLI and config.
These tests do not require model credentials.

Quirks has a `prepack` hook for ordinary local packing. CI builds explicitly and
uses `--ignore-scripts` during packing and publishing to preserve the tested build.

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

`check-types` remains an alias for `typecheck`. New package scripts use
`typecheck`. Run one package directly with `bun run --cwd apps/quirks typecheck`,
or use `bun run typecheck --filter=@foundry/quirks` for Turbo filtering.

## Package conventions

`apps/` owns runnable applications, `packages/` owns shared libraries, and
`tooling/` owns repository tools and configuration. Packages keep tests in
`src/test/`; apps keep tests in root `test/`. Shared test helpers go in the
corresponding `test/helpers/` directory.

Keep build, test, and clean implementations in each package. Declare actual
outputs in Turbo. Typechecking waits for dependency builds; tests wait for their
package build. Watch tasks and cleaning are uncached. Cleaning preserves
installed dependencies and environment files.

Use explicit dependency versions or ranges and `workspace:*` for internal
dependencies. There is no catalog. Sherif checks manifest consistency. Biome
extends Ultracite at the root; Knip entries and narrow exceptions belong in
`knip.json`.

Bun's automatic `.env` loading is disabled in `bunfig.toml`. Quirks inherits its
launching process's environment. Varlock is installed, but Quirks does not yet
invoke it or define an environment schema. Export required variables before
launching the app and declare task-specific environment inputs in Turbo.

## Continuous integration

PRs, pushes to `main`, and manual runs perform a frozen install and code,
dependency, typecheck, and dead-code checks. Separate jobs build and test packages
and validate and build documentation. CI uses read-only repository permissions,
cancels superseded PR runs, and requires no secrets. Publishing has its own
workflow and permissions, described below.

The pre-commit hook checks staged paths. Use `bun run prepare` to install it.
It does not replace full validation. Dependabot checks GitHub Actions weekly.

## Documentation

The [documentation site](https://francois-esquire.github.io/foundry/) is hosted
on this repository's GitHub Pages. Its source lives in [docs/quirks](docs/quirks/index.md).
Blume is installed at the root and reads `blume.config.ts`.

```sh
bun run docs:dev
bun run docs:check
bun run docs:typecheck
bun run docs:build
```

These commands also have explicit Turbo root tasks. The static output is
`dist/`; `.blume/` holds the generated runtime. Both are ignored by Git. Stop
the docs server before building because the build regenerates its runtime.
The docs typecheck covers authored configuration and navigation.

The CI documentation job builds and checks pull requests. On pushes to `main`,
or a manual CI run on `main`, it also uploads `dist/` as the Pages artifact.
A separate deployment job publishes that exact artifact using the `github-pages`
environment and Pages/OIDC permissions. It depends on the documentation build;
the other repository checks run independently.

Blume's deployment base is `/foundry`, matching the GitHub project site. Author
internal documentation links without that prefix; Blume applies it to routes,
assets, search, and canonical URLs. A local `docs:build` produces the site but
does not deploy it. GitHub Pages must use GitHub Actions as its publishing source.

## Changelog and versions

Public packages share a release version and one `vX.Y.Z` tag. Private workspace
versions do not participate. Only `@foundry/quirks` is public today.

`bun run changelog` uses the same Conventional Commits preset as redux.io. It
rebuilds the repository `CHANGELOG.md` from Git history and copies it into each
public package. Entries include features, fixes, breaking changes, and commit
links. This is repository history, including earlier work, rather than a
package-specific history. Regeneration includes committed changes only and
requires full Git history and tags. Review the result before releasing.

For a release:

1. Use Conventional Commits such as `fix(quirks): handle an empty schedule` or
   `feat(quirks): add a monitor`. Use `!` and a `BREAKING CHANGE:` footer for
   incompatible changes, including migration instructions.
2. Choose a major version for incompatible changes, minor for compatible
   features, or patch for fixes. Set that version in every non-private
   workspace's `package.json`. Use a prerelease such as `0.2.0-beta.1` when needed.
3. Run `bun install` to update `bun.lock`, then `bun run release:check` and
   `bun run changelog`. No command here creates a commit or tag.
4. Run `bun run validate`, `bun run build`, and `bun run test`.
5. Run `bun run release:pack`. This packs every public package with Bun, which
   converts `workspace:*` references to versions, then tests each exact tarball
   in a temporary consumer. Inspect `.cache/release/packages.json`, the tarballs,
   and `.cache/release/release-notes.md`. Remove only `.cache/release` before
   repeating this command; it refuses to reuse old artifacts.
6. When approved, commit and push the release changes, then create and push the
   matching `vX.Y.Z` tag. The tag starts `.github/workflows/publish.yml`. A manual
   run must select that same tag; branch runs are rejected.

The workflow regenerates release documentation, validates, builds, tests, and
packs on a runner with read-only repository permissions. It uploads the tested
tarballs and release notes. Publishing runs on a fresh runner with no checkout,
installation, or dependency cache. It downloads and unpacks the artifacts,
then uses `npm publish --ignore-scripts` with OIDC. Only this job has
`id-token: write`. Stable releases use `latest`; prereleases use `next`.
GitHub release notes are created or updated only after all publications succeed.

npm versions are immutable. A rerun after publication will fail on an existing
version. For a partial multi-package publication, inspect npm before recovery;
do not blindly rerun or change already published versions. If all packages
published and only GitHub release creation failed, use the uploaded
`release-notes.md` to finish the GitHub release.

## One-time publishing setup

Configure this after the package name and npm ownership are ready. The current
name is `@foundry/quirks`; the account publishing it needs access to the `@foundry`
organization. If the package does not yet exist on npm, bootstrap its first
publication through npm's supported initial-publication process, then configure
trusted publishing for subsequent versions.

For each public package, use these npm trusted publisher settings:

| Setting | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `Francois-Esquire` |
| Repository | `foundry` |
| Workflow filename | `publish.yml` |
| Environment | `npm` |
| Allowed actions | Direct `npm publish` |

Create the GitHub `npm` environment and configure any required reviewers and
release-tag deployment rules. The repository URL in each package must match
this repository. npm requires CLI 11.5.1 or newer and Node 22.14.0 or newer for
[trusted publishing](https://docs.npmjs.com/trusted-publishers/). The workflow
uses Node 24 and checks npm's version. No `NPM_TOKEN` secret is used. npm
provenance is automatic where npm's repository and package eligibility rules
allow it. Local package checks cannot validate GitHub's OIDC exchange.

## Adding another public package

Set `private` to `false` or remove it, align its version with the public release,
and add its description, repository directory, license, exports or binary,
`files` allowlist, and public `publishConfig`. Add a `test:package` script that
installs and checks `PACKAGE_TARBALL` when that environment variable is set.
Without it, the script should pack its own current build for local checks.
Keep build and test implementations in the package.

The release tooling reads root workspace patterns, excludes `private: true`,
rejects private runtime dependencies, and publishes public dependencies before
their consumers. Private implementation packages can be bundled, as Quirks does,
but cannot remain runtime dependencies or unresolved imports in the tarball.
Configure npm trusted publishing for the new package before tagging a release.
