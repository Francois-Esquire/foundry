# Modules architecture

`@foundry/modules` owns Module-domain values and host contracts. It depends on
`@foundry/artifacts` for versioned files. Its Template role composes workspaces from a
structural `ModuleBase` it defines itself. Its platform role owns runtime
orchestration; durable Store adapters, storage engines, and sandbox backends remain
outside the package.

Start with the [glossary](GLOSSARY.md) for exact terms and the [README](README.md) for
consumer use.

## Model

```text
Module ──backed by──> Module Artifact
  │                       │
  │                       │ owns frozen, SemVer-tagged Content = a version
  │                       v
  └──── Installation selects one by contentId
          │
          │ realized at one generation
          v
        runtime identity (host-bound)
  │                                               │
  │ Installation owns Grants                      │ connects
  v                                               v
Capability authority <────admitted by──── Module Gateway ────> Provider
```

Module and Artifact identity stay separate even though each Store enforces a one-to-one
relationship. A Module can exist before its first version. A version is not stored: it
is a frozen, SemVer-tagged Content, resolved and re-validated by `createModuleVersions`
each time it is needed. Its Manifest is the Content's own `source/foundry.module.json`,
unless the Store retains one for a Content that cannot supply it.

An Installation selects one Content and keeps one status, a failed-start counter,
generation, and nullable container ID. Linking a container checks the generation
without changing it. A runtime identity copies the selected Content and generation when
the host starts a Program. The Gateway refuses it after either changes.

## Ownership

```text
@foundry/artifacts ───> @foundry/modules <── consumers
                              │
                   contracts implemented by
                              v
              host adapters (Store, transport, providers)
```

### `@foundry/modules`

The package owns:

- Module, version, Installation, Manifest, and Grant values;
- version resolution from pinned Content, including retained-manifest precedence;
- domain validation and activation preflight;
- the `ModuleStore` contract and deterministic in-memory reference adapter;
- Module Package encoding, validation, and import;
- Gateway protocol, sessions, admission, provider contracts, and client generation;
- Module workspace composition from a `ModuleBase` and composer-owned workspace
  upgrades;
- Artifact-backed project creation, source capture and fenced saves, Installation
  management, and declared View discovery;
- container acquisition and spec refresh through injected Sandbox contracts;
- Program supervision, runtime readiness, retryable cleanup, and recovery;
- Node filesystem behavior that needs no host: program checkouts and Installation
  files; and
- the Store conformance suite and boundary tests.

The package publishes one wildcard export: `@foundry/modules/<path>` resolves to
`src/<path>.ts`, and there are no barrel entry points. Top-level modules hold the
domain, Store, version, package, preflight, project, management, and source-capture
APIs; `gateway/`, `node/`, `platform/`, `template/`, and `testing/` hold the roles.
Only `node/` may import `node:fs/promises`, `node:path`, `node:crypto`, and
`node:events`. SDK source is internal; Template composition injects its emitted form
into generated workspaces as local `@foundry/module-sdk`. `src/sdk/emit.ts` compiles
that source with `typescript` for the `emit-sdk` script and is never imported by a
runtime module.

`src/boundary.ts` lists the allowed package imports per role, and
`src/test/module-boundary.test.ts` checks every import, re-export, and dynamic import
in production source against it. Relative imports must resolve inside `src`.

### `@foundry/artifacts`

Artifacts owns Artifact and Content identity, Trees, blobs, freezing, tags, selection,
and file persistence contracts. Modules interprets eligible frozen Content as a version
and creates no version entity of its own.

### Template role

A `ModuleBase` is the application a workspace starts from: an `id`, a `name`, a file
tree, and optional agent `instructions`. The Template role clones the base into
`packages/app`, adds the fixed workspace structure and SDK pack, records provenance,
and repairs composer-owned files in recognized older workspaces. Which bases a host
offers, and how it describes them, is outside this package.

### Store adapters

`InMemoryModuleStore` is the reference `ModuleStore`. A durable adapter persists
Modules, retained manifests, Installations, and Grants. It checks inside its write
transaction that a selected Content belongs to the Module's Artifact and rejects
corrupt retained Manifests. `describeModuleStoreConformance` holds every adapter to
the same behavior.

