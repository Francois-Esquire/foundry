# Browser and native scans

This file is outside the documentation build and the published package. The
website and documentation do not link to the browser scan page, and the page
asks search engines not to index it; its route is not access-controlled.

Spyglass uses shared analysis and dataset assembly with different input and
output adapters. The native adapter reads a local checkout and publishes a
dataset to disk. The browser adapter downloads a public GitHub revision,
analyzes its files in memory, and gives the resulting dataset to the existing
viewer.

The browser scan page is built for `/spyglass/scan/` on foundry.sh. This
describes the implementation and its tested build, not whether a particular
version has been deployed.

## The problem the shared pipeline solves

Analysis needs source text, package boundaries, entrypoints, compiler options,
ownership, and a module graph. Those facts do not inherently require a local
checkout. Reading manifests, resolving installed packages, querying Git, and
publishing files do require decisions about the host environment.

Spyglass prepares those inputs before running the shared package and workspace
calculations. Both hosts use the same package analysis, workspace derivation,
dependency-cruiser graph extraction, and dataset assembly. Discovery and
dependency-inventory rules accept readers supplied by the host. Native caching,
workers, locking, and atomic dataset publication remain in the native path.

| Concern | Native scan | Browser repository scan |
| --- | --- | --- |
| Source | Local checkout, including uncommitted files | Selected files at one resolved GitHub commit |
| Analysis | Shared package and workspace calculations | The same calculations over prepared in-memory inputs |
| Module graph | dependency-cruiser over the checkout | dependency-cruiser over an isolated in-memory filesystem |
| Dependency types | Installed dependencies and the native compiler environment | Declarations present in the supplied input and bundled standard libraries; no installation |
| Git history | Reads the checkout's history when available | Not fetched; evolution readings are unavailable |
| Spyglass configuration | Can run the checkout's configuration modules | Never executes repository configuration modules or scripts |
| Island internals | Can assemble per-package internal evidence | Not assembled |
| Output | Dataset files, incremental cache, atomic replacement | Instance-owned JSON artifacts behind a dataset transport |
| Viewer | Existing viewer reads saved datasets | Existing viewer reads the in-memory transport |
| Execution | Native processes and workers | Main thread, with yields between analysis steps |

The browser composition is internal implementation code, not an additional
export from the published library. See the [library reference](../../documentation/spyglass/reference/library.md)
for the supported public API.

## Keeping dependency-cruiser in the browser

dependency-cruiser reads through Node filesystem APIs, including synchronous
reads. Its existing public options do not replace every filesystem access.
Spyglass therefore adapts the dependency at build time rather than maintaining
a second import-graph extractor.

The analysis build supplies a private `memfs` volume and Node polyfills. Small
adapters restrict dependency-cruiser's dynamic parser and reporter loading;
repository-provided plugins cannot load. Each cruise populates the private
volume from the supplied map and clears it afterward, including on failure.
Cruises are serialized. Absolute imports, package resolution, and config
references cannot fall through to the host filesystem.

The same isolated cruise engine serves file-map analysis in Bun, which only
the tests use. A normal native checkout scan still uses the real filesystem. The adapter is confined to
the engine build, so it does not weaken the viewer's guard against Node builtin
imports. dependency-cruiser is pinned to the tested version because parts of
the adapter depend on its internal module layout.

## Acquiring a repository without a server

The page validates a public GitHub URL and optional ref and subdirectory before
loading the analysis engine. It does not start a scan from URL query parameters
alone; the person must press Scan.

The loader uses Octokit's request client to read repository information,
resolve the requested ref to a full commit SHA, and list that commit's tree.
It then downloads selected files from `raw.githubusercontent.com`, always using
that SHA. A branch moving during the download cannot mix revisions.

This is a source snapshot, not a Git clone. GitHub's API and raw-file endpoints
are the browser acquisition path. A browser Git library would still need
cross-origin permission for GitHub's Git transport; using a CORS proxy would
introduce a server into the data path. Spyglass uses no proxy, mirror, or
server-side analysis fallback.

A normal scan makes three API requests, followed by raw-file requests. A
truncated listing may require additional scoped tree requests or a smaller
scope. GitHub's unauthenticated API allowance is shared by network address;
the development acceptance runs used the 60-request-per-hour allowance.
Rate-limit, network, missing-repository, and bad-ref failures are reported, not
silently retried through another service.

