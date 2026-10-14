# Release tooling

Release Please owns versions, changelogs, release PRs, and GitHub Releases.
GitHub Actions owns the build, asset upload, and optional npm publication.
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

`release-assets.yml` builds released source and uploads both archives. It also
supports backfilling an existing release without changing its version:

```sh
gh workflow run release-assets.yml --ref main -f package=marbles -f version=0.0.1
```

For Marbles 0.0.1 backfills, the workflow applies the current `files` allowlist
before packing; source, build, dependencies, name, and version come from the tag.

`publish.yml` downloads and verifies those assets, reuses the released consumer
tests, and publishes the same tarballs with npm trusted publishing after approval.
It never rebuilds them. Publication remains gated by `NPM_PUBLISH_ENABLED` and the
`npm` environment. See [CONTRIBUTING](../../CONTRIBUTING.md#repository-and-npm-protection)
for the npm-side setup. Local tests cannot verify the OIDC exchange.
