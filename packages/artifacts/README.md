# `@foundry/artifacts`

Package constants live in `@foundry/artifacts/constants`. General MIME helpers live in `@foundry/lib/mime`.

`@foundry/artifacts` defines the shared Artifact vocabulary and the
[`ArtifactSubstrate`](src/substrate.ts) contract. An Artifact keeps stable product identity
while its active Content changes. `Artifacts` owns behavior and every rule, and accepts an
`ArtifactStore` from `@foundry/artifacts/store`. It defaults to
`MemoryArtifactStore` from `@foundry/artifacts/store/memory`; a host may supply a
persistent store.

Content extends the shared `StorageTree` vocabulary with `blobId` on file entries.
Paths map to files, directories, symlinks, sockets, devices, or pipes. Only files
reference blobs. A blob is a stored object: its id is a stable handle, and its
digest describes the bytes it holds now. When a file's object is referenced by
that file alone, new bytes rewrite the object in place under the same id. A
shared object is copied on write, so frozen Content never changes. New objects
reuse an existing object with the same digest. Files larger than one chunk are
stored as immutable chunks, whether the bytes arrive whole or streamed.
File reads extend Core's `FileRepresentation` with loaded bytes or a stream;
reading a non-file returns `null`. Import shared descriptors directly from Core.

`create({ entries })` and `write({ changes: { put } })` accept file inputs or
structural nodes such as `{ type: "directory" }` and `{ type: "symlink", target }`.
Writes add missing parent directories and reject children beneath non-directories.
Removing a directory removes its descendants. Empty directories remain explicit.

Tree digests describe bytes and structure, excluding blob IDs. Nonempty directories
are implied by descendant paths; empty directories and other structural nodes
contribute to the digest.

## Use the contract

Accept `ArtifactSubstrate`, or the smallest `Pick<ArtifactSubstrate, ...>` your code needs. Let the host
provide the implementation.

```ts
import type { ArtifactSubstrate } from "@foundry/artifacts";

import { HTML_MIME } from "@foundry/lib/mime";

export function createPage(artifacts: ArtifactSubstrate) {
  return artifacts.create({
    name: "Home",
    type: HTML_MIME,
    entries: {
      "index.html": {
        bytes: "<h1>Hello</h1>",
        mime: "text/html",
      },
    },
    metadata: { entry: "index.html" },
  });
}
```

The returned `ArtifactResolved` contains the Artifact and its active Content.
Create an `Artifacts` instance over the in-memory store, the default:

```ts
import { Artifacts } from "@foundry/artifacts";

export function createArtifacts() {
  return new Artifacts();
}
```

## Resolve references and handlers

```ts
import { resolveReference } from "@foundry/artifacts/references";
import { createRegistry } from "@foundry/artifacts/registry";

const registry = createRegistry({
  handlers: { html: htmlHandler, image: imageHandler },
  fallback: genericHandler,
});

registry.register({
  type: "application/example.composition",
  base: "structured",
  handler: compositionHandler,
});

const target = await resolveReference(artifacts, { artifactId });
if (target.status === "available") {
  const { handler } = registry.resolve(target);
  await handler(target);
}
```

References accept `{ artifactId, contentId?, path? }`. Omitted `contentId` uses
current usable Content, or `null` while empty, generating, or failed. An explicit
Content must belong to the Artifact and be ready or frozen. Resolution reads
descriptors, never file bytes, and never freezes Content.

Paths default to `metadata.entry`, the only file, or root `index.html`. With no
default, the Artifact and tree remain available. Explicit paths are preserved even
without a matching entry so a host handler can interpret a route. File-serving
handlers must reject missing files; resolving a reference grants no serving or
execution permission. Structural entries are returned without following symlinks.

The registry recognizes HTML, image, video, audio, text, and structured data.
Exact definitions take precedence over base handlers, then the required fallback.
An unregistered, unrecognized type can use the selected file's MIME. Definitions
do not change persisted types. Duplicate registrations fail; registries are independent.

Handlers are caller-supplied values. They may be async functions or objects with
host-specific operations; matching never invokes them. Application hosts own
domain registrations; `@foundry/modules` owns Module runtime resolution.
Module constants live in `@foundry/modules/constants`.

