# `@foundry/modules`

`@foundry/modules` defines the Artifact-backed Module domain and the contracts used to
package, install, and connect Module programs to host capabilities. The package includes
a deterministic in-memory Store, project management, source capture, container
orchestration, and Program supervision. Hosts pass configured Artifacts, Store,
container registry, transport, and capability providers. Compilation and agent
execution are separate.

- [Glossary](GLOSSARY.md) defines Module language and its boundaries.
- [Architecture](ARCHITECTURE.md) explains the model, ownership, flows, and safe change.

## Resolve a version

A Module has stable identity separate from its backing Artifact. A version is a frozen,
SemVer-tagged Content of that Artifact; nothing else persists it.

```ts
import type { Artifacts, ContentId } from "@foundry/artifacts";
import type { ModuleId } from "@foundry/modules/domain";
import type { ModuleStore } from "@foundry/modules/store/contract";
import { createModuleVersions } from "@foundry/modules/version";

export async function loadVersion(
  artifacts: Artifacts,
  store: ModuleStore,
  moduleId: ModuleId,
  contentId: ContentId,
) {
  const versions = createModuleVersions({ artifacts, store });
  return versions.load({ moduleId, contentId });
}
```

`load` returns `null` when the Module or Content does not exist and throws
`ModuleManifestValidationError` for mutable Content, missing or invalid SemVer tags,
Content of another Artifact, a missing or invalid Manifest, Manifest paths absent from
the Content Tree, and runnable `outputs/` entries that are not files or directories.
`list` returns the valid versions in Content id order.

The Manifest comes from `source/foundry.module.json` inside the Content. A Content that
cannot supply it keeps a retained manifest in the Store: an output-only import, or a
legacy version whose stored manifest differs from its embedded source. A retained
manifest outranks the embedded one, and frozen bytes are never rewritten.
`pruneRetainedManifests` drops only rows the Content reproduces.

## Work with installations

An Installation selects one version by `contentId`. The Store refuses a Content that does
not belong to the Module's Artifact. It starts disabled with
generation `0`. Lifecycle beginnings and version selection increment the generation;
settlement keeps it. Every change to an existing Installation presents the generation
it observed, so stale callers receive `ModuleStoreConflictError` instead of overwriting
newer state.

`containerId` starts `null` and identifies the installation's registry container.
`setInstallationContainerId` checks the generation without incrementing it.

Failed starts increment `startAttempts`. Reaching `active`, an explicit user start, or a
version change resets the counter. `MAX_START_ATTEMPTS` is the recovery ceiling shared
with the platform supervisor.

Capability requests in a Manifest are not authority. `preflightModuleActivation`
reports requested capabilities the host does not provide and separately returns
capabilities that still need Grants. The Store keeps the exact approved Grant set for
each Installation.

## Import source modules

The package has no barrel entry points. Import each API from the source module that
defines it, as `@foundry/modules/<path>` for `src/<path>.ts`:

| Role     | Modules under `@foundry/modules/`                                                                                         | Use                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Domain   | `domain`, `manifest`, `version`, `store/contract`, `store/memory`, `preflight`, `package`, `projects`, `management`, `source` | Domain, Store, versions, packages, projects, source capture, Installation management, and declared Views                  |
| Gateway  | `gateway/module-gateway`, `gateway/types`, `gateway/catalog`, `gateway/runtime-dispatcher`, `gateway/generator`          | Host Gateway, protocol types, capability catalog, runtime dispatcher, and generated Program client                        |
| Platform | `platform/system`, `platform/program-supervisor`, `platform/runtime-recovery`, `platform/container-runtime`, `platform/files` | System composition, container acquisition, Program supervision, cleanup, recovery, and portable filesystem contracts      |
| Node     | `node/system`, `node/source`, `node/checkouts`, `node/installation-files`, `node/application-recovery`                    | System composition with disk adapters, source capture, checkouts, Installation files and backup, and recovery observation |
| Template | `template/compose`, `template/upgrade`                                                                                    | Compose a Module workspace from a `ModuleBase` and upgrade composed workspaces                                            |
| Testing  | `testing/module-store-conformance`                                                                                        | Run the shared `ModuleStore` conformance suite against an adapter                                                         |

The package has no durable Store adapter, sandbox backend, or network provider.
`InMemoryModuleStore` is the reference Store. A durable adapter implements
`ModuleStore` and proves itself with `describeModuleStoreConformance`. The host
supplies the runtime and provider implementations.

## Compose a Module system

`createModuleSystem` from `@foundry/modules/platform/system` composes management,
Gateway, invocation dispatch, container acquisition, supervision, and recovery. Its
`ModuleCheckouts` and `ModuleInstallationFiles` contracts require no Node imports.
`createModuleSystem` from `@foundry/modules/node/system` supplies disk
implementations from explicit roots:

```ts
import { createModuleSystem } from "@foundry/modules/node/system";

const system = createModuleSystem({
  artifacts,
  store,
  containers,
  containerRuntime,
  transport,
  providers,
  checkoutsRoot,
  files: { root: filesRoot, snapshotDatabase },
});
```