### Host

The host owns development integration, isolated compilation, backend and registry
setup, the database snapshot driver, transports, providers, approval workflows, URLs,
and UI. It delegates source validation and persistence to Modules, and adds
workspace upgrades, activation workflows, and URL projections on top of the shared
management operations.

`createModuleSystem` composes the package's management, Gateway, dispatcher, runtime,
supervisor, and recovery from injected infrastructure. The platform role imports
Sandbox container types only, type-only and from exact deep paths
(`@foundry/sandbox/container/containers`, `/types`, and `/constraints`); it neither
constructs a backend nor installs one.
The host retains ownership of the shared container registry's lifetime.

`ModuleCheckouts` and `ModuleInstallationFiles` live in the portable platform role.
Node adapters implement disk permissions, immutable checkout publication, quotas,
legacy migration, and database backup. `createModuleSystem` in the Node role supplies
those implementations from explicit roots and an injected snapshot driver.
Source capture uses Core filesystem types; `node/source` supplies disk reads.

## Roles

| Role     | Main responsibility                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------- |
| Root     | Domain, Store, preflight, packages, project/source management, Installations, and declared Views                      |
| Gateway  | Frame sessions, publish catalogs, admit runtime calls, dispatch providers, and normalize failures                     |
| Platform | Compose injected infrastructure, acquire containers, serialize lifecycles, confirm cleanup, and recover installations |
| Node     | Fill digest-named read-only program checkouts; own Installation files, legacy move, and backup                        |
| Template | Compose a Module workspace from a `ModuleBase`, or upgrade one, without owning the base                               |
| Testing  | Verify adapter behavior against the `ModuleStore` contract                                                            |

Boundary tests hold production imports to the allowlist and prohibit retired runtime
vocabulary.

## Build flow

```text
source: pinned active Content's source/
  │ bun.lock must already be captured
  v
disposable build container (no mounts, removed afterwards)
  │ install, generate, typecheck, build
  │ reject source mutation, credentials, symlinks, or undeclared output
  v
ready Artifact Content
  │ refuse if the active Content changed; replace Tree; freeze with SemVer tag
  v
version (the frozen Content itself)
```

The compilation pipeline remains with the host, separate from Module management. The
Modules package validates the Manifest and constructs the version. Nothing is registered: the
landed Content embeds its Manifest source.

The shared development container installs dependencies outside the observed Artifact
directory. Capture applies workspace ignore rules and excludes dependencies, credentials,
generated outputs, and databases. Saving compares the original Content ID and timestamp;
new files and `bun.lock` become Artifact source. Builds require that saved lockfile.
Editing and building use saved Artifact source exclusively.
Workspace upgrades never replace an authored application
with a new base because of the base recorded in its provenance.

## Runtime files

```text
<checkoutsRoot>/<contentDigest>/   read-only  -> /foundry/program  (cwd)
<filesRoot>/<installationId>/      read-write -> /foundry/files
```

A checkout is filled beside its final name from byte-verified blobs and published by one
rename; an existing one is re-verified, and a damaged one is moved aside rather than
rewritten under a live mount. Installation files are created `0700`. A legacy live
directory moves in entry by entry before any Program opens it; an occupied destination
stops the move and both copies stay. Programs receive `FOUNDRY_FILES_PATH`, plus
`FOUNDRY_MODULE_DATA_PATH` for versions built before it.

A version change backs the database up with every writer stopped, through a
host-supplied driver that reads the WAL. A failed start closes the VM, then restores the
backup and leaves the Installation `failed`; the backup stays for the retry. A
successful start discards it before publishing `active`. An empty-baseline marker
restores the absence of a prior database. Cleanup failure blocks restoration and
another start until writers are confirmed stopped. Files other than the database
are not rolled back.

## Installation lifecycle

```text
create -> disabled, generation 0

disabled/failed -> begin starting, generation + 1
starting        -> settle active or failed, generation unchanged
active          -> begin stopping, generation + 1
stopping        -> settle disabled, generation unchanged

select version  -> generation + 1, start attempts reset
```