## Working model

An Artifact is the stable thing consumers point at. Content is one version of its files
and version metadata. The Artifact points to zero or one active Content; other versions
remain addressable in its timeline.

Artifact status and Content state answer different questions. Freezing ready Content
publishes a draft Artifact and makes that Content immutable. Only an explicit `freeze`
(or the `freeze` option of `create` and `write`) publishes. Explicit revision creates
new ready Content without replacing Artifact identity or publishing the Artifact.

## Work with versions

`create` may start an Artifact without Content or create its first ready Content.
`write` then follows the active Content state:

- no active Content creates the first ready version;
- ready Content is updated in place;
- frozen Content refuses edits with `ContentStateError`.

`revise` requires the selected source Content id and its expected edit time. It preserves
the source as frozen, applies optional changes to a ready successor, and selects that
successor atomically. It does not publish. Frozen files and semantic metadata cannot
change; top-level `label`/`pinned` annotations and the separate tag remain editable.

`freeze` makes ready Content immutable. `select` moves the Artifact pointer to ready or
frozen Content belonging to that same Artifact without copying it. `fork` freezes a
ready source when needed, without publishing it, then creates a new Artifact from its
StorageTree and metadata.

Use `expectedContentId` or `expectedUpdatedAt` when a write must not overwrite a newer
selection or edit. A failed fence throws `StaleContentError` with the current Content
identifier and update time so the caller can reload or reconcile.

Revisions and forks inherit metadata except provenance (`sessionId`, `messageId`,
`runId`, `generation`, `failure`) and record `from`. Frozen Content keeps its metadata
except the `label` and `pinned` annotations. Both lists live in `src/content.ts`.

Generation contributions use ordinary writes or explicit revisions. Legacy generating
and failed Content remains available for diagnosis and cleanup.

## Use safely

Consumers must require ready or frozen Content before reading product files. Missing or
unusable Content does not mean the Artifact identity is missing. Selecting unusable
Content cannot displace usable Content.

Use `transaction` when several Artifact operations must commit or roll back together.
The callback receives an `ArtifactOperations` handle; use it for every grouped
operation. It expires when the transaction settles:

```ts
await artifacts.transaction(async (transaction) => {
  const created = await transaction.create(input);
  await transaction.freeze(created.content.id);
});
```

When created with `nodeArtifacts()` from `@foundry/artifacts/node` (or when an explicit
`transactionScope` option is supplied), any other call on the same `Artifacts` instance made
while a transaction's callback runs joins that transaction, from however deep in the call stack.
Reads see its uncommitted writes, and a nested `transaction` commits with the outer one. Joined
calls are not savepoints: if one fails and the callback still returns, the whole transaction rolls
back with `TransactionRolledBackError` (its `cause` is the failure). So does an operation on the
callback's own handle that is refused after writing part of the change; one refused before writing
anything leaves the transaction to go on. Work scheduled during the callback but run after it
returns starts its own transaction, once the callback's transaction has settled. Portable
`new Artifacts()` instances do not perform ambient joining — always use the explicit
`ArtifactOperations` handle passed to the callback.

The callback's second argument is a transaction-scoped effects handle:
`effects.afterCommit(async () => ...)` registers work with the outermost commit.
Rollback discards that work; after committing, every registered effect runs even
if applying records to disk fails. A sole failure is rethrown unchanged. Multiple
effect failures are retained together in a `StorageApplicationError` whose cause
is an `AggregateError`. Effect callbacks run after the write lock is released,
so they may open another transaction. Registering after the unit expires throws.


StorageTree paths use forward slashes, have no leading slash, and cannot contain empty, `.` or
`..` segments. `metadata.entry`, named entries, and `thumbnail` point to paths in the
StorageTree. Use `readRoot`, `readNamedRoot`, `readThumbnail`, or `readFile` to load bytes.

Deleting active Content requires a replacement in the same operation. Deleting an
Artifact cascades through its Content. `sweep` removes old,
unselected ready or failed Content and then unreferenced blobs. It does not discard an
active generation.

## Artifact-backed directories

