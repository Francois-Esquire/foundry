# Release tooling

Release Please owns versions, changelogs, release PRs, and GitHub Releases.
CI owns the build: every push to `main` packs and tests the public packages and
keeps the archives as the `release-packages` artifact. Releases attach those
archives, and npm publication publishes them; neither rebuilds.
This private workspace holds the reusable packaging and verification code.

```ts
import { createZipArchive, verifyReleaseArchives } from "@foundry/release/archives";

// Works with an existing npm- or Bun-packed tarball.
createZipArchive(tarball, zip);
verifyReleaseArchives({ tarball, zip });
```

`createReleaseArchives(packageRoot, destination)` runs `bun pm pack --ignore-scripts`,
keeps its versioned filename, creates the matching ZIP, compares paths, bytes,
and permissions, and checks npm's pack file list. Package manifests decide what
ships; the release package has no app-specific distributable file list.

From the repository root:

```sh
bun run build --filter=@foundry.sh/marbles
bun run release:pack --package marbles --version 0.0.1
```

Packing runs the existing package-consumer tests with `PACKAGE_TARBALL`. A group
also receives `PACKAGE_TARBALLS`, a JSON name-to-tarball map. Outputs and their
hashes are recorded in `.cache/release/packages.json`; the versioned archives
live under `.cache/release/packages/`. Remove `.cache/release` before repacking.
Bun, npm, tar, zip, and unzip must be available.

`release-assets.yml` runs `cli.ts collect`: it takes a successful main push or
manual CI recovery at the release's tagged commit, downloads its `release-packages`
artifact, checks each archive's identity and recorded SHA-256 digest, and
attaches the archives. It can attach assets to an existing release whose
artifact has not expired, without changing its version, and never replaces
archives already attached:

```sh
gh workflow run release-assets.yml --ref main -f package=marbles -f version=0.0.3
```

If the artifact has expired, run `gh workflow run ci.yml --ref marbles-v0.0.3`,
wait for CI to pass, then dispatch attachment as above. Manual CI requires the
commit to belong to `main` and uploads the same artifact as push CI. Dispatch
at the release tag, which must contain the recovery workflow, rather than at
current `main`. Recovery never replaces archives already attached to a release.

`publish.yml` downloads and verifies those assets, reuses the released consumer
tests, and publishes the same tarballs with npm trusted publishing after approval.
It never rebuilds them, and always publishes to npm's `latest` dist-tag. After a
release PR merges, CI passes, and its assets are attached, `release.yml`
automatically dispatches this publisher with the exact component and version.
Manual dispatch remains available for existing releases.
Publication remains gated by `NPM_PUBLISH_ENABLED` and the
`npm` environment. See [CONTRIBUTING](../../CONTRIBUTING.md#repository-and-npm-protection)
for the npm-side setup. Local tests cannot verify the OIDC exchange.
