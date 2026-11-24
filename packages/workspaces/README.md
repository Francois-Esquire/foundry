# @foundry/workspaces

The Workspace system. A Workspace is the durable registration of one
authoritative source; an entry is one included path within it. The source owns
current bytes — the package owns identity, inclusion, and the last
successfully reconciled inventory.

`WorkspaceEntry` adds identity, name, and timestamps to Core's `StorageEntry`.
`WorkspaceFile` is its regular-file variant, with content classification and
extension. Scans retain directories, including empty ones, and describe links,
sockets, devices, and pipes without opening them. Links are never traversed.
The root remains on `WorkspaceSource`; actual file contents are read from storage.
Saves accept `expectedDigest` for the version last read.

File classification, kinds, and their constants live in `@foundry/lib/file-classification`.
Package constants live in `@foundry/workspaces/constants`; Node watcher constants stay under `src/node/constants.ts`.

The root `Workspace` class owns identity, the catalog, reconciliation, and
the serialization guarantee. It delegates byte access to a composed
`WorkspaceSourceAdapter`. Every source and capability is a `WorkspaceExtension`
that supplies a source adapter and/or attaches capabilities and lifecycle hooks
when the system opens an instance.

The root entry has no Node runtime imports or default storage. Its directory
layer requires caller-supplied storage: `directory({ filesystem })`.
`WorkspaceFileSystem` combines `StorageReader` and `AtomicStorageWriter` from
`@foundry/core/storage`. Storage owns its path separator; catalog paths
remain POSIX. Digests use Web Crypto.

For Node disk access, import the default directory adapter from `/node`:

```ts
import { WorkspaceSystem } from "@foundry/workspaces";
import { git } from "@foundry/workspaces/git";
import { directory } from "@foundry/workspaces/node";

const workspaces = new WorkspaceSystem().extend(directory()).extend(git());
const page = await workspaces.list({ limit: 20 }); // opens only this page
const next =
  page.nextCursor === undefined
    ? undefined
    : await workspaces.list({ limit: 20, cursor: page.nextCursor });

const ws = await workspaces.load({ path: "." });
const entries = await ws.entries();
const files = await ws.files();
const summary = await ws.summary();
const gitStatus = await ws.git?.status();

await ws.refresh(); // reconcile → { workspace, entries, source }
await ws.read(fileId);
await ws.save({ fileId, text, expectedDigest });
await ws.createFile({ path: "notes/todo.md", text });
await ws.rename(name);
await ws.registration(); // trusted: carries the source root
await ws.remove(); // forgets the registration and closes the instance

await workspaces.closeAll();
```

Subscribe to committed catalog changes on the system:

```ts
const unsubscribe = workspaces.on("change", ({ action, entry }) => {
  // action: "add" | "change" | "delete"
  // entry includes workspaceId, id, path, and the storage descriptor.
});
unsubscribe();
```

Add/change carries the committed entry; delete carries its last known value.
Registration, refresh, save, create, and removal can emit changes; every one
is published by the catalog the moment it commits. Removal forgets catalog
entries without deleting source files. Unchanged observations emit nothing.
Delivery is in-process, with no replay; listeners receive detached payloads
and their failures go to `onError` (default: `console.error`) rather than
failing committed operations. Closing an instance does not unsubscribe system
listeners. Changes made outside this system are observed on the next refresh.
Enable storage observation to refresh automatically.

## Persistence

`WorkspaceStore` (on `@foundry/workspaces/store`) is the persistence seam: it
keeps registrations and their entries and applies one write atomically, and
enforces nothing else. `MemoryWorkspaceStore` (on
`@foundry/workspaces/store/memory`) is the default. Supply another store to
persist elsewhere:

```ts
const workspaces = new WorkspaceSystem({ store, onError: log });
```

The system drives a catalog over that store, and the catalog owns every rule:
one Workspace per canonical root and per source reference, entries owned by
their Workspace, a valid tree after every change, and each change applied
whole or refused. A store implementation therefore only persists; those rules
come with the system. Catalog mutations and per-Workspace observations, saves,
and removals each run one at a time in-process. Each catalog mutation reads
and commits inside the store's optional `transaction`, so a second system over
the same store cannot write between them; both stores here offer one. Over a
store without it, a second system can still interleave.

| Path                                | Holds                                                               |
| ----------------------------------- | ------------------------------------------------------------------- |
| `@foundry/workspaces/store`         | `WorkspaceStore` and its write types.                               |
| `@foundry/workspaces/store/memory`  | `MemoryWorkspaceStore`, the default `WorkspaceSystem` uses.         |
| `@foundry/workspaces/store/sqlite`  | `SqliteWorkspaceStore`, over a host's Drizzle database.             |
| `@foundry/workspaces/store/tables`  | The Drizzle tables it uses: `workspaces`, `workspace_entries`.      |
| `@foundry/workspaces/testing/store` | `describeWorkspaceStore`, the suite every store passes.             |