`artifactFileSystem` implements the filesystem consumed by the ordinary directory
extension. Node operations are isolated under `@foundry/artifacts/node`.

The adapter registers one Workspace over one Artifact's active Content. The
Workspace owns its registration and file catalog; Artifacts owns the bytes and
Content lifecycle. The stored `sourceId` identifies the Artifact to resolve on
each operation.

```ts
import { artifactFileSystem } from "@foundry/artifacts/node";
import { directory, Workspaces } from "@foundry/workspaces";

const filesystem = artifactFileSystem({ artifacts, root });
const workspaces = new Workspaces({ store }).extend(
  directory({ filesystem }),
);
const ws = await workspaces.load({ artifactId });
await ws.save({ fileId, text, expectedDigest });
```

`load` opens an existing Artifact; creation stays with `artifacts.create`, discovery
with `artifacts.list`. Each directory follows its Artifact's active Content. Records
are authoritative: a directory removed outside the filesystem is restored. Delete
the Artifact with `filesystem.remove(root)` or `artifacts.delete`. Scans
use the tree metadata without reading every blob or applying ignore rules.

Workspace edits and observed CLI changes use Artifact operations. Artifact writes
apply directory changes before returning success. `observe` reports committed
changes, with cause `"commit"`, even when applying them failed, and `recover()`
reports with cause `"recovery"`. Required application uses `bind` and does not
depend on events.

Options narrow and hook the filesystem. `includes(artifact)` limits which Artifacts
get a directory; others are never written to disk and are refused. `mutation`
runs inside each write's own transaction: it may refuse by throwing, stamp Content
metadata into the same write, and learn the committed Content through `committed`.
That runs after the outermost transaction commits, so a write joined to an enclosing
transaction that rolls back reports nothing; a throwing `committed` is logged.
`synchronize` wraps each write of polled disk edits, for example in a host run.
Disk content that differs from what was last applied is copied to
`<root>/.conflicts/<directory>/<time>-<id>/` before anything overwrites it, and
`conflicted` is told. Only the newest `keptConflicts` sets (20 by default) are
kept. After each apply, the applied tree is noted in `<root>/.applied/`, so a later
process can tell stale bytes from a real disk edit.

`stageProjection` and `projectionMatches` write or check a read-only copy of chosen
paths from one frozen Content in a directory of the caller's choosing, outside the
filesystem's directories. Hosts use them for a selected release's files.

Use `blobFiles(root)` as `Artifacts`'s optional `files` capability to store blob
bytes in files. Those backing files remain separate from editable directories.
Changed bytes are staged before record commit. A rewritten object's previous
backing file and every unreferenced blob are removed after commit. Each operation
reclaims the blobs it released; `sweep` is the full backstop. `ArtifactApplicationError` means records
committed but directory application needs recovery. `filesystem.recover()` restores
directories from records and removes abandoned backing files. Close Workspaces
and the filesystem when their owner stops.

## Public entries

Import the contract, model, errors, identifiers, artifact cursor, constants,
`digestTree` and the manager from `@foundry/artifacts`; the stores live on their
own paths (see Storage).
`fileResponse` in `@foundry/artifacts/delivery` builds a ranged HTTP `Response`
for one stored file. Shared hashing,
canonical JSON, and Base64 helpers live in `@foundry/lib/digest`,
`@foundry/lib/json`, and `@foundry/lib/encoding`.

`list()` returns `Page<ArtifactResolved, ArtifactCursor>` from
`@foundry/core/pagination`: `items`, exact filtered `total`, and optional
`nextCursor`. Shared pagination helpers live in `@foundry/lib/pagination`.

Persistent stores implement `ArtifactStore`: detached reads, and one atomic
`commit(write)` that carries a whole change as puts and deletes. A store enforces
nothing; the manager checks every rule before a write reaches it. Artifact listings
take the filter, cursor and limit, so a page never loads the catalogue. An optional
`transaction(work)` keeps other managers over the same store from writing between a
change's reads and its commit; a plain commit waits for it, and a failed `work` keeps
none of its commits. Inside `work`, call the view: a `commit` or `transaction` on the
store itself from there rejects at once rather than waiting on itself. The manager runs
every change, and every read of several records, through it. A manager also takes its
own changes one at a time, since its turn keeps each Artifact's changes in call order
while their bytes are checked and staged (below). A call on a second manager over the
same store, made from inside the first manager's `transaction`, could wait in that turn
behind the second manager's own call, which waits for the transaction; the manager
refuses such a call at once instead, before any wait of its own. It sees only
transactions a manager opened over the same store object. A call made from inside a
`transaction` opened on the store directly, or on another wrapper of it, is not caught,
and waits forever when that manager already has a call waiting for the transaction.
Over a store without `transaction`, a manager runs its own changes one at a time and no
further.

