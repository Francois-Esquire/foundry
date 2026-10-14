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
temporary projects, so it needs registry access. Marbles checks its installed
library, TypeScript declarations, CLI, and the registry shared by CLI and config.
These tests do not require model credentials.

Marbles has a `prepack` hook for ordinary local packing. CI builds explicitly and
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
`typecheck`. Run one package directly with `bun run --cwd apps/marbles typecheck`,
or use `bun run typecheck --filter=@foundry/marbles` for Turbo filtering.

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

Bun's automatic `.env` loading is disabled in `bunfig.toml`. The root
[`.env.schema`](.env.schema) declares `AI_GATEWAY_API_KEY` as required and
sensitive. Put its value in the ignored `.env` file or provide it through the
process environment. Validate without printing the secret, then launch a
command with the validated environment:

```sh
bun run env:check
bun run env:run bun run marbles list
```

The `env:run` command accepts any command after its name. Marbles loads a
workspace's `.env.schema` through Varlock when there is one, with the
workspace's own `varlock` or one on `PATH`; the published package does not
depend on Varlock, and without a schema it inherits the environment of the
process that starts it. Declare task-specific environment inputs in Turbo when a
task begins using a secret.

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
on this repository's GitHub Pages. Its source lives in
[packages/docs/marbles](packages/docs/marbles/index.md). The `@foundry/docs`
workspace package owns Blume and its configuration. Pages live directly in the
package, and `blume.config.ts` names the content folders to publish.

```sh
bun run docs:dev
bun run docs:check
bun run docs:typecheck
bun run docs:build
```

These root commands delegate to the docs package through Turbo. The static
output is `packages/docs/dist/`; `packages/docs/.blume/` holds the generated
runtime. Both are ignored by Git. Stop the docs server before building because
the build regenerates its runtime.
The docs typecheck covers authored configuration and navigation.
Knip excludes `docs/marbles/use-cases/**/_example/**` because those files are
source snippets rendered by Markdown `<include>` elements, not executable
modules in the documentation application.

The CI documentation job builds and checks pull requests. On pushes to `main`,
or a manual CI run on `main`, it uploads `packages/docs/dist/` as the Pages
artifact.
A separate deployment job publishes that exact artifact using the `github-pages`
environment and Pages/OIDC permissions. It depends on the documentation build;
the other repository checks run independently.

Blume's deployment base is `/foundry`, matching the GitHub project site. Author
internal documentation links without that prefix; Blume applies it to routes,
assets, search, and canonical URLs. A local `docs:build` produces the site but
does not deploy it. GitHub Pages must use GitHub Actions as its publishing source.

## Versions and release PRs