The Store uses optimistic concurrency. Each transition, Grant change, version
selection, or deletion presents `expectedGeneration`. A stale generation fails with
`ModuleStoreConflictError`. Beginning a user-requested start may reset failed attempts;
automatic recovery does not. Active settlement and version selection also reset the
counter.

The Store does not enforce an allowed-state transition matrix. The platform supervisor
owns ordering and the `MAX_START_ATTEMPTS` recovery policy. Its per-installation queue
also covers version selection and deletion. The composed Module system confirms
retained native resources are stopped before file migration, backup, or restoration.

## Runtime admission

```text
Program invoke frame
  │
  +-- stale Runtime or stopped Installation ──> stale-runtime
  +-- undeclared alias ────────────────────────> unknown-alias
  +-- missing provider ───────────────────────> unknown-capability
  +-- wrong mode ─────────────────────────────> invalid-frame
  +-- invalid input ───────────────────────────> invalid-input
  +-- denied constraints or missing Grant ────> unauthorized
  v
provider effect under host-bound Principal and AbortSignal
  │
  +-- unary output validation ────────────────> result or invalid-output
  +-- stream event validation ────────────────> next frames, then complete
  +-- cancel, disconnect, dispatcher revoke ─> abort provider work
```

Runtime admission reads Installation and Grant state together through
`loadGatewayContext`. It resolves the alias against the Manifest selections bound when
the session connected, then the provider, schema, and constraints, before invoking the
provider. Programs cannot supply their Principal or
upgrade a development session into runtime mode.

Gateway sessions reject duplicate request IDs, bound concurrent work, close after their
lifetime request ceiling, and use heartbeats to detect dead transports. Errors cross the
protocol as public failure codes; provider details remain host-side.

The package does not persist Invocation evidence. Any durable audit record belongs to a
separate owner until the public Store contract and current implementation say otherwise.

## Module Package flow

Encoding verifies Module, Artifact, Content, Manifest, Tree, blob, and digest agreement,
then emits canonical `foundry.module/3` JSON within fixed size limits. Import validates
the entire envelope before its first mutation, including that an embedded
`source/foundry.module.json` agrees with the envelope Manifest.
Export refuses retained legacy disagreements rather than creating an unimportable
package; it never rewrites frozen source or changes approved capabilities.

On import:

1. Create the Module Artifact and first frozen Content when absent.
2. Reuse existing frozen Content with the same tag when present.
3. Otherwise add a new frozen Content version to the existing Module Artifact.
4. Register the Module. When the tree embeds no Manifest source, retain the envelope
   Manifest for the landed Content.

The target may mint a different Content ID. Tag, Tree digest, Manifest, Artifact
identity, and Module identity carry the version's meaning across stores. The previous
`foundry.module/1` package envelope is rejected.

## Changing the package

1. Update the term in [GLOSSARY.md](GLOSSARY.md) if identity or meaning changes.
2. Change root domain or Store contracts before their adapters.
3. Update `describeModuleStoreConformance` for behavior every adapter must share.
4. Change Gateway types before host implementations and the generated client when
   protocol behavior moves.
5. Regenerate SDK output with `bun run --cwd=packages/modules emit-sdk` only when its
   authored source changes, then keep the parity tests green. The script writes raw
   output and formats it with Biome.
6. Check host consumers at the seam affected: build, supervisor, provider,
   transport, and management.

Do not collapse Module ID into Artifact ID, treat a capability request as a Grant, or
import concrete host or sandbox adapters into the package.

## Proof

Package tests in `src/test/` exercise the domain, Manifest, Store, preflight, package
transport, Gateway, generated clients, Template composition, and boundary rules. One
generated-workspace integration test runs separately through `test:integration`.
A durable Store adapter runs `describeModuleStoreConformance` in its own suite.

Injected-container tests cover spec refresh, selection fences, failed linking and
retryable cleanup, mount validation, and startup failure. Project tests cover
concurrent creation/saving, frozen-source revision, pinned Views, paginated deletion,
and portable/Node source capture. The composed Node system test exercises Gateway
readiness and supervision over a fake backend without shutting down unrelated VMs.

These tests do not establish host integration, production provider effects, or
live sandbox and transport reliability.