`create`, `write` and `revise` take their bytes in before the change enters that
exclusion when `files` offers staging (`BlobFiles.staging`, an optional capability that
`blobFiles` implements): every input is read, hashed and written to the staging area
(`.staging/` under the blob root, which listing never reaches), so a slow or stalled
source holds neither the manager's queue nor the store, nor the JSON file lock. A
`BlobFiles` without `staging` keeps publishing the bytes inside the change. Before any
byte is staged, the change is checked against a consistent view that includes every
change this manager queued before it: names, ids, paths, blob references, fences, and
which objects an in-place write would rewrite. Inside the transaction the change checks
again, refuses with `StaleContentError` if a fence or the ownership of an object it would
rewrite changed meanwhile, resolves deduplication, promotes the staged files it keeps to
published names, and commits. Staging stops as soon as the bytes taken in exceed the tree
limit, and one manager reads at most eight streams ahead at once.

Changes one manager makes to the same Artifact commit in call order: a later change to
an Artifact waits for an earlier stream change to it to settle. A stalled stream
therefore delays later changes to that Artifact only; other Artifacts, reads and other
managers go on. Changes named by Content (`freeze`, `tag`, `setMetadata`, `deleteContent`, `fork`)
take their place in their Artifact's order while a stream change is pending. Order
across managers is not promised, nor for calls made inside `transaction(work)`. A stream that never ends holds back later
changes to its own Artifact through that manager for as long as it is pending; there is no
timeout, and the caller ends it by ending or erroring the source.

Staged files a change does not keep are discarded when it settles. Each `blobFiles`
instance stages under its own directory and refreshes it whenever it stages a file; a
directory no owner in this process holds is abandoned once it has gone 24 hours
unchanged, and removed the first time an instance stages and by `recover`. A single
chunk that takes longer than that to arrive can have its staging removed; its promotion
then fails and the change rejects, with nothing published.

Known limits: a stream is still read inside the exclusion when it is passed to a handle
inside `transaction(work)`, or when `files` has no `staging`. Pass streams to `create`,
`write` or `revise` directly.

Blob bytes commit as records: inline bytes inside the blob, or the name of an
immutable file `blobFiles` promoted or published before the commit. When a commit fails, the
manager removes those files only once the store shows the write absent; a commit that
failed after its write landed (a failed directory sync, say) keeps them.
`JsonArtifactStore` from `@foundry/artifacts/node` keeps every record in one JSON file,
rewritten per commit under a `<path>.lock` file so several processes can share it.
Manager reads take that lock too: they need a writable directory, create it and a
transient lock file, can wait on another process, and can throw `FileLockTimeoutError`.
It is interim: `SqliteArtifactStore` (below) is its replacement. Pair it with
`blobFiles` for bytes. The in-memory store does not import Node or SQLite.

## Storage

| Path                                  | Holds                                                         |
| ------------------------------------- | ------------------------------------------------------------- |
| `@foundry/artifacts/store`            | `ArtifactStore`, its write and listing types.                 |
| `@foundry/artifacts/store/memory`     | `MemoryArtifactStore`, the default `Artifacts` uses.          |
| `@foundry/artifacts/store/sqlite`     | `SqliteArtifactStore`, over a host's Drizzle database.        |
| `@foundry/artifacts/store/tables`     | The Drizzle tables it uses.                                   |
| `@foundry/artifacts/testing/store`    | `describeArtifactStore`, the suite every store passes.        |
| `@foundry/artifacts/node`             | `nodeArtifacts`, `JsonArtifactStore` (interim), `blobFiles`, and `artifactFileSystem`. |

