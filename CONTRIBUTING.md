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

Marbles and Spyglass have `prepack` hooks for ordinary local packing. CI builds
explicitly and uses `--ignore-scripts` during packing and publishing to preserve
the tested build.

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
| `bun run dev:marbles` | Run the Marbles CLI from source in watch mode |
| `bun run dev:spyglass` | Scan Foundry and open Spyglass with hot reload |
| `bun run dev:spyglass:package` | Scan Spyglass as a standalone package and open with hot reload |

`check-types` remains an alias for `typecheck`. New package scripts use
`typecheck`. Run one package directly with `bun run --cwd apps/marbles typecheck`,
or use `bun run typecheck --filter=@foundry.sh/marbles` for Turbo filtering.

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

Pull requests and every push to `main` run one CI workflow whose jobs run in
parallel, each on its own runner. **Validate** runs `bun run validate`, so
documentation types are checked with the other workspaces. **Test Spyglass**
splits Spyglass's suite into three Vitest shards, and **Test packages** tests
the rest; on pull requests both test only changed packages and their dependents
using Turbo's affected graph. **Release archives** builds every package, tests
release/workflow policy, and checks public packages and their tarballs in
isolated consumers. **Documentation** validates links and builds the docs site.

Each job except **Release archives** restores and saves its own Turbo cache
through GitHub Actions; pull requests also read `main`'s caches. **Release
archives** restores none, so the archives it uploads are built from source.

Branch protection requires **Verify** from GitHub Actions with the branch
up to date. **Verify** passes only when every other job passes. It replaces the
former **Repository checks** and **Package build and test** requirements.

CI uses a frozen install and read-only repository permissions, cancels superseded
PR runs, and requires no secrets. Runs on `main` and manual runs test every
package. A run on `main` is never cancelled by a newer push: it uploads its
tested archives as the `release-packages` artifact, kept for 90 days, and those
archives are what a release of that commit attaches and npm receives. Pushes to
`main` also deploy documentation. npm publishing has its own workflow and
permissions.

The pre-commit hook checks staged paths. Use `bun run prepare` to install it.
It does not replace full validation. Dependabot checks GitHub Actions weekly.

Work on a branch in its own worktree under `.worktrees/` (AGENTS.md gives the
`worktree-path` setting): create it with `wt switch --create <branch>` and land
it with `wt merge`. [`.config/wt.toml`](.config/wt.toml) copies ignored files
from the primary checkout into a new worktree and installs dependencies there.
It also runs `bun run validate` before `wt merge`, because CI checks a direct
push to `main` only after it lands.

## Documentation