Options contain the existing `artifacts`, `store`, `containers`, their
`containerRuntime`, `transport`, and `providers`; `checkoutsRoot` and
`files: { root, snapshotDatabase }` configure the Node adapters. Neither composition
creates storage engines or installs a sandbox backend. Construction starts no
Program. The host runs recovery explicitly and releases Programs before shutting
down its shared container registry.

`system.modules` creates projects from supplied source, imports packages, manages
installations, and resolves declared Views as identity, path, and title. The host
supplies URLs and presentation. `system.programs` controls Program lifetimes;
`selectVersion` requires a stopped Installation. `system.gateway` admits connections
and `system.invocations` handles capability dispatch and revocation. Persist Grant
changes before invoking revocation. Capability checks and user approval remain
host workflows using the package's preflight and provider contracts.

`createModuleProjects` accepts Artifacts and Store directly when only authoring is
needed. Cross-store creation requires a shared transaction coordinator for
atomicity, just like import.

`captureModuleWorkspaceSource(filesystem, root)` from `@foundry/modules/source` uses
its `ModuleSourceFileSystem` interface. `@foundry/modules/node/source` exposes the same
operation as `captureModuleWorkspaceSource(root)`. Capture excludes generated files, credentials,
and databases while retaining `bun.lock` and the authored SDK. Saves use a
`ModuleSourceBinding` containing Artifact ID, Content ID, and revision. Saving frozen
source creates editable Content and removes stale outputs without rewriting the
released Content. Reads refuse corrupt blobs, unsupported entries, and invalid UTF-8.
Editor saves accept incomplete Manifest edits; creation and version resolution
validate the Manifest. Workspace upgrades remain explicit through
`upgradeModuleWorkspaceSource` in `@foundry/modules/template/upgrade`.

## Compose a Module workspace

`composeModuleTemplate` in `@foundry/modules/template/compose` builds a Module
workspace from a `ModuleBase`: an `id`, a `name`, a file tree, and optional agent
`instructions`. The base becomes `packages/app`; the composer adds the server,
database, SDK, and workspace files and records the base digest and SDK version in
`.foundry/provenance.json`. `moduleTemplateBaseIssue` applies the same rule up front:
the base needs a valid `package.json` with a non-empty `scripts.build`, no
`workspaces`, and no files under composer-owned paths. Choosing which bases to offer
is the caller's concern.

## Package and move a Module

`encodeModulePackage` writes canonical `foundry.module/3` JSON containing one Module,
its Artifact identity, frozen Content Tree and blobs, SemVer tag, Manifest, and integrity
digests. `importModulePackage` validates the complete envelope before writing. A package
whose tree embeds `source/foundry.module.json` must agree with its envelope Manifest or
the import is refused; a package with no embedded source has its envelope Manifest
retained in the Store.

Export refuses a retained legacy Manifest that disagrees with embedded source.
That version remains runnable with its approved capabilities, but cannot be moved
in this package format without resolving the disagreement.

Import creates the Module Artifact when absent, reuses an identical tagged Content
version, or explicitly revises frozen Content and freezes the successor. Ready Content
keeps its identity on replacement. Artifact and Module writes nest through
their Store transactions. They are atomic only when both adapters share one transaction
coordinator.

## Gateway boundary

The runtime Gateway admits an invocation only when the host-bound runtime identity still
matches the Installation's selected Content and generation, the Installation is starting or
active, the Manifest declares the alias, a provider matches its capability and mode,
input validation passes, and the resolved constraints digest matches a stored Grant.
The provider runs only after those checks.

Cancellation and disconnect abort active provider work. The host persists Grant
revocation before calling the runtime dispatcher's `revoke` operation, which aborts
matching work. Gateway failures use bounded public codes and do not expose provider
errors. Development sessions exchange capability catalogs but cannot invoke runtime
providers.

## Development

A host creates Module source directly in its Artifact. A development container
installs dependencies and captures authored files plus `bun.lock` back into Content.
Saves compare the Content ID and revision captured when the workspace opened. Builds
consume that saved Content and refuse concurrent source changes. Editing and
building use saved Artifact source exclusively.

A host composes the Module system with its own Store, container registry, filesystem
adapters, transport, and providers. Workspace upgrades, compilation, activation
approvals, and URL projections stay in the host. The Module system can install an
imported version without a compiler, development workspace, or agent runtime.

Run checks from the repository root:

```bash
bun run --cwd=packages/modules test
bun run --cwd=packages/modules typecheck
bun run --cwd=packages/modules build
./node_modules/.bin/biome check packages/modules
```

`test` runs the unit project. The generated-workspace integration test installs,
builds, and serves a composed workspace with real processes; run it on purpose with
`FOUNDRY_RUN_GENERATED_MODULE_WORKSPACE=1 bun run --cwd=packages/modules test:integration`.

`bun run --cwd=packages/modules emit-sdk` rewrites checked-in generated SDK output in
`src/sdk/emitted.ts` and `src/sdk/generator-source.ts`, then formats both with Biome.
Run it only when the authored SDK source or generator changes. Tests verify emitted
parity, Store conformance, package integrity, Gateway admission, and the package
import boundary.