`SqliteArtifactStore` takes the host's database and never opens one. The host
composes the tables from `./store/tables` into its own schema and owns the
migrations; `drizzle-orm` is an optional peer dependency, needed only on the
two SQLite paths. Every row carries a `scope`, an opaque partition the host
chooses (a workspace id, say), and a store reads and writes only its own. The
store keeps records only: blob bytes stay inline in a blob record or in the
files `blobFiles` publishes, whose names the records hold.

```ts
import { Artifacts } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";

const store = new SqliteArtifactStore({
  database, // a drizzle-orm/libsql database, or a transaction on one (see below)
  scope: workspaceId,
  // Optional: runs in the commit's transaction, after the store's statements.
  onCommit: async (transaction, write) => {
    await transaction.insert(changes).values({ write: summarize(write) });
  },
});
const artifacts = new Artifacts({ files: blobFiles(blobRoot), store });
```

The tables are `artifacts`, `artifact_contents` and `artifact_blobs`, one row per
record, field for field: a `Date` is integer epoch milliseconds, inline bytes are
a blob, metadata, a Content tree and a blob's chunks are JSON text, and a blob row
fills exactly one of `bytes`, `path` and `chunks`. Two lookup tables,
`artifact_content_blobs` and `artifact_blob_chunks`, hold one row per blob a
Content's tree or a blob's chunks name; the store rewrites them with each
Content or blob it puts, and `findReferences` reads them, since JSON cannot be
indexed. `artifacts` also keeps `name_lower`, `type_lower` and `id_lower`, each
field lower-cased by JavaScript's `toLowerCase`, and `id_order`, the id's UTF-16
code units as big-endian bytes. The text filter lower-cases its text in
JavaScript and matches those columns with `instr`, a plain substring test, so
`%` and `_` match only themselves and non-ASCII text folds as in the memory
store; SQLite's own `lower()` folds ASCII only. Ties in creation order sort and
page by `id_order`, which orders as JavaScript compares strings by code unit;
SQLite orders text by code point. Every filter is answered in SQL, and `limit`
bounds the rows a listing returns, the inputs SQLite text cannot compare
included. Text holding a lone
surrogate, which in JavaScript matches half of a stored pair, matches
`text_units`: the lower-cased name, type and id as UTF-16 code units in hex
(four digits and a comma per unit, the fields joined by `|`), where `instr`
finds a code-unit substring exactly, never starting inside a unit or crossing
a field. Text holding NUL matches nothing, since no stored text holds one, and
reads nothing. A cursor whose time is not a valid `Date` compares by `id_order`
alone, as the memory store's comparison reduces to, and the order stays by
time.