The current provisional acquisition guardrails are:

| Limit | Default |
| --- | --- |
| Selected files | 5,000 |
| Selected bytes in total | 50,000,000 |
| Bytes per file | 1,000,000 |
| Tree entries | 100,000 |
| Concurrent file downloads | 6 |

These are bounds, not a claim that repositories at the maximum have been
tested. Oversized individual files, symlinks, submodules, `node_modules`, binary
content, and non-UTF-8 content are omitted and recorded. The loader selects
analysis inputs rather than every asset in a repository. Unless a scan names a
tsconfig, JavaScript modules below generated directories (`dist`, `build`,
`coverage` and the others native analysis skips) are not fetched and do not use
the file budget; they are counted with the files not selected for analysis.
TypeScript and JSON there are still read. A selected
path that cannot be placed safely, or that collides with another, rejects the
scan; an unselected file is only counted. A directory scope excludes files
outside that scope, including potential dependencies.

Downloaded bytes must match the size and Git blob SHA-1 from GitHub's listing.
That establishes consistency with the listing, not independent authenticity.
The browser does not install dependencies, run package scripts, or execute
downloaded configuration. Native configuration behavior is described separately
in [Configuration](../../documentation/spyglass/reference/configuration.md).

## Where results can differ

Sharing calculations does not give both hosts the same evidence.

**Types and resolution.** A native checkout can resolve installed declarations.
It can also pick up ambient type packages from its compiler environment. The
file-map program sees only its supplied files and declarations plus bundled
TypeScript libraries. It uses `types: []` unless a named tsconfig explicitly
declares types. Missing packages, missing declaration imports and reference
paths, and unresolved graph imports are reported. An unresolved type can reduce
the evidence available to symbol analysis; it is not proof that the dependency
has no types. The repository page does not install packages to fill those gaps.

**Configuration.** The shared engine can read an explicitly supplied tsconfig
as data and refuses invalid explicit configurations. The current repository
page has no tsconfig selector. An unnamed root tsconfig is not automatically
applied; the result's configuration metadata states which config was used.
Executable Spyglass configuration is not applied in the browser, so its domains,
rules, or exclusions can differ from a configured native scan.

**History and internals.** Browser scans do not fetch commit history or assemble
island internals. Churn and co-change readings are unavailable, and opening
file-level internal evidence shows the viewer's existing unavailable-internals
message. Missing readings must not be interpreted as zero activity or zero
coupling.

**Geometry.** JavaScript engines can return slightly different last digits for
trigonometric calculations used in map placement. Chromium and Bun have
produced small coordinate differences in `modules/index.json` and
`visualization/map.json`. Those values also affect derived visualization hashes.
The equivalence checks do not erase these geometry differences.

**Storage and currency.** The browser result lives in memory; this page does not
persist a native incremental cache. It records no native inputs fingerprint, so
currency checks report it unrecorded. Analysis metadata travels with serialized
artifacts in `analysis/metadata.json`; the dataset reader validates its version
and correspondence with the manifest. The result panel shows the pinned source,
acquisition omissions, and analysis gaps. These records describe provenance and
consistency, not a guarantee of complete analysis.

## Progress, cancellation, and performance

The page lazy-loads one self-contained analysis module on the first scan.
Each scanner owns at most one active scan and one published result. A valid
replacement aborts the previous scan; reset drops the result. Late callbacks
from a replaced scan cannot publish. An invalid replacement URL leaves the
active scan or displayed map alone.

Analysis runs directly on the page's main thread. It yields after preparation,
after each package, after derivation, and before assembly phases. Cancellation
is checked at these boundaries. A synchronous compiler or analysis step must
finish before the page can process cancellation or render another frame. No
Worker is required or used by the current page.

Development acceptance measurements recorded on November 9, 2026 used local
static hosting and headless Chromium with Workers disabled:

| Pinned input | Files downloaded | Analysis | Longest main-thread task |
| --- | --- | --- | --- |
| `sindresorhus/ky` at `3541888` | 103 | 2.9 s | 2.2 s |
| `changesets/changesets` at `2f6995d` | 199 | 4.1 s | 2.8 s |

