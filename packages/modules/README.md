# `@foundry/modules`

`@foundry/modules` defines the Artifact-backed Module domain and the contracts used to
package, install, and connect Module programs to host capabilities. The package includes
the registry of Module records over an in-memory or SQLite store, project management,
source capture, container orchestration, and Program supervision. Hosts pass configured
Artifacts, registry, container registry, transport, and capability providers. Compilation and agent
execution are separate.

- [Glossary](GLOSSARY.md) defines Module language and its boundaries.
- [Architecture](ARCHITECTURE.md) explains the model, ownership, flows, and safe change.

## Resolve a version

A Module has stable identity separate from its backing Artifact. A version is a frozen,
SemVer-tagged Content of that Artifact; nothing else persists it.

```ts
import type { Artifacts, ContentId } from "@foundry/artifacts";
import type { ModuleId } from "@foundry/modules/domain";
import type { ModuleRegistry } from "@foundry/modules/registry";
import { createModuleVersions } from "@foundry/modules/version";

export async function loadVersion(
  artifacts: Artifacts,
  store: ModuleRegistry,
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
cannot supply it keeps a retained manifest in the registry: an output-only import, or a
legacy version whose stored manifest differs from its embedded source. A retained
manifest outranks the embedded one, and frozen bytes are never rewritten.
`pruneRetainedManifests` drops only rows the Content reproduces.

Two Manifest formats parse: `foundry.module/1` keeps its original fields and semantics,
and the strict `foundry.module-manifest/1` adds `resources` (minimum `memoryBytes`,
`cpus`, and a `storageBytes` hard limit no current runtime enforces), a `network`
destination request (granting nothing), `persistence.files` (`none` or `installation`,
which `data` requires), `settings` requests/defaults by dot-notation key, and `editors`
naming existing Views. Neither format takes a `$schema` member. Any other format is
refused with a message naming both. `parseModuleManifest` is authoritative; the committed
`schema/foundry.module.schema.json` (`bun run emit-manifest-schema`) is editor assistance
for `foundry.module.json` only. Embedded and retained Manifests agree when their canonical
parsed values do.

`resolveModuleSettings` (`settings.ts`) combines host defaults and ceilings, the Manifest's
requests and defaults, and user values into effective settings; an unmet minimum is a
problem, never a smaller allocation. Network, broader Artifact access and host operations
are Grants, never settings.

## Work with installations

An Installation selects one version by `contentId`. The registry refuses a version whose
Artifact is not its Module's, and, given `artifactOfContent` (see [Storage](#storage)),
one whose Content does not exist or belongs to another Artifact. It starts disabled with
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
reports runtime and resource requirements the host cannot meet and requested
capabilities it does not provide or whose constraints its provider denies; a required
one blocks the start, an optional one does not. A required, available capability
without a matching Grant also blocks (`ungranted-capability`). It separately returns
capabilities that still need Grants, matched by the digest each provider resolves from
the raw requested constraints, the same digest invocation admission compares. The
registry keeps the exact approved Grant set for each Installation.

`@foundry/modules/grants` lists what a version asks for and matches Grants:
`moduleAccessRequests` (each capability request with its availability and
provider-resolved digest, plus the strict Manifest's network request), `isGranted`,
and `carriedGrants` (Grants whose capability, version and digest survive a version
change). A network Grant is `NETWORK_GRANT` (`network`, version 1) with the digest
of the normalized destinations. `approvedNetworkDestinations` returns those
destinations only when the Installation holds a matching Grant. The container
runtime then starts the Program with that sandbox allowlist; otherwise network
stays disabled.

`createModuleAccess` from `@foundry/modules/access` changes Grants. `approve` takes
an existing Installation and refuses a capability its Version does not request, one
the host cannot provide, or an Installation whose generation or selected Content
moved since the caller read it. `revoke` refuses a Grant that is not held and, once
the revoke commits, cancels its active Invocations through the injected
`invocations.revoke`. A running Program's network destinations are its sandbox
allowlist, read when it starts, so revoking a network Grant takes effect for them
only once the Program restarts. `carryOver` keeps the Grants a new Version's requests still
match and revokes the rest. How approval is asked for, and which Installation a host
creates for it, stay with the host; `ensureInstallation` from `management` creates a
host-named Installation (for example one per Module) when it is absent.

## Import source modules

The package has no barrel entry points. Import each API from the source module that
defines it, as `@foundry/modules/<path>` for `src/<path>.ts`:

| Role     | Modules under `@foundry/modules/`                                                                                         | Use                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Domain   | `domain`, `manifest`, `manifest-schema`, `settings`, `grants`, `access`, `version`, `registry`, `errors`, `schema`, `preflight`, `package`, `projects`, `build`, `proposals`, `management`, `source` | Domain, Manifest and its JSON Schema, settings, Grant matching and changes, versions, the registry of Module records with its errors and record schemas, packages, projects and fenced publication, build audit, source proposals, source capture and admission, Installation management, and declared Views |
| Storage  | `store`, `store/memory`, `store/sqlite`, `store/tables`                                                                   | The store seam, the default in-memory store, the SQLite store, and its Drizzle table definitions                         |
| Gateway  | `gateway/module-gateway`, `gateway/types`, `gateway/catalog`, `gateway/runtime-dispatcher`, `gateway/runtime-context`, `gateway/generator` | Host Gateway, protocol types, capability catalog, runtime dispatcher, runtime admission, and generated Program client |
| Platform | `platform/system`, `platform/program-supervisor`, `platform/runtime-recovery`, `platform/installations`, `platform/container-runtime`, `platform/files` | System composition, container acquisition, Program supervision, cleanup, recovery, on-demand activation, and portable filesystem contracts |
| Node     | `node/system`, `node/source`, `node/checkouts`, `node/selected-checkouts`, `node/installation-files`, `node/application-recovery` | System composition with disk adapters, source capture, digest-named and selected checkouts, Installation files and backup, and recovery observation |
| Template | `template/compose`, `template/upgrade`                                                                                    | Compose a Module workspace from a `ModuleBase` and upgrade composed workspaces                                            |
| Testing  | `testing/store`                                                                                                           | Run the shared `ModuleStore` conformance suite against a store                                                            |

The package has no sandbox backend or network provider; the host supplies the runtime
and provider implementations. See [Storage](#storage) for where Module records live.

## Storage

`ModuleRegistry` from `@foundry/modules/registry` holds every rule of the Module
records: one Module per Artifact and one Artifact per Module, retained manifests owned
by the Module that retained them, unique Installation ids, an Installation selecting a
version of a registered Module, the generation compare-and-set, status and start-budget
transitions, one Grant per capability, and the refusal to delete a Module an
Installation still selects. Each command reads the fields it takes from its input once,
by name, wherever they live (an own property or a getter on a prototype, so a class
instance is honoured), copies them before its first await, and then runs one
read-modify-write ending in one `commit` to its `ModuleStore`, inside the store's
`transaction` when it has one. A retained manifest must be plain JSON data. Lists come
back in id order (UTF-16 code units), paged by id; the registry reads every matching
record and sorts it, which suits a local library.

`new ModuleRegistry({ store, artifactOfContent })`: `artifactOfContent(contentId)`
answers which Artifact a Content belongs to, or `null` when there is none, as
`async (id) => (await artifacts.getContent(id))?.artifactId ?? null` does. With it, an
Installation can be created at, or moved to, only a version whose Content exists and
belongs to the version's Artifact. Without it, the registry checks only that the
version's Module is registered on the version's Artifact: a made-up Content id on that
Artifact is accepted, and that the Content exists is the caller's to have checked
(`createModuleVersions` resolves every version it returns so). A host that has its
Artifacts at hand passes it.

`registry.durability` is its store's (`"commit"` unless the store says otherwise). A
store's `durability` says when a commit that resolved is there for good: `"commit"` at
once, `"host"` only once a transaction the store does not own commits. A transaction's
view is `"host"`, and so is the registry a transaction hands its work, and a
`SqliteModuleStore` over a Drizzle transaction the host began (which refuses
`durability: "commit"`). `createModuleAccess` refuses a `"host"` registry, because it
cancels Invocations once a revoke commits and a rollback could then restore the Grant.

`ModuleStore` from `@foundry/modules/store` is the seam: reads plus one atomic
`commit(write)` and an optional `transaction(work)`. It enforces nothing. A write puts
and deletes Modules, retained manifests (`StoredManifest`) and Installations with their
whole Grant set (`StoredInstallation`), deletes before puts; the record schemas are in
`@foundry/modules/schema`. A store takes a write by reading each property the write
names once, by name, when `commit` is called, captures each record field by field into
plain objects, and copies the capture; both stores share that capture
(`store/captured`). It refuses, with a `TypeError` naming the property and before
anything is written, a list that is not an array, a delete key that is not text, a
record that is not plain data (made by `{}` or `Object.create(null)`, every own
property enumerable), a field of the wrong type, and a manifest that is not plain JSON
data. A commit lands whole or not at all: the memory store applies each write to a copy
of its tables and swaps the copy in only once the whole write applied. Reads return
detached copies, list in the order records were first put (a record put again keeps its
place), filter by exact values and page by an opaque cursor. A position is never handed
out twice in a scope, so a cursor stays valid however many records are deleted around
it. `MemoryModuleStore` from `store/memory` is the default:

```ts
import { ModuleRegistry } from "@foundry/modules/registry";
import { SqliteModuleStore } from "@foundry/modules/store/sqlite";