Each read is one indexed query, or two in one transaction (`listArtifacts`'
count and page, `findReferences`' two lookups); the table definitions say which
read each index serves, and the tests check every plan. `listBlobs` and
`listContents()` read one scope's run of an index.

Each `commit` is one transaction: the deletes, then the puts, then `onCommit`. A
throwing `onCommit` rolls it back, and a call to the store itself from the hook is
refused. The hook receives the write as committed, which is all it can learn of the
change: each record put, whole, as it now stands, and only the id of each record
deleted. A put does not say whether the record is new or replaced, there is no record
as it stood before, and a deleted Content or blob does not say which Artifact it
belonged to. The manager makes one commit per change, and none for a change that
writes nothing:

| Change                                          | The write holds                                         |
| ----------------------------------------------- | ------------------------------------------------------- |
| `create`                                        | the Artifact; with entries, its Content and new blobs   |
| `write`, `revise`                               | the Artifact, its Content(s), each blob put or rewritten |
| `rename`, `archive`, `patchArtifactMetadata`, … | the Artifact                                            |
| `setMetadata`, `tag`                            | the Content                                             |
| `freeze`, `fork`, `select`                      | the Artifact(s) and Content(s) they change              |
| `deleteContent`                                 | the Content's id, and blobs it alone named              |
| `delete`                                        | the Artifact's id, its Contents' ids, blobs they alone named |
| `sweep`                                         | the Contents' and blobs' ids it removes                 |
| several operations in `transaction`             | one write: the net records of them all, and every event  |

A blob only one file names is rewritten in place, so a write can put a blob id that
already exists. A record put and deleted within one change arrives as a delete of an
id the store never held.

### Change events

The write also carries `events`: what the change did, as change events
(`ArtifactEvent`, schema `artifactEventSchema` in `./schema`, types exported from
`.`), in the order its operations made them. The manager's operations build them,
never a store; a host records them in `onCommit`, on the transaction it is handed,
so an event lands exactly when its change does: once per commit that succeeds, never
for one refused or rolled back.

Every store keeps no record of events. Each takes them as they stand when `commit` is
called, as plain JSON, before it copies the records: a part that has no JSON form
reading back the same (a Date, a class instance, `NaN`, `-0`, a bigint, `undefined`, a
function, a hole in an array) refuses the whole write with a `TypeError` naming it.
`describeArtifactStore(name, open, mode)` holds every store to that refusal, directly
and through a transaction's view. `mode` is required: `{ hooked: false }` for a store
with no host hook, or `{ hooked: true, recording }` for one with a hook, where
`recording` opens storage whose hook records each commit's events in the commit's own
transaction (`RecordingArtifactStores`: `failNextCommit`, `recorded`, `stores`). The
suite then proves the hook is handed every kept commit's events, in order, and none of
a refused or rolled-back one.

An event is plain JSON: `{ type, id, at, artifactId, ... }`. `id` is a UUID, unique,
made with the write before `commit`. `at` is when the manager built the event, an ISO
time: it cannot establish commit order, as managers' clocks and commits interleave. A
host orders events by its own sequence, such as the position of the row its `onCommit`
writes. An event about one version names it as `contentId`. A handler reads the records
for anything more, except after `artifact.removed`, which carries what identified the
Artifact.

| Event                 | Emitted when                                                                   | Also carries                          |
| --------------------- | ------------------------------------------------------------------------------ | ------------------------------------- |
| `artifact.created`    | `create` files an Artifact                                                     |                                       |
| `artifact.forked`     | `fork` files an Artifact from another's Content (not also `created`)           | `contentId`, `sourceArtifactId`, `sourceContentId` |
| `artifact.written`    | `write` edits the active Content in place, or makes the first one              | `contentId`                           |
| `artifact.revised`    | `revise` makes a successor Content and selects it                              | `contentId`, `sourceContentId`        |
| `artifact.frozen`     | a ready Content is frozen: by `freeze`, or as the source of `revise` or `fork`, on the Content's own Artifact | `contentId` |
| `artifact.published`  | `freeze` publishes an Artifact never published before                          | `contentId`: the Content frozen       |
| `artifact.selected`   | `select` points the Artifact at another of its Contents                        | `contentId`                           |
| `artifact.cleared`    | `clearFailedContent` drops the pointer to a failed Content                     | `contentId`                           |
| `artifact.tagged`     | `tag` sets or clears a Content's tag, to a value it did not have               | `contentId`, `tag` (or `null`)        |
| `artifact.updated`    | `patchArtifactMetadata` or `setMetadata` leaves the metadata different         | `contentId`: the Content, or `null` for the Artifact |
| `artifact.renamed`    | `rename` to another name                                                       | `name`                                |
| `artifact.archived`   | `archive` of an Artifact not archived                                          |                                       |
| `artifact.unarchived` | `unarchive` of an archived Artifact                                            |                                       |
| `artifact.removed`    | `delete` removes an Artifact, and its Contents with it                         | `name`, `artifactType` (its `type`)   |
| `artifact.discarded`  | `deleteContent` or `sweep` removes one Content                                 | `contentId`                           |

Every Artifact a write changes gets an event naming that change on that Artifact. An
operation that performs another records that one's event too, in the order they
happen: `create` with entries is `created` then `written`, with its `freeze` option
`tagged`, `updated`, `frozen` and `published` after; `revise` of a ready source is
`frozen` (the source) then `revised`; `fork` of a ready source is `frozen` on the
source's Artifact then `forked` on the new one; a `deleteContent` of the active Content
is `selected` (the replacement) then `discarded`.

An operation that changes nothing (the same name, an Artifact already archived, or not
archived for `unarchive`, the tag a Content has, metadata that comes out as it was, a
Content already frozen, a `write` that leaves the active Content's tree, bytes and
metadata as stored) writes nothing and makes no event. Events are a record of
operations, not a net difference: an Artifact created and deleted inside one
`transaction` carries `created`, `written` and `removed`.

Within `transaction`, an operation on the handle is all or nothing. One refused before
it wrote anything leaves the transaction as it was, and the operation may catch the
refusal and go on. One refused after it wrote part of the change (a `create` whose first
Content refuses, say) leaves the transaction unable to commit: it rejects with
`TransactionRolledBackError`, keeping no record and no event, whatever the operation
caught, as a failed joined call does.

`transaction(work)` runs `work` in one database transaction over a view; each commit
through the view is a savepoint, and the view refuses calls once `work` settles. In this
process the store's calls take turns, so one made while a transaction runs waits for it.
Across connections, every transaction takes SQLite's write lock at its first statement:
Drizzle's libSQL driver begins every transaction with `BEGIN IMMEDIATE` and offers no
deferred one through the database type the store accepts. So every manager read of
several records, every change's pre-staging check, and `recover`'s walk of the blob
directory hold the write lock while they run. Staging bytes holds no lock: a change
checks in one transaction, takes its bytes in outside any, then commits in another.

Host requirement: the store's queue covers only its own instance. Within one process,
the host must serialize writes per database file across every client and store on it
(Marbles does). A second libSQL client in the same process does not wait usefully:
libSQL waits out its busy timeout synchronously, holding up the thread the first client
needs to commit, so it blocks for the whole timeout and then fails with `SQLITE_BUSY`.
Do not open the same file with a second SQLite library in the process either. Connection
settings such as WAL and the busy timeout are the host's.

On a local libSQL file, a commit either lands or throws having landed nothing,
`SQLITE_BUSY` included: libSQL rolls back a transaction whose `COMMIT` fails. (Over a
remote connection, a failure reported after the commit reached the server could leave
it landed; the read-back below covers that case too.) The manager then reads
the store back, finds the write absent, and removes the files the change published.
Only if that read fails too does it keep them, with no record naming them, until
`recover` removes them.

Each store takes a write as it stands when `commit` is called: one
`structuredClone` of the whole write, made before the commit waits its turn or a
lock, through a transaction's view as well. Only that copy is checked, made into
rows and handed to `onCommit`, so a caller changing the write later changes
nothing, and no getter or `toJSON` of the caller's runs while it is encoded (the
copy has none). Each blob's inline bytes are copied again into a buffer of their own,
since `structuredClone` keeps a `SharedArrayBuffer`'s memory shared; what a store holds
then shares memory with nothing, and neither do the copies its reads hand out. A write
the clone refuses, one holding a function or a symbol, rejects whole with the clone's
error, in every store. A listing likewise reads its
query as it stands at the call, and every store refuses a `limit` that is not a
positive safe integer (SQLite would read a negative one as no limit).

