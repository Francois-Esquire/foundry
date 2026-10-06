# `@foundry/artifacts`

Package constants live in `@foundry/artifacts/constants`. General MIME helpers live in `@foundry/lib/mime`.

`@foundry/artifacts` defines the shared Artifact vocabulary and the
[`Artifacts`](src/substrate.ts) contract. An Artifact keeps stable product identity
while its active Content changes. `ArtifactManager` owns behavior and accepts an
`ArtifactStore`: `InMemoryArtifactStore` here or a host-provided persistent store.

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

Accept `Artifacts`, or the smallest `Pick<Artifacts, ...>` your code needs. Let the host
provide the implementation.

```ts
import type { Artifacts } from "@foundry/artifacts";

import { HTML_MIME } from "@foundry/lib/mime";

export function createPage(artifacts: Artifacts) {
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
Create a manager with the included in-memory store:

```ts
import { ArtifactManager, InMemoryArtifactStore } from "@foundry/artifacts";

export function createArtifacts() {
  return new ArtifactManager({ store: new InMemoryArtifactStore() });
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
host-specific operations; matching never invokes them. Studio owns domain
registrations and Module runtime resolution. Module constants live in
`@foundry/modules/constants`.

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

StorageTree paths use forward slashes, have no leading slash, and cannot contain empty, `.` or
`..` segments. `metadata.entry`, named entries, and `thumbnail` point to paths in the
StorageTree. Use `readRoot`, `readNamedRoot`, `readThumbnail`, or `readFile` to load bytes.

Deleting active Content requires a replacement in the same operation. Deleting an
Artifact cascades through its Content unless another owner pins a frozen version; pinned
deletion throws `ArtifactInUseError` or `ContentInUseError`. `sweep` removes old,
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
import { directory, WorkspaceSystem } from "@foundry/workspaces";

const filesystem = artifactFileSystem({ artifacts, root });
const workspaces = new WorkspaceSystem({ store }).extend(
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
changes; required application uses `bind` and does not depend on events.

Use `blobFiles(root)` as `ArtifactManager`'s optional `files` capability to store blob
bytes in files. Those backing files remain separate from editable directories.
Changed bytes are staged before record commit. A rewritten object's previous
backing file and every unreferenced blob are removed after commit. Each operation
reclaims the blobs it released; `sweep` is the full backstop. `ArtifactApplicationError` means records
committed but directory application needs recovery. `filesystem.recover()` restores
directories from records and removes abandoned backing files. Close Workspaces
and the filesystem when their owner stops.

## Public entries

Import the contract, model, errors, identifiers, artifact cursor, MIME values,
`digestTree`, the manager, and the in-memory store from `@foundry/artifacts`.
`fileResponse` in `@foundry/artifacts/delivery` builds a ranged HTTP `Response`
for one stored file. Shared hashing,
canonical JSON, and Base64 helpers live in `@foundry/lib/digest`,
`@foundry/lib/json`, and `@foundry/lib/encoding`.

`list()` returns `Page<ArtifactResolved, ArtifactCursor>` from
`@foundry/core/pagination`: `items`, exact filtered `total`, and optional
`nextCursor`. Shared pagination helpers live in `@foundry/lib/pagination`.

Persistent stores implement `ArtifactStore`: every record access happens through
the `ArtifactStoreTransaction` its `transaction` method supplies. That interface
documents the integrity rules a store must enforce. A SQLite adapter is not
included in this repository. `JsonArtifactStore` from `@foundry/artifacts/node` keeps every
record in one JSON file, rewritten per commit under a `<path>.lock` file so
several processes can share it. Pair it with `blobFiles` for bytes. It suits a
local feed's scale, not a large catalogue. Neither the manager nor the in-memory store imports Node
or SQLite.

## Development

Run checks from the repository root:

```bash
bun run test --filter=@foundry/artifacts
bun run typecheck --filter=@foundry/artifacts
bun run check packages/artifacts
bun run build --filter=@foundry/artifacts
```

Package tests own manager, blob, and directory behavior. Shared suites in
`@foundry/artifacts/testing/store` and `@foundry/artifacts/testing/manager` also
support host-provided store implementations. Hosts own their persistence and
migration tests. Lib owns encoding and pagination helper tests.
