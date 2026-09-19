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

const ws = await workspaces.add({ path: "." });
await ws.refresh();
const entries = await ws.entries();
const files = await ws.files();
const summary = await ws.summary();
const gitStatus = await ws.git?.status();

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
Registration, refresh, save, and removal can emit changes. Removal forgets
catalog entries without deleting source files. Unchanged observations emit
nothing. Delivery is in-process, with no replay; listeners receive detached
payloads and their failures do not fail committed operations. Closing an
instance does not unsubscribe system listeners.

Stores implement `afterCommit(callback)` to defer delivery until the outer
transaction commits and discard callbacks on rollback. The in-memory store
runs callbacks immediately. Changes made outside this system are observed on
the next refresh. Enable storage observation to refresh automatically.

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
signal, pass `polling(intervalMs)` from `@foundry/workspaces/observation`.
Polling and native watchers observe current state; they do not record every
intermediate write or provide a durable event log.

A layer is a `WorkspaceExtension`: `applies(record)` decides from the stored
row, `wrap(Base)` is the mixin. Layers apply in registration order, each
extending the class the previous one returned, so `super` runs the chain. The
layer that answers `scan`, `readFile`, and `writeFile` must come first for its
source; anything after it only adds. A record no layer claims is refused at
open with `WorkspaceSourceUnsupportedError`.

The system is the source of every Workspace. A floor also names the ref
`add` accepts (`ref: "path"`) and turns it into a registration (`identify`);
`add` dispatches on the key. Every extension carries three types the system
accumulates through `extend` — the ref, what `add(ref)` returns, and what
every opened Workspace carries — so a composed system's `add`, `open`, and
`list` are typed by exactly the layers it holds. A layer that applies per
record declares its capability optional (`{ git?: Git }`).

Composition by hand needs no registry:

```ts
import { WithDirectory, Workspace } from "@foundry/workspaces";

const Cls = WithDirectory(Workspace, { filesystem });
const ws = new Cls(record, context);
```

`start` and `stop` are protected hooks the system alone calls; a layer that
holds a resource overrides them and calls `super`.

An instance fixes `id` and `source` at construction and reads everything else
from the store per call, so two instances of one id never disagree and both
join the same in-flight observation.

`WorkspaceStore` is the persistence capability the system consumes.
`InMemoryWorkspaceStore` is the default. Supply another `WorkspaceStore` to
persist registrations and entry catalogs elsewhere.

`@foundry/workspaces/node` also exports `WithDirectory` with default disk
storage, `nodeFileSystem`, and the synchronous `sha256Hex` helper.

Git is opt-in on `@foundry/workspaces/git`: the `git()` layer, plus
`Git.at(root)`, `Git.open(root)`, `Git.isRepository(root)`, and worktrees on
the resulting `Git`.

The exported conformance suite remains available at
`@foundry/workspaces/tests/helpers/workspace-system-conformance` for adapter
implementations. Its source lives in `src/test/helpers/`; the public subpath
is retained for compatibility.

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