A storage limit of the SQLite store, not a rule of the package: `commit` refuses, before
any statement runs, a write holding a value SQLite would not give back as written, with
a `RangeError` naming the field (`putContents[0].tag`, say), through a transaction's view
as well:

- In a plain text column (an id, a name, a type, a status or state, a digest, a tag, a
  backing path, and each blob id a tree or chunk list names): U+0000, which libSQL reads
  back cut short, or text that is not well-formed UTF-16 (a lone surrogate), which is
  bound changed. A read or delete by such a key finds nothing, and the constructor
  refuses such a `scope`.
- Inside a JSON column (metadata, a tree, chunks): `-0`, a number that is not finite,
  `undefined`, an array hole, an object that is not plain (a `Date`, a `Map`), or a
  cycle. JSON escapes NUL and lone surrogates, so strings keep them.
- `byteLength` that is not a safe integer, or is `-0`; a time that is not a valid
  `Date`; a blob with other than one of `bytes`, `path` and `chunks`, or with a source
  key present and `undefined` (the row could only read it back absent).

A row the store would not have written (a blob row with no source, or two) fails the
read that meets it, naming the blob and the scope.

A store says when a commit that resolved is there for good, as `durability`:
`"commit"`, at once, or `"host"`, only once a transaction the store sits inside, which
someone else owns, commits. `SqliteArtifactStore` is `"host"` over any Drizzle
transaction passed as `database`, which it detects, and refuses `durability:
"commit"` there. Pass `durability: "host"` for a host transaction the store cannot see
in its `database` (none arises with Drizzle's libSQL driver, which hands every
transaction over as such an object, so this path is not exercised on libSQL). The memory
and JSON stores are `"commit"`, and every store's transaction view is `"host"`: its
commits stand only if the transaction's work succeeds, so a manager built over a view
keeps what it retires too.