const registry = new ModuleRegistry({
  store: new SqliteModuleStore({
    database, // a drizzle-orm/libsql database, or a transaction on one
    scope: workspaceId,
    // Optional: runs in the commit's transaction, after the store's statements.
    onCommit: async (transaction, write) => {
      await transaction.insert(changes).values({ write });
    },
  }),
});
```

`@foundry/modules/store/tables` exports the Drizzle tables for the host's migrations:
`modules`, `module_manifests`, `module_installations` and `module_positions`. Each of the
first three holds its record field for field, plus `scope` (an opaque partition key,
first in every key and index) and `position` (put order). `module_positions` holds one
counter per scope, the position the scope's next new row of any table takes; it only
grows, across connections and reopening. A scope that has rows but no counter row yet
(rows written before there was one) starts past its highest position on its first
commit that puts or deletes anything, a delete-only commit included. An Installation's Grants are one JSON array on its row, in
Grant order; they change only with their Installation. Timestamps, which the records
hold as `Date`s, are ISO 8601 text, exact to the millisecond across the whole range a
`Date` holds. The package ships no migrations.

Each `commit` is one database transaction, and a throwing `onCommit` rolls it back.
`onCommit` receives the store's own copy of the write, taken when `commit` was called:
every record put, whole, and every key deleted. It cannot see which put filed a new
record and which replaced one, what a replaced or deleted record held (the store has
already written when the hook runs), or which registry command made the write: a write
carries no event.

A store offers `transaction(work)`, and both stores here do: the registry then runs each
command, and each read of several store reads, as `work(view)`, and the store lets no
other write land in between, from any registry over it. A throw from `work` leaves
nothing it committed through `view`. `registry.transaction(work)` hands `work` a
registry bound to one such transaction, so several commands land together or not at
all, and `effects`: `effects.afterCommit(effect)` runs `effect` once the transaction has
committed, never if it rolls back, and every effect runs though one throws (the call then
rejects with that error, or an aggregate of them). Transactions do not nest:
`transaction` on the registry `work` was handed rejects at once with a
`ReentrantCallError`. Over a store without `transaction`, `work` runs alone among the
registry's commands, each command lands as it commits and stays if `work` throws, and so
its effects run either way. On SQLite the transaction begins `BEGIN IMMEDIATE` (Drizzle's libSQL driver begins
every transaction so), so it holds the write lock from its first statement and a write
from another connection waits for that connection's busy timeout or fails with
`SQLITE_BUSY`; it never lands in between.

Each store and each registry takes one call at a time, so a call to it from inside its
own transaction's `work` (or from `onCommit`) could only wait for itself. It is refused
at once with a `ReentrantCallError` from `@foundry/lib/turns` that says to use the view,
the registry passed to `work`, or the transaction passed to `onCommit`. A caller that is
merely concurrent still waits its turn. The two are told apart by asynchronous context
(`AsyncLocalStorage`), which detects re-entry by ancestry, not wait cycles: a
transaction that awaits a continuation registered outside it, which then calls the
outer store, still deadlocks, as do two stores each taken inside the other's work.

Host requirement: the store's queue covers only its own instance. Within one process,
the host must serialize writes per database file across every client and store on it.
A second libSQL client in the same process does not wait usefully: libSQL waits out its
busy timeout synchronously, holding up the thread the first client needs to commit, so
it blocks for the whole timeout and then fails with `SQLITE_BUSY`. Do not open the same
file with a second SQLite library in the process either. Connection settings such as
WAL and the busy timeout are the host's.

A defect of `@libsql/client` 0.18.0, which the store cannot work around: a client whose
`BEGIN` fails with `SQLITE_BUSY` keeps the failed statement open, and its next
transaction fails at `COMMIT` with "SQL statements in progress". In rollback-journal
mode the file can stay blocked even for a fresh client. The store cannot reset a client
it was handed, so a host should use WAL mode and replace its client after a
`SQLITE_BUSY`.

A storage limit of the SQLite store, not a rule of the package: SQLite does not give
back every value as it was bound. So `commit` refuses, before writing anything and
through a transaction's view as well, a write that puts any of these, with a
`RangeError` naming the field (such as `putInstallations[0].installation.containerId`):

- U+0000 or text that is not well-formed UTF-16 in a plain text column (an id, a
  Content or Artifact id, a container id, a status). libSQL cuts text at a NUL, and a
  lone surrogate is bound changed. A read, filter or delete by such a key finds
  nothing, and the constructor refuses such a `scope`. Manifests and Grants are JSON,
  which escapes both, so they keep them.
- An invalid `Date`, or a value that is not a `Date`, in a timestamp.
- NaN, an infinity, `-0` or a number beyond `Number.MAX_SAFE_INTEGER` in an integer
  column (`generation`, `startAttempts`; the schema accepts `-0`).
- In a JSON value (a manifest, a Grant): NaN, an infinity or `-0`, `undefined` as a
  property or array item, a hole, anything but a plain object or array (a `Date`, a
  `Map`), or a value that contains itself.

The package therefore needs a runtime with `node:async_hooks`: Node, Bun, Deno, or a
worker runtime with Node compatibility.

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
`files: { root, snapshotDatabase }` configure the Node adapters. The optional
`observeInvocation` is told of each Gateway invocation of an admitted runtime (fail-soft),
for a host's audit record. Neither composition
creates storage engines or installs a sandbox backend. Construction starts no
Program. Each `system.programs.start` carries a `launch`: whether the Program's
private files persist (`files`) and the CPU and memory it starts with (`resources`).
The host resolves both from the Manifest and its settings. The host runs recovery
explicitly and releases Programs before shutting down its shared container registry.

`system.modules` creates projects from supplied source, imports packages, manages
installations, and resolves declared Views as identity, path, and title. The host
supplies URLs and presentation. `system.programs` controls Program lifetimes;
`selectVersion` requires a stopped Installation. `system.gateway` admits connections
and `system.invocations` handles capability dispatch and revocation. Persist Grant
changes before invoking revocation; `createModuleAccess` does both in that order.
User approval remains a host workflow.

A host that starts Programs on demand composes `createModuleInstallations` from
`@foundry/modules/platform/installations` over the same supervisor, store, providers
and dispatcher. `selectVersion` carries Grants over before the supervisor records
the selection, inside a selected checkout's swap when the host keeps one per Module;
`start` preflights against the Grants left after selection and the host's settings
policy, throws `ModuleActivationRefusedError` with the blocking facts, and starts at
the selected generation; `stop` stops at the current generation. Each is a separate
call, so the host can run selection as its own unit of work. At boot such a host calls
`recovery.stopInterrupted(reason)` instead of `recoverEnabled`.
`createModuleSelectedCheckouts` from `@foundry/modules/node/selected-checkouts`
keeps one checkout per Module at a host-chosen path and implements both
`ModuleCheckouts` and the swap.

`createModuleProjects` accepts Artifacts and a registry directly when only authoring
is needed.

The Artifacts and the registry cannot share a transaction, so every operation that
writes both orders its two commits so that the registry never names an Artifact or a
Content that does not exist, and so that repeating the same call after a failure at any
step completes it:

- Project create: the Artifact first, then the registration that names it. If the
  Artifact write fails, nothing is written and a retry creates the Module. If the
  registration fails, the new Artifact, which nothing names, is archived (best effort)
  and a retry makes another. A Module registered already is returned as idempotent only
  once its Artifact is found; a registration naming a missing Artifact is refused, not
  returned. A concurrent create of the same id wins, and this create's Artifact is
  archived.
- Package import: the registry is asked first whether the Module id belongs to another
  Artifact, and the import is refused before anything lands. Then the Content lands in
  its Artifact, then the Module is registered (and its manifest retained). Landing is
  idempotent, so a retry after either step fails completes the import.
- Module delete: the Installations are deleted, then the Artifact is archived, then the
  Module is retired from the registry. An archived Artifact still exists, so whichever
  step fails the registry names nothing missing; a retry archives again (a no-op: an
  archived Artifact keeps its `archivedAt`) and then retires the Module.

`captureModuleWorkspaceSource(filesystem, root)` from `@foundry/modules/source` uses
its `ModuleSourceFileSystem` interface. `@foundry/modules/node/source` exposes the same
operation as `captureModuleWorkspaceSource(root)`. Capture excludes generated files, credentials,
and databases while retaining `bun.lock` and the authored SDK. Saves use a
`ModuleSourceBinding` containing Artifact ID, Content ID, and `updatedAt`. Saving frozen
source creates editable Content and removes stale outputs without rewriting the
released Content. Reads refuse corrupt blobs, unsupported entries, and invalid UTF-8.
Editor saves accept incomplete Manifest edits; creation and version resolution
validate the Manifest. `admitModuleSource` and `MODULE_SOURCE_LIMITS` from
`@foundry/modules/source` bound any source a host admits by file count, path length,
file length and total bytes.

`projects.publish` freezes a build's source and outputs as a tagged Version in one
write, fenced on the binding the build read: it refuses a moved binding or a used
tag with `ModuleStoreConflictError`, outputs outside `packages/*/dist/`, Manifests
selecting a capability the given catalog lacks, and requirements no host can meet.
`metadata` lands in the same write, so a host can attribute the Version.
`auditModuleBuildWorkspace` from `@foundry/modules/build` checks a finished build
workspace before its outputs are read: saved files unchanged, everything else
derived. `@foundry/modules/proposals` diffs proposed source against its snapshot
and validates a proposal like saved source; the owner of that source decides
whether to apply it. Workspace upgrades remain explicit through
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
retained in the registry.

Export refuses a retained legacy Manifest that disagrees with embedded source.
That version remains runnable with its approved capabilities, but cannot be moved
in this package format without resolving the disagreement.

Import creates the Module Artifact when absent, reuses an identical tagged Content
version, or explicitly revises frozen Content and freezes the successor. Ready Content
keeps its identity on replacement. The Artifact commits first and the registry second
(see "Compose a Module system" for the order and its recovery), so a registration that
fails after the Content landed leaves the Content, and a retry registers it.

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
Saves compare the Content ID and `updatedAt` captured when the workspace opened. Builds
consume that saved Content and refuse concurrent source changes. Editing and
building use saved Artifact source exclusively.

A host composes the Module system with its own registry, container registry, filesystem
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
parity, store conformance, registry rules over every store, package integrity, Gateway admission, and the package
import boundary.

### Lifecycle policy boundary

`programs` is the low-level host lifecycle: raw `start` accepts a host-resolved
launch and enforces generation, runtime identity and cleanup, not host approval
or settings policy. `programs.activate` validates through
`platform/activation.validateModuleActivation` in the same Installation turn
before starting. `createModuleInstallations` is a convenience adapter to those
commands, with no queue of its own. Its selection supplies typed Access and
checkout services; the supervisor acquires the Installation turn before the
checkout turn, including when raw starts compete with selection.

Recovery retains the low-level automatic-start path and its attempt budget.
Its host `launch(installation)` resolver must validate policy before returning;
it can use `validateModuleActivation` for the same Grant, persistence and resource
checks as explicit activation. The library cannot choose a host's settings or
providers. Works is the only shipped host in this tree. It keeps Module records and
containers in memory for one process, so it has nothing to recover at boot, and uses
validated activation when a View opens.

Access runs each revoke and carry-over in a registry transaction of its own and
registers each cancellation with `effects.afterCommit`, so Invocations are cancelled
only once the revoke has committed, never for a revoke that rolls back, and every
dropped Grant's are cancelled though one cancellation throws. It refuses a `"host"`
registry at construction, the registry a transaction hands its work included.