The [documentation site](https://francois-esquire.github.io/foundry/) is hosted
on this repository's GitHub Pages. Its source lives in
[apps/documentation/marbles](apps/documentation/marbles/index.md), [apps/documentation/spyglass](apps/documentation/spyglass/index.md),
and [apps/documentation/prompts](apps/documentation/prompts/index.md). The `@foundry/docs`
workspace package owns Blume and its configuration. Pages live directly in the
package, and `blume.config.ts` names the content folders to publish.

```sh
bun run docs:dev
bun run docs:check
bun run docs:typecheck
bun run docs:build
```

These root commands delegate to the docs package through Turbo. The static
output is `apps/documentation/dist/`; `apps/documentation/.blume/` holds the generated
runtime. Both are ignored by Git. Stop the docs server before building because
the build regenerates its runtime.
The docs typecheck covers authored configuration and navigation.
Knip excludes `apps/documentation/marbles/use-cases/**/_example/**` because those files are
source snippets rendered by Markdown `<include>` elements, not executable
modules in the documentation application.

The CI **Documentation** job validates documentation without deployment
permissions.
The separate **Deploy documentation** workflow runs on pushes to `main` or manual
dispatch from `main`. Its **Build Pages artifact** job checks and builds `apps/documentation/dist/`;
**Publish Pages** deploys that exact artifact using the `github-pages` environment
and Pages/OIDC permissions. It does not rerun repository or package checks.

Blume's deployment base is `/foundry`, matching the GitHub project site. Author
internal documentation links without that prefix; Blume applies it to routes,
assets, search, and canonical URLs. A local `docs:build` produces the site but
does not deploy it. GitHub Pages must use GitHub Actions as its publishing source.

## Versions and release PRs

[Release Please](https://github.com/googleapis/release-please) reads Conventional
Commits and maintains separate release PRs. `release-please-config.json` defines
the components; `.release-please-manifest.json` records versions after release
PRs merge.
`always-update` refreshes open release PRs from `main` even when release notes
are unchanged, so CI and release-tooling fixes reach those branches.

- Marbles and Spyglass have independent versions, changelogs, and `marbles-vX.Y.Z`
  / `spyglass-vX.Y.Z` tags.
- All libraries under `packages/` share the version in their `package.json`
  files. They are currently private, with no library release PRs or publication.
- When libraries become public, Release Please's built-in `linked-versions`
  plugin keeps their versions together in one release PR. Each public library
  gets its own component tag and GitHub Release at that same version. Private
  library manifests stay aligned but do not get tags, releases, or npm artifacts.
  Marbles and Spyglass stay outside that group.

Marbles and Spyglass start at **0.0.1 (alpha)**. Any `0.0.x` release can
introduce breaking changes. During alpha, `always-bump-patch` keeps releases
on `0.0.x`, including features and breaking changes. Use `!` and a `BREAKING CHANGE:` footer to keep
migration information in the release notes. The first supported API milestone
is a deliberate `0.1.0` release: change its versioning strategy to `default`,
set `prerelease` to `false`, and use a `Release-As: 0.1.0` commit footer. Review
and document the compatibility policy before merging that milestone.

Marbles lists Foundry libraries as `devDependencies`; its build inlines their
code. The release integration includes changes to those libraries since the
last **Marbles** release, without releasing or versioning the libraries again.
It does not add runtime dependencies or publish private packages. Changes to
unrelated libraries do not trigger a Marbles release.

The pinned Release Please dependency lives in `tooling/release`. Release PRs
change versions, changelogs, and `.release-please-manifest.json`; they do not
touch `bun.lock`. Internal dependency ranges remain `workspace:*`. Changelogs
are committed through release PRs; CI and publishing never regenerate or
overwrite them.

Bun 1.3.14 retains older workspace-version metadata in `bun.lock` when only
versions change ([upstream issue](https://github.com/oven-sh/bun/issues/18906)),
and a frozen install accepts it, so release PRs leave the lockfile alone. Do not
hand-edit it or re-resolve registry dependencies to fix that metadata. Bun packs
`workspace:` ranges from that metadata, so packing refuses a dependency range
that excludes a package released alongside it. The released package manifest and
tested tarball must contain the selected version. Bundled Foundry development
dependencies are not installed by package consumers.

`.github/workflows/release.yml` runs when CI passes for a push to `main`, and
supports manual dispatch. When `main` has already moved on, it leaves the work
to the CI run of the newer commit. It creates GitHub Releases for merged release
PRs and prepares the next release PRs, so releases are cut only from a green
`main`. After the release assets are attached, it dispatches `publish.yml` on `main` with
that exact package and version. The dispatch job has only `actions: write` and
`contents: read`; release preparation has no npm publishing step or OIDC
permission. Merge a release PR when its version and release notes are ready,
then approve the protected `npm` environment to publish its tested artifact.

The workflow uses `GITHUB_TOKEN`. Enable **Allow GitHub Actions to create and
approve pull requests** in the repository's Actions settings. When GitHub asks
for approval to run CI on an automation-created release PR, approve the workflows
from that PR; required checks must pass before merge. No personal npm token is
needed. The local `bun run release:prepare --dry-run` command builds proposals
without writing to GitHub, but requires `GITHUB_REPOSITORY`, `GH_TOKEN`, a current
`main` checkout, and the configuration already present on GitHub.

## Publishing an existing release

Merging a release PR automatically starts `.github/workflows/publish.yml`
after CI passes for the merge commit and its tested archives are attached to
the GitHub Release. Publication waits for
the protected `npm` environment approval. Bare tag pushes and manually created
GitHub Releases do not start publication. Manual dispatch remains available for
Marbles, Spyglass, or the public library group; the library choice refuses to
run while all libraries remain private.

Publication runs only while the repository Actions variable
`NPM_PUBLISH_ENABLED` is `true`, as it now is. Without it, dispatch still
resolves, downloads, and tests the release artifacts, but skips the publishing
job. Enable it only after configuring the protections below.

To publish an existing release manually:

1. Open **Actions → Publish Package → Run workflow** and select **main**.
2. Select `marbles`, `spyglass`, or `libraries`. Enter an exact version, or leave
   it empty for the highest released version. Library component releases must
   share the selected version and source commit.
3. Review the resolved release and commit in the run summary.
4. After the downloaded archives pass verification and consumer tests, approve
   the `npm` environment deployment to publish the tested tarballs.

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

The version bump lands in source through the release PR, so its merge commit is
both the commit Release Please tags and the commit CI builds. CI's
`release:pack` runs Bun's pack command, creates ZIPs from the exact packed
files, compares npm's pack file list, and runs existing `test:package` checks.
After Release Please creates GitHub Releases, `release-assets.yml` finds the
successful CI push run of `main`, or manual CI recovery, at the tagged commit, downloads its
`release-packages` artifact, verifies each archive's identity and recorded
SHA-256 digest, and attaches both versioned archives to each corresponding
GitHub Release. It never builds or packs. Pull request runs and other workflows are never accepted. Manual CI requires
the selected commit to be an ancestor of `main`.

If CI for the release commit is still running or failed when the release is
created, attaching fails and names the commit; re-run CI for that commit, then
re-run the failed jobs. To attach assets to an existing release by hand, run
`gh workflow run release-assets.yml --ref main -f package=marbles -f version=0.0.3`.
A rerun confirms archives that are already attached and never replaces them.
If the CI artifact has expired, dispatch CI at the exact release tag:
`gh workflow run ci.yml --ref marbles-v0.0.3`. CI rebuilds, tests and uploads
fresh archives for that same commit. Wait for it to pass, then dispatch
`release-assets.yml` as above. The release tag must contain this CI recovery
workflow; do not dispatch at current `main` to recover an older release.
Existing attached archives are still compared and never overwritten, even if a
recovery build produces different bytes. Releases from before this flow already
carry their assets.

Publishing downloads those existing assets; it does not rebuild or repack.
Consumer tests from the released commit run against the downloaded tarballs.
The isolated publishing job verifies their identities and SHA-256 digests,
rechecks every release and tag after approval, and publishes those same tarballs
in dependency order with lifecycle scripts disabled. Only that job has
`id-token: write`; it has no checkout, dependency installation, or cache.

Every publication uses npm's `latest` dist-tag. A `0.0.x` version is the
project's alpha stage, not an npm channel, and the GitHub prerelease badge does
not change the tag. An explicit older version selects that release exactly and
still moves `latest` to it, so check the current npm version before approving.
Already-published npm versions cause an error rather than being silently
skipped. npm versions cannot be overwritten. GitHub Releases remain available
if npm publication fails, so inspect the failure before retrying.

For local verification:

```sh
bun run release:check
bun run validate
bun run build
bun run test --concurrency=1
bun run release:pack --package marbles
```

`--version` is optional and must match the package's current version. Packing
does not publish. Inspect `.cache/release/packages.json` and
the versioned `.tgz` and `.zip` files under `.cache/release/packages/`. Remove only `.cache/release` before
repeating a pack; it refuses to reuse old artifacts. Without `--package`, local
packing checks every public workspace independently, including Spyglass.

## Repository and npm protection

Before allowing publication:

- Protect `main` with required checks and review of the release paths in
  `.github/CODEOWNERS`. Control administrator bypass deliberately. Workflows
  selected from other branches are not allowed to publish.
- Restrict creation of `marbles-v*`, `spyglass-v*`, and public library component
  tags to the release identity; prevent tag updates and deletions. If using a dedicated GitHub App,
  scope it to this repository and grant its installation only the permissions
  needed for release PRs and tags.
- Create the GitHub **npm** environment, require the release maintainer as a
  reviewer, disable administrator bypass, and allow only the **main branch**.
  These are branch rules because the publisher runs on
  `main`, even though the build checks out a release commit. Requiring an
  independent reviewer needs a second maintainer; configure self-review policy
  to match the maintainers available.
- Bind npm's trusted publisher to the repository, workflow, and environment
  below. Require 2FA and disallow traditional publishing tokens on npm.
- The repository Actions variable `NPM_PUBLISH_ENABLED=true` turns on npm
  publication; it has been set since the first releases were reviewed.

| npm setting | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `Francois-Esquire` |
| Repository | `foundry` |
| Workflow filename | `publish.yml` |
| Environment | `npm` |
| Allowed actions | Direct `npm publish` |

Configure this publisher on each npm package. The account needs access to
`@foundry.sh` for Marbles and Spyglass and `@foundry` for future public
libraries. Verify initial-publication setup on npm before the first publish of
a new package; adding a GitHub workflow does not reserve
a package name or configure npm trust. Newly configured trust currently needs
its first successful publication within two days, so set it up when ready.

The workflow uses Node 24 and requires npm >=11.5.1. It uses no `NPM_TOKEN`.
[Trusted publishing](https://docs.npmjs.com/trusted-publishers/) automatically
supplies provenance when the repository and package meet npm's eligibility
rules. That provenance identifies the dispatched workflow run; its invocation
commit is the selected `main` workflow revision. The separately resolved source
commit and tested tarball digest are recorded in the workflow summary. Local
checks cannot verify the GitHub-to-npm OIDC exchange.

## Publishing the VS Code extension

`tooling/vscode-extension` is a Release Please component of its own,
`vscode-extension`, tagged `vscode-extension-v<version>`. Its manifest entry
of `0.0.0` means unreleased, so the first release is `0.0.1`; each later
release bumps the patch. Only commits that touch the extension's directory
reach its changelog, and the VSIX ships that changelog. Extension releases
are not GitHub prereleases, so the newest one carries GitHub's **Latest**
label. The workspace package is private and never goes to npm.

CI's `release` job builds `dist/prompts.vsix` and `dist/extension.json`,
tests that exact archive, and keeps both as the `release-extension` artifact
for 90 days. The record holds the Marketplace identity `foundry-sh.prompts`,
version, source commit, whether the sources were committed, and the VSIX
SHA-256 digest. After Release Please creates the GitHub Release:

1. **Prepare Releases** calls `extension-release.yml`. It checks that the tag
   is a published release on a `main` commit, downloads the artifact from
   successful CI at that commit, verifies it, and attaches any missing file.
   It never rebuilds or replaces an attached file. When both files are
   already attached, it verifies them alone, without CI's artifact.
2. After attachment succeeds, Prepare Releases dispatches
   `marketplace-publish.yml` on `main` with the exact version. That workflow
   dispatches nothing itself.
3. The publisher verifies the attached files again. Its `publish` job runs
   only while the repository Actions variable `MARKETPLACE_PUBLISH_ENABLED`
   is `true`, and waits for the `marketplace` environment approval. It
   rechecks the digest, tag, and release, installs locked dependencies
   without lifecycle scripts, and runs
   `vsce publish --packagePath … --oidc --skip-duplicate` on the released VSIX.

`--skip-duplicate` makes a repeated dispatch or rerun succeed without
publishing, because the Marketplace already has that version. It also skips
if someone uploaded a different build under the same version, so publish
only through this workflow or the attached VSIX.

To recover by hand, from `main`:

```sh
# Attach and verify assets without publishing.
gh workflow run extension-release.yml --ref main -f version=0.0.1
# Verify again, then wait for approval and publish.
gh workflow run marketplace-publish.yml --ref main -f version=0.0.1
```

If a release lacks an attached file and CI's artifact has expired, run
`gh workflow run ci.yml --ref vscode-extension-v0.0.1`, wait for it to pass,
then dispatch attachment again. A rebuild differs in bytes, so it can supply a
missing pair, but it cannot replace one already attached.

One-time setup before enabling publication:

1. Create the GitHub **marketplace** environment, allow only the **main**
   branch, and add required reviewers. GitHub pauses a job for approval only
   when the environment has that protection rule.
2. On the Marketplace publisher management page, open publisher `foundry-sh`,
   select **Trusted Publishing**, and create a policy with repository owner
   `Francois-Esquire`, repository `foundry`, workflow
   `marketplace-publish.yml`, and environment `marketplace`. No personal access
   token is needed.
3. Restrict creation of `vscode-extension-v*` tags to the release identity,
   as for the npm components.
4. Set the repository Actions variable `MARKETPLACE_PUBLISH_ENABLED=true`.
   Until then the publisher verifies the release and skips the `publish` job.

Microsoft's
[publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
does not say whether a trusted publishing policy can publish an extension's
first version. If the first run fails, upload the attached `prompts.vsix` on
the publisher management page; later releases then publish through the
workflow. Local tests cannot verify the OIDC exchange.

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

When adding a shared library, align its version with the other library manifests.
Keep it private until its packaging and compatibility policy are ready. Public
libraries are discovered automatically and joined to the linked-version group.
Each needs a standalone package, a consumer check, and its own npm trusted
publisher before publication. Group consumer checks receive `PACKAGE_TARBALLS`
as a JSON map of package names to local archives, so unpublished sibling versions
can be installed together without relying on the registry.
