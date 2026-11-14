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
the serialization guarantee. It knows nothing about where bytes come from.
Every source and every capability is a layer: a class mixin the system wraps
around the root when it opens an instance.

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

Reads answer in fixed orders, the same in both stores: registrations by
creation time, then by id in code-point order (the order SQLite gives text);
entries by path in code-unit order, then by id. No read answers in the order
rows were put, so the tables have no `position` column. `listWorkspaces`
pages by offset; its cursor must be a nonnegative safe integer. A write's
entry deletes name entries of its own Workspace; each put is filed under the
entry's own `workspaceId`. A removal deletes the registration and exactly
the entries it names; the catalog names every entry the Workspace has, so
all of its rows go in one commit.

### SQLite

`SqliteWorkspaceStore` takes the host's database and never opens one. The
host composes the tables from `./store/tables` into its own schema and owns
the migrations; `drizzle-orm` is an optional peer dependency, needed only on
the two SQLite paths. Every row carries a `scope`, an opaque partition the
host chooses (Marbles passes its workspace id), first in every key; a store
reads and writes only its own.

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

Each `commit` is one transaction: the entry deletes, the entry puts, the
registration, then `onCommit`; a throwing `onCommit` rolls it back. Large
writes are batched under SQLite's bound-parameter limit inside that one
transaction, so a save or removal of thousands of entries lands whole.
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

Storage limits of the SQLite store, not rules of the package. `commit`
refuses, before writing anything, a write holding a value SQLite would not
give back as it was bound, with a `RangeError` naming the field, such as
`putEntries[0].path` or `workspace.source.path`; commits through a
transaction's view are checked the same way:

- text holding U+0000 (libSQL reads text back cut at its first NUL), or
  text that is not well-formed UTF-16 (a lone surrogate is bound as U+FFFD
  on Node and as nothing on Bun, so it reads back changed and could match
  another row's key), in any text field: ids, names, paths, the source, the
  type, and a file's digest, extension, kind, and MIME type;
- a `bytes` that is `-0` (the schema accepts it; SQLite gives back `0`) or
  not a safe integer;
- a `Date` that is not valid.

A read or delete by a key no row can hold finds nothing, and the constructor
refuses such a `scope`.

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

The Node adapter tries optional `@parcel/watcher`, then recursive `fs.watch`.
If neither starts, or the active watcher reports failure, it polls. Native
watching stays outside the portable root import. For storage without a native
signal, pass `polling(intervalMs)` from `@foundry/workspaces`.
Polling and native watchers observe current state; they do not record every
intermediate write or provide a durable event log.

A layer is a `WorkspaceExtension`: `applies(registration)` decides from the
stored registration, `wrap(Base)` is the mixin. Layers apply in registration order, each
extending the class the previous one returned, so `super` runs the chain. The
layer that answers `scan`, `readFile`, and `writeFile` must come first for its
source; anything after it only adds. A record no layer claims is refused at
open with `WorkspaceSourceUnsupportedError`.

The system is the source of every Workspace. A floor also names the ref
`load` accepts (`ref: "path"`) and turns it into a registration (`identify`);
`load` dispatches on the key. Every extension carries three types the system
accumulates through `extend` — the ref, what `load(ref)` returns, and what
every opened Workspace carries — so a composed system's `load`, `open`, and
`list` are typed by exactly the layers it holds. A layer that applies per
record declares its capability optional (`{ git?: Git }`).

Composition by hand needs no registry:

```ts
import { WithDirectory, Workspace } from "@foundry/workspaces";

const Cls = WithDirectory(Workspace, { filesystem });
const ws = new Cls(registration, context); // context: catalog, serialize, report, close
```

`start` and `stop` are protected hooks the system alone calls; a layer that
holds a resource overrides them and calls `super`.

An instance fixes `id` and `source` at construction and reads everything else
from the catalog per call, so two instances of one id never disagree. Every
refresh scans after it was asked — it never joins a scan already in flight —
and an instance reopened while its predecessor's work is still running waits
behind it.

`@foundry/workspaces/node` also exports `WithDirectory` with default disk
storage and `nodeFileSystem`.

Git is opt-in on `@foundry/workspaces/git`: the `git()` layer, plus
`Git.at(root)`, `Git.open(root)`, `Git.isRepository(root)`, and worktrees on
the resulting `Git`.

A new `WorkspaceStore` proves itself against the conformance suite on
`@foundry/workspaces/testing/store`: `describeWorkspaceStore(name, open)`
registers Vitest tests. `open()` returns fresh, empty storage (or a promise
of it) as a function `(scope: string) => WorkspaceStore`; two scopes over one
storage must never see each other's records. The package runs it against
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