Both stores read in the same fixed orders. Registrations sort by creation
time, then by id in code-point order, which is how SQLite compares text.
Entries sort by path in code-unit order, then by id. No read answers in the order
rows were put, so the tables have no `position` column. `listWorkspaces`
pages by offset; its cursor must be a nonnegative safe integer. A save's
entry deletes name entries of its own Workspace, and each put is filed under
the entry's own `workspaceId`. A removal names only the Workspace. It deletes
the registration and every entry filed under it, in one commit, and a store
ignores any entry ids a caller hands it.

A store reads a write once, when `commit` is called. Both stores here take
its events by the event rule (see Change events) and the rest by one
`structuredClone` then, before the commit waits its
turn, and check, store and hand on (to `onCommit`) only that copy, through
a transaction's view as well; `listWorkspaces` reads its cursor and limit
when called too. A caller that changes its write or its input after the
call changes nothing, even while the call is still queued. A write the
clone refuses, such as one holding a function, rejects and writes nothing.

### Change events

Each write the catalog makes that changes a Workspace carries the events that
say so, in `events` on the write, so a host can record them in the same
transaction as the change (`SqliteWorkspaceStore`'s `onCommit`). The catalog
builds them from what the store holds against what the change leaves. A
store keeps none, and one with a host hook hands them to it unchanged and in
order. Every store takes the events when `commit` is
called, by one rule: each is copied as plain JSON, and a write holding one
that is not (anything but plain objects whose own properties are all
enumerable, arrays without holes, text, finite numbers other than `-0`,
booleans and `null`) is refused whole with a `TypeError` naming it, through
a transaction's view too. It is the rule the workflows and artifacts stores
take their events by. The schema is
`workspaceEventSchema` on `@foundry/workspaces/schema`; the type,
`WorkspaceEvent`, is exported from the package root too. Every event has
`type`, `id` (unique to it, made once per catalog call, before its transaction),
`at` (an ISO time) and `workspaceId`:

| `type`                      | Emitted by                                                     | Also carries                  |
| --------------------------- | -------------------------------------------------------------- | ----------------------------- |
| `workspace.created`         | `create`, when it registers the Workspace; `at` its `createdAt` |                               |
| `workspace.updated`         | `rename`, when the name changes; `at` the new `updatedAt`      |                               |
| `workspace.entries.changed` | `applyChange`, when it adds, changes or removes any entry       | `added`, `changed`, `removed` |
| `workspace.removed`         | `remove`, when the Workspace was there; `at` the time it ran   |                               |

`workspace.entries.changed` carries entry ids only, never the records, and is
`at` the change's `updatedAt` (the time it ran, when the caller gave none).
`applyChange` works out what a change does to the entries stored before it
writes, publishes or emits: an entry put as it is stored, or removed and put
back as it was, is no change and is left out of all three; one removed and
put back different is a change. A change that leaves every entry as it was
writes no `updatedAt` and emits nothing. A Workspace's first entries come
with `workspace.created`, not as a separate entries event, and a removal
names no entries. A `create` over an id already registered answers
`workspace-exists` with that id and writes nothing. A reconciliation that
finds nothing new, a rename to the same name, and a refused change carry no
event.

`at` is the stamp of the record a change wrote, or the time the event was
built where the change stamps none; it is not the commit time, and two
writers' events can commit in the other order from their `at`. It cannot
establish commit order: a host that needs one orders events by its own
sequence, assigned in `onCommit`.

### SQLite

`SqliteWorkspaceStore` takes the host's database and never opens one. The
host composes the tables from `./store/tables` into its own schema and owns
the migrations; `drizzle-orm` is an optional peer dependency, needed only on
the two SQLite paths. Every row carries a `scope`, an opaque partition the
host chooses, first in every key. Marbles passes its workspace id. A store
reads and writes only its own scope.

```ts
import { WorkspaceSystem } from "@foundry/workspaces";
import { SqliteWorkspaceStore } from "@foundry/workspaces/store/sqlite";

const store = new SqliteWorkspaceStore({
  database, // a drizzle-orm/libsql database, or a transaction on one
  scope,
  // Optional: runs in the commit's transaction, after the store's statements.
  onCommit: async (transaction, write) => {
    await recordChange(transaction, write);
  },
});
const workspaces = new WorkspaceSystem({ store, onError: log });
```

The tables hold each record field for field. A `Date` is integer epoch
milliseconds. A registration's `source` spreads over `source_kind`,
`source_path`, and `source_id`. One `workspace_entries` row holds any entry
type; the columns only a file has (`bytes`, `digest`, `extension`, `kind`,
`mime`) and a symlink's `target` are null on the other types, and a read
gives back only the fields the row's type has. Each read is one indexed
query, except `listWorkspaces`, which is two:

| Read                       | Served by                                                     |
| -------------------------- | ------------------------------------------------------------- |
| `getWorkspace`             | the primary key `(scope, id)`                                 |
| `listWorkspaces`           | `workspaces_scope_created (scope, created_at, id)`, a count   |
| `findWorkspaceByPath`      | `workspaces_scope_source_path (scope, source_path, created_at, id)` |
| `findWorkspaceBySourceId`  | `workspaces_scope_source_id (scope, source_id, created_at, id)` |
| `getEntry`, `listEntries`  | the primary key `(scope, workspace_id, id)`                   |

`listEntries` sorts in the store, because SQLite's collation orders text by
code point, not by code unit.

Each `commit` is one transaction, ending with `onCommit`; a throwing
`onCommit` rolls it back. A save runs its entry deletes, its entry puts and
the registration. A removal runs two statements, one deleting every entry row
of the Workspace and one deleting its registration, each through a primary
key. A save's entries are batched under SQLite's bound-parameter limit inside
the one transaction, so a save of thousands of entries lands whole.
`onCommit` receives the write as committed, its `events` included. A removal
carries only the Workspace id, so a hook that wants to record which entries
a removal dropped does not get their ids from the store.
`onCommit` uses the `transaction` it is given; a call to the store itself
from the hook is refused (see below). `listWorkspaces` reads its count and
its page in one database transaction, so it is one state. On libSQL that
transaction holds the write lock while it reads: Drizzle's libSQL driver
begins every transaction with `BEGIN IMMEDIATE` and offers no deferred
(read-only) transaction through the database type the store accepts.

Two systems over one `SqliteWorkspaceStore` are kept apart. In this process
the store's calls take turns, so one made while a transaction runs waits
for it. Across connections, each transaction takes SQLite's write lock at
its first statement. A write from another process then waits for as long
as its connection's busy timeout allows, or fails with `SQLITE_BUSY`.
Either way it never lands between a transaction's reads and its commit.

Host requirement: the store's queue covers only its own instance. Within
one process, the host must serialize writes per database file across every
client and store on it (Marbles does). A second libSQL client in the same
process does not wait usefully: libSQL waits out its busy timeout
synchronously, holding up the thread the first client needs to commit, so
it blocks for the whole timeout and then fails with `SQLITE_BUSY`. Do not
open the same file with a second SQLite library in the process either
(`bun:sqlite` or `node:sqlite` beside libSQL): SQLite's file locks are per
process, so the two libraries do not see each other's locks at all.
Connection settings such as WAL and the busy timeout are the host's.

A defect of `@libsql/client` 0.18.0, which the store cannot work around: a
client whose `BEGIN` fails with `SQLITE_BUSY` keeps the failed statement
open, and its next transaction fails at `COMMIT` with "SQL statements in
progress". In rollback-journal mode the file can stay blocked even for a
fresh client; in WAL mode a fresh client works. The store cannot reset a
client it was handed. So a host should put the database in WAL mode, and
replace its client after a `SQLITE_BUSY`.

Storage limits of the SQLite store, not rules of the package. `commit`
refuses, before writing anything, a write holding a value SQLite would not
give back as it was bound, with a `RangeError` naming the field, such as
`putEntries[0].path` or `workspace.source.path`; commits through a
transaction's view are checked the same way:

- Text holding U+0000, in any text field. libSQL reads text back cut at its
  first NUL.
- Text that is not well-formed UTF-16, in any text field. A lone surrogate
  is bound as U+FFFD on Node and as nothing on Bun, so it reads back changed
  and could match another row's key. The text fields are the ids, names,
  paths, the source, the type, and a file's digest, extension, kind, and
  MIME type.
- A `bytes` of `-0`. The schema accepts it, and SQLite gives back `0`. A
  `bytes` that is not a safe integer is refused too.
- A `Date` that is not valid.

A read or delete by a key no row can hold finds nothing, and the constructor
refuses such a `scope`.

A read that meets an entry row this store would not have written rejects
with an `Error` naming the scope, the Workspace, the entry, and the column
at fault. That covers a type the package does not know, a column the type
always has left null (a file's `bytes`, `digest` or `kind`, a symlink's
`target`), a column only another type has filled, and an unknown file kind.
The tables carry no `CHECK` constraints, so a host's own writes are checked
only when read.

Every store takes one call at a time, so a call to the store itself from
inside its own transaction's `work` (or from `onCommit`) could only wait for
itself. It is refused at once with a `ReentrantCallError` from
`@foundry/lib/turns` that says to use the view, or the transaction, instead.
A caller that is merely concurrent with a transaction still waits its turn.
The stores tell the two apart by asynchronous context, with
`AsyncLocalStorage` from `node:async_hooks`, so the package needs a runtime
that provides it: Node, Bun, Deno, or a worker runtime with Node
compatibility.

Known limit: saving a Workspace File is last write wins, as before this
store; neither store compares a version when it commits.

Storage observation is optional. `directory({ filesystem, observer })` uses an
explicit `StorageObserver`, or the filesystem's own `watch` capability when
present. Its signals request reconciliation; only committed differences emit
`change`. The workspace subscribes before its initial refresh, coalesces bursts,
and rescans when another signal arrives during a scan. `close` and `closeAll`
unsubscribe, cancel pending work, and await the running observation.

```ts
import { nodeObserver } from "@foundry/workspaces/node/watch";

const workspaces = new WorkspaceSystem().extend(
  directory({ observer: nodeObserver }),
);
// ...
await workspaces.closeAll();
```

The Node adapter uses recursive `fs.watch`. If it fails to start or reports
an error, it falls back to polling. Native watching stays outside the portable
root import. For storage without a native signal, pass `polling(intervalMs)`
from `@foundry/workspaces`. Polling and native watchers observe current state;
they do not record every intermediate write or provide a durable event log.

An extension is a `WorkspaceExtension`: `applies(registration)` decides from
the stored registration, `source(registration)` supplies the
`WorkspaceSourceAdapter` for a source-owning extension, and `attach(workspace)`
returns optional capabilities and `start`/`stop` lifecycle hooks. Extensions
apply in registration order so later attachments can read earlier capabilities.
A record no source extension claims is refused at open with
`WorkspaceSourceUnsupportedError`.

The system is the source of every Workspace. A source extension also names the
ref `load` accepts (`ref: "path"`) and turns it into a registration
(`identify`); `load` dispatches on the key. Every extension carries three types
the system accumulates through `extend` — the ref, what `load(ref)` returns,
and what every opened Workspace carries — so a composed system's `load`,
`open`, and `list` are typed by exactly the extensions it holds. An extension
that applies per record declares its capability optional (`{ git?: Git }`).

Composition by hand needs no registry:

```ts
import { directorySource, Workspace } from "@foundry/workspaces";

const ws = new Workspace(
  registration,
  context,
  directorySource(registration.source.path, { filesystem }),
);
```

Lifecycle `start` and `stop` hooks run in registration order on open and in
reverse order on close.

An instance fixes `id` and `source` at construction and reads everything else
from the catalog per call, so two instances of one id never disagree. Every
refresh scans after it was asked — it never joins a scan already in flight —
and an instance reopened while its predecessor's work is still running waits
behind it.

`@foundry/workspaces/node` also exports `directorySource` with default disk
storage and `nodeFileSystem`.

Git is opt-in on `@foundry/workspaces/git`: the `git()` layer, plus
`Git.at(root)`, `Git.open(root)`, `Git.isRepository(root)`, and worktrees on
the resulting `Git`.

A new `WorkspaceStore` proves itself against the conformance suite on
`@foundry/workspaces/testing/store`: `describeWorkspaceStore(name, open, mode)`
registers Vitest tests. `open()` returns fresh, empty storage, or a promise
of it, as a function `(scope: string) => WorkspaceStore`. Two scopes over one
storage must never see each other's records. The third argument,
`mode` (`WorkspaceStoreMode`), says whether the storage has a host hook:
`{ hooked: false }`, or `{ hooked: true, recording }`, where `recording`
opens storage whose hook records each write's events in the commit's own
transaction (`RecordingWorkspaceStores`). Every store is held to the event
rule; a hooked one is also proven to hand its hook every kept commit's
events once, in order, as they were when `commit` was called, and none for
a commit that fails. The package runs it against
the memory store and against the SQLite store on libSQL, in memory and on a
file, with tables created from `./store/tables` by `createTables` from
`@foundry/lib/testing/sqlite`.

Tests live in `src/test/`. The build emits declarations; runtime exports resolve
to TypeScript source. Run lint and formatting checks from the repository root.

## Scripts

```bash
bun run --cwd=packages/workspaces test
bun run --cwd=packages/workspaces typecheck
bun run lint
bun run format
bun run --cwd=packages/workspaces build
```