Over a `"host"` store the manager cannot know a landed change will last, so it never
removes a file committed records may name: not the files a change stopped naming, and
not in `recover`, which it refuses with an error saying to run it from a manager over
the durable store, outside the host's transaction. A host rollback therefore reads every
file the change retired. A retired file, and a file a rolled-back change published, stays
until such a durable `recover` runs; nothing removes it before then, however long that
is.

Reclaiming is a manager over a `"commit"` store: retired files go once its own commit
lands, and its `recover` removes every file no record names. It reads committed records
under the store's exclusion, so it never runs while a host transaction on its database is
unsettled: on SQLite that transaction holds the write lock, and the durable `recover`
fails with `SQLITE_BUSY` (or waits out its busy timeout) and removes nothing; through a
store's own `transaction`, on every store, it waits for the transaction to settle, then
sees its outcome.

Over a `"host"` store, bindings, observers and `afterCommit` effects still run once the
store's commit resolves, before the host's outcome is known. A directory bound to such a
manager may then show a change the host rolled back until it applies the records again.

Known limits:

- A listing's `limit` bounds the rows it returns, not the work behind them. Text holding
  a lone surrogate (matched on `text_units`), a cursor whose time is not a valid `Date`
  (which compares by `id_order`, and no index orders by `id_order` alone), and `total`
  (a count of every match) can each examine every Artifact in the scope. Ordinary text
  is matched with `instr` and examines them too; type and cursor filters search their
  index.

- libSQL defect (`@libsql/client` 0.18.0): after it refuses a `BEGIN` with
  `SQLITE_BUSY` (another process or connection holds the write lock), the refused
  statement stays in progress on that client's connection, and the client's next
  transactions fail at `COMMIT` with "SQL statements in progress". In the default
  rollback-journal mode that failed transaction also leaves a lock behind that stops
  every other connection's `COMMIT` to the file, in any process, and closing the client
  did not release it in testing. In WAL mode only that client is affected, and a
  new client works. Nothing lands either way, and the manager removes what such a change
  published. A host meets this only once its busy timeout runs out; it should use WAL
  and reopen a client that has reported `SQLITE_BUSY`.
- Some manager calls make one query per item: `putBlob` lists every blob for each
  published file it puts, to refuse a backing path another blob holds; collecting
  unreferenced blobs reads each candidate and its references; `sweep` reads each old
  Content's Artifact; and a listing inside a change reads each Artifact the change
  touched. Each is a candidate for a store read of its own.
- The lower-cased columns are written by the JavaScript runtime that commits. A runtime
  on another Unicode version can fold a new character differently from the one that
  wrote the row.

The store takes calls in turns through `Turns` from `@foundry/lib/turns`, as the memory
and JSON stores do, and refuses a call from inside its own transaction or hook with a
`ReentrantCallError` saying to use the view or the transaction instead (via
`@foundry/lib/async-scope` on Node and Bun).

## Development

Run checks from the repository root:

```bash
bun run test --filter=@foundry/artifacts
bun run typecheck --filter=@foundry/artifacts
bun run check packages/artifacts
bun run build --filter=@foundry/artifacts
```

Package tests own `Artifacts`, blob, and directory behavior. The store conformance
suite in `@foundry/artifacts/testing/store` and the `Artifacts` suite in
`@foundry/artifacts/testing/artifacts` also support host-provided store implementations.
`@foundry/artifacts/testing` holds test doubles: `interceptCommits` wraps a store's
commits for fault injection. Hosts own their persistence and
migration tests. Lib owns encoding and pagination helper tests.