[Release Please](https://github.com/googleapis/release-please) reads Conventional
Commits and maintains separate release PRs. `release-please-config.json` defines
the components; `.release-please-manifest.json` records versions after release
PRs merge. It starts empty because no component release has shipped yet.

- Marbles has its own version, changelog, and `marbles-vX.Y.Z` tags.
- Shared libraries form one `packages` component with `libraries-vX.Y.Z` tags.
  `packages/version.txt` and every library manifest advance together. The
  libraries remain private; their GitHub Releases do not publish them to npm.
- Atlas is excluded from release preparation until its rename. Other apps can
  be added as independent components when ready.

Marbles starts at **0.0.1 (alpha)**. Any `0.0.x` release can introduce breaking
changes. During alpha, `always-bump-patch` keeps releases on `0.0.x`, including
features and breaking changes. Use `!` and a `BREAKING CHANGE:` footer to keep
migration information in the release notes. The first supported API milestone
is a deliberate `0.1.0` release: change its versioning strategy to `default`,
set `prerelease` to `false`, and use a `Release-As: 0.1.0` commit footer. Review
and document the compatibility policy before merging that milestone.

Marbles lists Foundry libraries as `devDependencies`; its build inlines their
code. The release integration includes changes to those libraries since the
last **Marbles** release, independently of the libraries' own release boundary.
It does not add runtime dependencies or publish private packages. Changes to
unrelated libraries do not trigger a Marbles release.

The pinned Release Please dependency lives in `tooling/release`. Its small
workspace integration generates each proposed `bun.lock` by running Bun against
temporary copies of the updated manifests, with lifecycle scripts disabled.
It never edits the lockfile by hand. Internal dependency ranges remain
`workspace:*`. Changelogs are committed through release PRs; CI and publishing
never regenerate or overwrite them.

Bun 1.3.14 can retain older workspace-version metadata in `bun.lock` when only
versions change ([upstream issue](https://github.com/oven-sh/bun/issues/18906)).
Do not hand-edit it or re-resolve registry dependencies to fix that metadata.
The released package manifest and tested tarball must contain the selected
version, and the proposed manifests must still pass a frozen install. Bundled
Foundry development dependencies are not installed by package consumers.

`.github/workflows/release.yml` runs on `main` and supports manual dispatch.
It creates GitHub Releases for merged release PRs and prepares the next release
PRs. It has no npm publishing step, OIDC permission, or publish-workflow dispatch.
Merge a release PR when its version and release notes are ready, then inspect
the resulting GitHub Release before choosing to publish it.

The workflow uses `GITHUB_TOKEN`. Enable **Allow GitHub Actions to create and
approve pull requests** in the repository's Actions settings. When GitHub asks
for approval to run CI on an automation-created release PR, approve the workflows
from that PR; required checks must pass before merge. No personal npm token is
needed. The local `bun run release:prepare --dry-run` command builds proposals
without writing to GitHub, but requires `GITHUB_REPOSITORY`, `GH_TOKEN`, a current
`main` checkout, and the configuration already present on GitHub.

## Publishing an existing release

Publishing is a separate manual action in `.github/workflows/publish.yml`.
Only Marbles is enabled initially. Neither a tag push nor a GitHub Release
starts npm publication.

Publication is disabled until the repository Actions variable
`NPM_PUBLISH_ENABLED` is set to `true`. During the first release-review pass,
manual dispatch still resolves, builds, and tests the tarball, but skips the
publishing job. Enable it only after configuring the protections below.

1. Open **Actions → Publish Package → Run workflow** and select **main**.
2. Select `marbles`. Enter an exact version such as `0.0.1`, or leave it empty.
3. Review the resolved release, commit, and npm channel in the run summary.
4. After build, tests, and the tarball consumer test pass, approve the `npm`
   environment deployment to publish the tested artifact.

The equivalent CLI invocation is:

```sh
gh workflow run publish.yml --ref main -f package=marbles -f version=0.0.1
# Omit version to resolve the highest published version for Marbles.
gh workflow run publish.yml --ref main -f package=marbles
```

An omitted version means the highest SemVer from that package's **published
GitHub Releases**, including prereleases. Drafts, bare tags, and other packages'
releases are excluded. The resolver paginates all releases; it does not use
GitHub's repository-wide latest-release endpoint or fall back to `main` when a
release is missing. It verifies the tag's commit belongs to `main` and the
package at that commit has the expected name, version, and public status.

The build checks out the resolved commit SHA, performs a frozen install,
validates, builds, tests, and packs only the selected package. Its exact tarball
is tested in an isolated consumer. The publishing job has no checkout,
dependency installation, or dependency cache. It verifies the tarball digest
and manifest, rechecks that the release and tag have not changed during
approval, then runs `npm publish` on that tarball with `--ignore-scripts`.
Only the publishing job has `id-token: write`.

Marbles `0.0.x` uses the `alpha` npm channel and requires a GitHub prerelease.
Other prereleases use `next`; ordinary releases use `latest`. An explicit older
version selects that release exactly; check its channel before approval.
Already-published npm versions cause an error rather than being silently
skipped. npm versions cannot be overwritten. GitHub Releases remain available
if npm publication fails, so inspect the failure before retrying.

For local verification:

```sh
bun run release:check
bun run validate
bun run build
bun run test --concurrency=1
bun run release:pack --package marbles --version 0.0.1
```

Packing does not publish. Inspect `.cache/release/packages.json` and
`.cache/release/packages/000/package.tgz`. Remove only `.cache/release` before
repeating a pack; it refuses to reuse old artifacts. Without `--package`, local
packing checks every public workspace independently, including Atlas.

## Repository and npm protection

Before allowing publication:

- Protect `main` with required checks and review of the release paths in
  `.github/CODEOWNERS`. Control administrator bypass deliberately. Workflows
  selected from other branches are not allowed to publish.
- Restrict creation of `marbles-v*` and `libraries-v*` tags to the release
  identity; prevent tag updates and deletions. If using a dedicated GitHub App,
  scope it to this repository and grant its installation only the permissions
  needed for release PRs and tags.
- Create the GitHub **npm** environment, require the release maintainer as a
  reviewer, disable administrator bypass, and allow only the **main branch**.
  These are branch rules because this workflow is manually dispatched from
  `main`, even though the build checks out a release commit. Requiring an
  independent reviewer needs a second maintainer; configure self-review policy
  to match the maintainers available.
- Bind npm's trusted publisher to the repository, workflow, and environment
  below. Require 2FA and disallow traditional publishing tokens on npm.
- After reviewing the first GitHub Releases and configuring these controls,
  set the repository Actions variable `NPM_PUBLISH_ENABLED=true`.

| npm setting | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `Francois-Esquire` |
| Repository | `foundry` |
| Workflow filename | `publish.yml` |
| Environment | `npm` |
| Allowed actions | Direct `npm publish` |

The npm account needs access to the `@foundry` scope. Verify initial-publication
setup on npm before the first publish; adding a GitHub workflow does not reserve
a package name or configure npm trust. Newly configured trust currently needs
its first successful publication within two days, so set it up when ready.

The workflow uses Node 24 and requires npm >=11.5.1. It uses no `NPM_TOKEN`.
[Trusted publishing](https://docs.npmjs.com/trusted-publishers/) automatically
supplies provenance when the repository and package meet npm's eligibility
rules. That provenance identifies the dispatched workflow run; its invocation
commit is the selected `main` workflow revision. The separately resolved source
commit and tested tarball digest are recorded in the workflow summary. Local
checks cannot verify the GitHub-to-npm OIDC exchange.

## Enabling another package

Add the app's path and component to `release-please-config.json`, with its own
initial version and changelog. Add its publication identity to `resolve.ts`
and the manual workflow's package choices. Keep publication opt-in; setting
`private: false` alone never enables publishing. Configure the matching tag
protections and npm trusted publisher before dispatching it.

The public package needs complete package metadata, a `files` allowlist,
public `publishConfig`, and a `test:package` script that tests `PACKAGE_TARBALL`
when provided. The build must produce a standalone package. Private Foundry
implementation libraries can be bundled from development dependencies, as in
Marbles, but cannot remain unresolved runtime dependencies in the tarball.

When adding a shared library, include its manifest in the libraries component's
`extra-files`, align it with `packages/version.txt`, and keep it private until
its public packaging and compatibility policy are ready.