The recorded analysis module was about 14.1 MB uncompressed and 3.1 MB gzipped,
including two TypeScript compiler versions used by the current dependencies.
These are bounded development observations, not latency, memory, or repository
size guarantees. Local asset loading does not model a public network. Large
repositories and the acquisition limits have not been established as a tested
performance envelope.

## What has been verified

Native preservation and browser acceptance answer different questions:

- Native before/after comparisons covered 37 fixture artifacts and 73 artifacts
  from a representative workspace. Canonical comparisons account for existing
  volatile timestamps, generation data, and runtime measurements. They establish
  preservation for those inputs, not universal equivalence between hosts.
- Graph acceptance compared dependency-cruiser in the browser and native
  runtime, including workspace aliases, multiple import forms, unresolved
  imports, and files outside the TypeScript program.
- The final browser acceptance run covered 18 cases against the built foundry.sh
  output, with Workers disabled. Sixteen used mocked GitHub responses; two used
  the pinned public repositories above. The cases cover viewer navigation,
  official-origin and pinned-commit requests, lazy loading, errors, cancellation,
  replacement, retry, reset, and keeping the current map.

Passing these checks does not establish all-language support, arbitrary host
support, byte-identical geometry across engines, or acceptable performance at
the acquisition maximums. The native CLI remains the option for installed
dependency types, executable workspace configuration, history, and internals.

## Run and verify locally

The scan page is one page of the foundry.sh Astro site
(`apps/website/src/pages/spyglass/scan.astro`). It renders Spyglass's React
scan page (`src/web/scan/scan-page.tsx`) in the browser only, outside the
site's layout, with the existing viewer. The site's build needs only
Spyglass's browser analysis asset, not the native package:

```text
@foundry/website#build
  └─ @foundry.sh/spyglass#build:analysis   scripts/build-analysis.ts → dist/analysis
@foundry.sh/spyglass#build                 scripts/build.ts → dist/lib, dist/web (packed)
@foundry.sh/spyglass#test
  ├─ build
  ├─ build:analysis
  └─ build:test-engine                     scripts/build-test-engine.ts → dist/engine
```

From the repository root, build the site:

```sh
bun run build --filter=@foundry/website
```

Then run `bun run preview` in `apps/website` and open `/spyglass/scan/` on
the printed address. For development, build the asset once, then run the
site's development server, which reloads the page's source:

```sh
bun run turbo run build:analysis --filter=@foundry.sh/spyglass
bun run --cwd=apps/website dev
```

Rebuild the asset after changing analysis code. The separate browser suite
builds and tests the website's actual output:

```sh
bun run turbo run test:browser --filter=@foundry.sh/spyglass
```

It requires a matching Chromium installation. Its live tests need GitHub access
and consume API budget, so this suite is separate from the default Vitest run.
See [Contributing](../../documentation/spyglass/contributing.md) for browser setup and the native test
commands.

## Build and acceptance setup

`build:analysis` writes `dist/analysis/spyglass-analysis.js`, one
self-contained module holding the GitHub loader, TypeScript, ts-morph and
dependency-cruiser. The page imports it with Vite's `?url` suffix
(`src/web/scan/load-analysis.ts`), so the site's build copies it as a hashed
file under `/_astro/` and the page loads it by that URL on its first scan.
The site's client build runs Spyglass's Node-builtin guard
(`scripts/no-node-builtins.ts`) and its `.wgsl` loader. Neither the asset nor
the page is in the published package, and `build` never builds them.

`build:test-engine` writes `dist/engine`, the isolated cruise engine that
`#file-map-cruise-engine` names under Bun. Only the default `test` task
loads it.

`bun run turbo run test:browser --filter=@foundry.sh/spyglass` builds the
website, then runs the scan page's acceptance suite in Chromium through
`playwright-core`, with Workers disabled, against the website's built output
at `/spyglass/scan/`: one file against a mocked GitHub, and one that scans
pinned public repositories on GitHub. The second needs the network and
spends about 3 of GitHub's 60 unauthenticated API requests an hour per scan,
so neither runs in `test`. If Chromium is missing, install the matching
browser with `bunx --no-install playwright-core install chromium` from
`apps/spyglass`.
