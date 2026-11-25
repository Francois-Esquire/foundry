# @foundry/sandbox

One `Sandbox` interface over different backends — a microVM container or an in-memory filesystem — plus one set of agent tools that
binds to all of them identically.

Storage contracts come from the dependency-free `@foundry/core/storage`.
The virtual system and container expose `files` implementing `Storage`, including strict
`readDirectory` and atomic `replaceFile`, over the same files used by commands.
Zod is the only required external runtime dependency. Install `just-bash` for
`/virtual/system` and `microsandbox` for `/container/microsandbox-runtime`. The package lists
these peers as development dependencies to build and test its adapters.

MicroSandbox is pinned to `0.6.18` in development and peer dependencies. Its
native inventory includes `created`, `starting`, and `paused` states. The
registry stops active orphaned VMs before removing them.

```typescript
interface Sandbox {
  workingDirectory: string;
  files: SandboxFilesystemFacet;
  commands: SandboxCommandFacet;
}
```

A container is a `Sandbox` with more on it: `processes`, `ports`, `services`, `shell`, and
`volumes` when mounts are allowed.

## Quick start

### Give an agent tools over a sandbox

```typescript
import { createSandboxToolkit } from "@foundry/sandbox/tools/toolkit";

const toolkit = createSandboxToolkit(sandbox, {
  limits: { maxOutputChars: 50_000, maxCallsPerMinute: 120 },
  audit: { record: (event) => log(event) },
});

toolkit.tools; // read · write · edit · grep · glob · cd · bash
toolkit.instructions; // the system-prompt block describing them
toolkit.workingDirectory; // moves when the agent calls `cd`
```

Each tool is a plain `{ description, inputSchema, execute }` record — which is
structurally what an AI SDK tool is, so it drops into a harness without this
package depending on the SDK.

### Get a sandbox

```typescript
import { createContainers } from "@foundry/sandbox/container/containers";
import { createMicrosandboxRuntime } from "@foundry/sandbox/container/microsandbox-runtime";
import { MemoryContainerStore } from "@foundry/sandbox/store/memory";
import { createVirtualSystem } from "@foundry/sandbox/virtual/system";

const containers = createContainers({
  instanceLabel: "example",
  runtime: createMicrosandboxRuntime(),
  store: new MemoryContainerStore(),
});
const c = await containers.start({
  format: "foundry.sandbox.container/1",
  image: "docker.io/oven/bun:1-slim",
});
await c.commands.exec(["npm", "test"]);
await c.close();

const memory = createVirtualSystem({ files: { "notes.md": "hello" } });
```

A virtual sandbox is a value; a container is a handle you `close()`.

## How it comes together

```
src/types, path, errors, sandbox         the Sandbox vocabulary; no runtime imports
  virtual · container             the backends
  tools                                  read/write/edit/grep/glob/cd/bash over a Sandbox
  testing                                the fake container runtime
```

A backend outside this package builds its `Sandbox` with `sandboxFromAdapter`,
which owns path normalization.

**The toolkit binds to `files` and `commands`, never to a backend.** Where each
tool lands:

| Tool                         | Goes through | Why                                                                                      |
| ---------------------------- | ------------ | ---------------------------------------------------------------------------------------- |
| `read` `write` `edit` `glob` | `files`      | `glob` is `list` plus a pattern match — no backend reimplements it                       |
| `grep` `bash`                | `commands`   | `grep` is a _specialized exec_ whose argv the toolkit builds                             |
| `cd`                         | neither      | moves the toolkit's working directory; uses `list` to refuse an out-of-bounds move first |

`SandboxFilesystemFacet.search` is optional. Without it, the toolkit runs
`grep` through the sandbox command facet.

**Limits are split by what each layer can see.** The toolkit counts tool calls
and clips result text; it cannot count bytes, because one `grep` reads a whole
tree and only `files` sees those bytes. So byte ceilings belong to the
backend, which today caps command and service output, and call-rate and
output ceilings live on the tools (`SandboxToolLimits`).

---

## Portable contracts

Import portable contracts from `@foundry/sandbox/types`, adapters from
`@foundry/sandbox/sandbox`, errors from `@foundry/sandbox/errors`, and path
helpers from `@foundry/sandbox/path`. These modules need no concrete backend.

```typescript
interface SandboxFilesystemFacet {
  readFile(path): Promise<Uint8Array>;
  writeFile(path, content): Promise<void>;
  copyIn(files): Promise<void>;
  copyOut(path): Promise<Record<string, Uint8Array>>;
  list(path, options?): Promise<readonly SandboxDirectoryEntry[]>;
  isDirectory(path): Promise<boolean>;
  search?(pattern, options?): Promise<readonly SandboxSearchMatch[]>; // optional
}

interface SandboxCommandFacet {
  exec(command: SandboxCommand, options?): Promise<SandboxExecResult>;
}
```

`list` never follows symlinks, and a path that is not a readable directory
yields an empty list rather than throwing — so a scan over a partly-readable
tree degrades instead of failing.

`SandboxCommand` is `string | readonly string[]`. **Arrays execute directly as
argv. Strings execute through the backend's shell and never undergo host-side
interpolation.** That distinction is the injection boundary: build argv when
any part of the command came from a model.

```typescript
normalizeSandboxPath(path, workdir) / normalizeSandboxWorkingDirectory(dir);
DEFAULT_SANDBOX_WORKING_DIRECTORY;
SandboxError; // { code: "cancelled" | "invalid-contract" | "invalid-transition" | "provider-failed" }
sandboxFromAdapter(adapter); // a Sandbox over a backend's SandboxAdapter
```

POSIX glob matching lives in `@foundry/lib/glob` (`globToRegExp`).

Constants have scoped entry points: `@foundry/sandbox/constants`,
`@foundry/sandbox/container/constants`, and `@foundry/sandbox/tools/constants`.

## Storage

`ContainerStore` on `@foundry/sandbox/store` is the seam the containers
registry persists its rows through: `list()`, `get(id)`, and `commit(write)`,
where a write deletes and puts rows all or nothing, deletes first. A store
enforces nothing; the registry holds every rule. Values crossing the seam are
detached, reads hand out frozen rows, and `list()` returns rows in the order
first put (a row put again keeps its place). A store may offer
`transaction(work)`, which keeps every write from any registry over the store
out from between `work`'s reads and its commit; the registry runs each
read-modify-write through it when offered, and serializes its own writes
either way. `@foundry/sandbox/schema` defines `ContainerRow` as a Zod schema.

A store reads a write once, when `commit` is called. Both stores here take
its events by the event rule (see Change events) and the rest by one
`structuredClone` then, before the commit waits its
turn, and check, store and hand on (to `onCommit`) only that copy, through
a transaction's view as well. A caller that changes its write after the
call changes nothing, even while the commit is still queued. A write the
clone refuses, such as one holding a function, rejects and writes nothing.

| Path                             | Holds                                                              |
| -------------------------------- | ------------------------------------------------------------------ |
| `@foundry/sandbox/store`         | `ContainerStore`, `ContainerStoreWrite`, and the row types.        |
| `@foundry/sandbox/store/memory`  | `MemoryContainerStore`, the default `createContainers` uses.       |
| `@foundry/sandbox/store/sqlite`  | `SqliteContainerStore`, over a host's Drizzle database.            |
| `@foundry/sandbox/store/tables`  | The Drizzle table it uses: `sandbox_containers`.                   |
| `@foundry/sandbox/testing/store` | `describeContainerStore`, the suite every store passes.            |

`describeContainerStore(name, open, mode)` says, in `mode`
(`ContainerStoreMode`), whether the storage has a host hook: `{ hooked: false }`,
or `{ hooked: true, recording }`, where `recording` opens storage whose hook
records each write's events in the commit's own transaction
(`RecordingContainerStores`). Every store is held to the event rule above;
a hooked one is also proven to hand its hook every kept commit's events
once, in order, as they were when `commit` was called, and none for a
commit that fails.

`CONTAINER_ROW_STATUSES` lives in `@foundry/sandbox/container/constants`.

### Change events

Each registry write that changes a container's life carries the events that
say so, in `events` on the write, so a host can record them in the same
transaction as the change (the SQLite store's `onCommit`). The registry
builds them, from the row as stored against the row it puts. A store keeps
none, and one with a host hook hands them to it unchanged and in order.
Every store takes the events when `commit` is
called, by one rule: each is copied as plain JSON, and a write holding one
that is not (anything but plain objects whose own properties are all
enumerable, arrays without holes, text, finite numbers other than `-0`,
booleans and `null`) is refused whole with a `TypeError` naming it, through
a transaction's view too. It is the rule the workflows and artifacts stores
take their events by. The schema is
`sandboxEventSchema` on `@foundry/sandbox/schema`, which also exports the
type, `SandboxEvent` (re-exported from `@foundry/sandbox/store`). Every event
has `type`, `id` (unique to it, made once per registry call, before its
transaction), `at` (an ISO time, the stamp of the row it changed)
and `containerId`:

| `type`              | Emitted by                                                                         |
| ------------------- | ---------------------------------------------------------------------------------- |
| `sandbox.created`   | `start`, in the write that inserts the row                                         |
| `sandbox.started`   | the write that moves the row into `running`: a first boot, a reopen (after a failure too) or a restart |
| `sandbox.stopped`   | the write that moves the row into `stopped`: its last handle closing, or `shutdown` |
| `sandbox.failed`    | the write that moves the row into `failed`: a boot that does not come up           |
| `sandbox.destroyed` | `remove`, in the write that deletes the row; none if it was already gone           |

A row that enters `starting` or `restarting`, a new native name, a spec
recorded for the next boot, and a row put again in the status it already has
carry no event.

`at` is the stamp of the record a change wrote, or the time the event was
built where the change stamps none; it is not the commit time, and two
writers' events can commit in the other order from their `at`. It cannot
establish commit order: a host that needs one orders events by its own
sequence, assigned in `onCommit`.

Both stores take their calls in turns: a call made while a transaction runs
waits for it, and a call to the store from inside its own transaction's work
(or the SQLite store's `onCommit` hook) is refused at once with a
`ReentrantCallError` that says to use the view, instead of waiting on itself
forever. The registry calls only the view inside a transaction.

`SqliteContainerStore` takes the host's database and never opens one.
The host composes the table from `./store/tables` into its own schema and
owns the migrations; `drizzle-orm` is an optional peer dependency, needed
only on the two SQLite paths. Every row carries a `scope`, an opaque
partition the host chooses (a workspace id, say), and a store reads and
writes only its own. The table also has a `position` column: the store
assigns it when a row is first put, keeps it when the row is put again, and
lists rows by it.

```ts
import { createContainers } from "@foundry/sandbox/container/containers";
import { SqliteContainerStore } from "@foundry/sandbox/store/sqlite";

const store = new SqliteContainerStore({
  database, // a drizzle-orm/libsql database, or a transaction on one
  scope: workspaceId,
  // Optional: runs in the commit's transaction, after the store's statements.
  onCommit: async (transaction, write) => {
    await transaction.insert(changes).values({ write });
  },
});
const containers = createContainers({ instanceLabel, runtime, store });
```

Each `commit` is one database transaction, and a throwing `onCommit` rolls
it back. `onCommit` receives the store's copy of the write, its `events`
included, and uses the `transaction` it is given. `get` and `list` are
one query each. `transaction(work)` runs `work` in one database transaction;
a commit through its view that fails rolls back only itself. Across
connections, each transaction takes SQLite's write lock at its first
statement: Drizzle's libSQL driver begins every transaction with
`BEGIN IMMEDIATE`. A write from another process then waits for as long as its
connection's busy timeout allows, or fails with `SQLITE_BUSY`. Either way it
never lands between a transaction's reads and its commit.

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
refuses, before writing anything and through a transaction's view as well, a
write SQLite would not give back intact, with a `RangeError` naming the
field, such as `putContainers[0].spec`:

- Text holding U+0000, or text that is not well-formed UTF-16 (a lone
  surrogate), in `id`, `nativeId`, `spec`, or `status`. libSQL reads text
  back cut at its first NUL; a lone surrogate is bound as U+FFFD on Node and
  as nothing on Bun, so it reads back changed and could match another row's
  id. A `get` or delete by such an id finds nothing, and the store refuses
  such a `scope`.
- A `createdAt` or `updatedAt` that is NaN, an infinity, `-0`, or beyond
  `±Number.MAX_SAFE_INTEGER`. The schema takes any number; the columns are
  integers. libSQL refuses to bind NaN and the infinities, `-0` reads back as
  `0`, and an integer past the safe range is kept as a 64-bit integer that
  libSQL then refuses to read. Every other number, whole or fractional,
  reads back exactly. The registry writes `Date.now()`, which always fits.

`nativeId` is the one field that may be `undefined`; its column is NULL
then, and a NULL reads back as `nativeId: undefined`, the key present.

## Sandbox tools

```typescript
createSandboxToolkit(sandbox: Sandbox, options?): SandboxToolkit;
createSandboxToolSchemas(options?): SandboxToolSchemas; // shapes only, no binding
```

```typescript
interface SandboxToolkitOptions extends SandboxToolGuards {
  tools?: readonly SandboxToolName[]; // narrows instructions only
  resolvePath?: (path: string, access: { create: boolean }) => Promise<string>; // host path policy
  limits?: SandboxToolLimits;
  audit?: SandboxToolAudit;
}
```

`resolvePath` sees every path a tool is about to hand the sandbox, already
resolved against the working directory. A host that jails the agent to a
workspace canonicalizes or refuses there once, rather than wrapping each facet
method or the commands the toolkit builds.

`createSandboxToolSchemas` gives you the descriptions and input schemas with no
sandbox attached — for a renderer that needs to _describe_ the tools before one
exists.

### Guards

```typescript
interface SandboxToolLimits {
  maxOutputChars?: number; // default 50_000, applied to every result
  maxCallsPerMinute?: number; // default 120, rolling window
}

interface SandboxToolEvent {
  at;
  tool;
  input;
  outcome: "allowed" | "refused" | "failed";
  reason?: string;
  path?; // absent on a refusal
  truncated?;
}
```

Two details worth keeping when you touch this: **`path` is absent on a
refusal**, so a denial never records where it would have landed; and audit is
fire-and-forget, because recording must never block or fail a tool call.

Exceeding the call rate throws `SandboxRateLimitError` — a refusal, not a
failure.

## Workspaces integration

The application composes Workspaces with a sandbox's storage. Neither package
imports the other; both implement the Core contracts.

```typescript
import { directory, Workspaces } from "@foundry/workspaces";

const system = new Workspaces().extend(
  directory({ filesystem: container.files }),
);
try {
  const workspace = await system.load({ path: container.workingDirectory });
  const files = await workspace.files();
} finally {
  await system.closeAll();
  await container.close();
}
```

For host-backed work, mount the selected directory into the container and bind
its guest path. File and command operations then reach the same mounted bytes;
the container's mounts and runtime policy define access. Workspace inclusion
rules govern the catalog, not what guest commands may read inside the mount.

## `@foundry/sandbox/virtual/system`

An in-memory filesystem and shell interpreter. No process, no container, no disk.

```typescript
createVirtualSystem(options?): VirtualSystem; // a Sandbox, plus `bash`
```

The fastest way to exercise anything that takes a `Sandbox`.

## Container modules

MicroSandbox microVMs, through the containers registry.

### Piped processes

`container.processes.spawn(argv, options)` asynchronously launches a non-TTY
process with separate byte streams, `exitCode`, `killed`, synchronous
`kill(signal)`, and `on`/`once`/`off`/`removeListener` for `exit` and `error`.
`exited` preserves nonzero status and rejects on launch, transport, or abort
failure. Drain both output streams to maintain backpressure. Explicit
environment variables are merged with the sandbox environment; the host's
environment is not copied. Aborting launch or a running process reaps it.
Closing the last container handle cancels its piped processes.

`prepareSandboxProcess` from `@foundry/sandbox/process` returns a Node stream
handle immediately while an asynchronous spawn is pending. It buffers stdin
with backpressure, retains an early kill, and forwards launch errors. Use this
for synchronous child-process hooks. Portable contracts use structural streams
so filesystem and command consumers need no Node ambient types.

SDK 0.6.18 reports `-1` for a signaled exit without the actual signal. This
adapter preserves that value and emits a null signal; it does not invent a
POSIX status or claim an observed signal.

### Egress and workspace execution

Guest egress defaults to denied, including the direct provisioner. Constraints
accept `network: "disabled"`, explicit `"unrestricted"`, or an exact destination
allowlist:

```typescript
network: {
  mode: "allowlist",
  destinations: [{ host: "api.openai.com", ports: [443] }],
}
```

Ports default to 443. Allowlist mode applies native deny-by-default TCP rules,
strict hostname authority checks, and native TLS interception with upstream
certificate verification. The runtime installs its CA into the guest. Listed
ports require TLS; choose HTTPS destinations. Wildcards and URLs are rejected
by the constraints schema. Native host port bindings stay on loopback.

Reached/refused destination auditing remains incomplete. A real successful
HTTPS request and a denied hostname request produced TLS setup messages in
native system logs, but no destination decision records. The adapter does not
manufacture network audit events. Strict HTTPS authority requires interception,
as described in the [MicroSandbox networking reference](https://docs.microsandbox.dev/sdk/typescript/networking#network-strict).

A mount can set `executable: true` for project tools. Other mounts default to
`noexec`; every bind mount retains `nosuid` and `nodev`. Config and credential
mounts should stay read-only with execution disabled.

```typescript
const containers = createContainers({ runtime, store, instanceLabel });
await containers.sweep(); // boot: stop VMs with our labels and no row
const c = await containers.start(spec); // new row, new VM, a handle
const c = await containers.open(id); // join a row; restarts its VM if not live here
await c.commands.exec(["bun", "test"]);
await c.ports.hostPort(3000); // { host, port } | undefined
await c.services.start({ id, argv, readiness });
await c.shell.open();
await c.volumes?.list(); // only when the registry has allowedMountRoots
await containers.restart(id, newSpec); // the one change mechanism; handles follow
await c.close(); // last handle out stops the VM, row -> stopped
await containers.list(); // rows for the UI
await containers.shutdown();
```

One persisted row per container, one VM per row at a time, a handle per holder.
The owner keeps the row id, the way an installation keeps `containerId`.

```typescript
interface Container extends Sandbox {
  id: string;
  row: ContainerRow;
  processes: SandboxProcessesFacet;
  ports: SandboxPortsFacet;
  services: SandboxServicesFacet;
  shell: SandboxShellFacet;
  volumes?: SandboxVolumesFacet;
  close(): Promise<void>;
}
```

Every facet on a handle reads through to the current VM. Don't hold one across
a `restart`.

Change is restart. The microVM runtime cannot change ports or network policy on
a live VM, so `restart(id, spec?)` replaces the VM under the same row: status
`restarting`, old VM removed, new VM under `<rowId>-<n+1>`, status `running`.
On a row not live in this process, `restart` only records the spec for the next
`open`.

Row status, persisted, is the one state: `starting`, `running`, `restarting`,
`missing`, `stopped`, `failed`.

`close` never deletes a row; the owner calls `remove(id)` when it goes, which
refuses while a handle is open. `open`, `remove` and `shutdown` wait for an
in-flight release of the same row, so a stop never overlaps the next boot.

A VM is not adopted across processes. `open` on a row that is not live in this
process removes whatever the runtime still holds under the old native name and
boots again under `<rowId>-<generation>`.

Every store has an identity of its own (`ContainerStore.identity`). A store in
memory makes a fresh one per instance. A durable store keeps an id in its
database, the same for every process over that database and scope; the SQLite
store combines it with `location`, where the host says the database lives
(Marbles gives the real path of its database file), so a byte copy of the
database, which carries the id, still has another identity. Without a
`location` the identity is the kept id alone, and a copy shares it. A home
that is moved or renamed gets a new identity: the VMs it booted before the
move are then not provably its own, so they are passed over and named, never
removed, and taken out by hand as below. The registry puts
it on every VM it boots, as the `com.foundry.container.store` label. A VM is a
row's only when all three say so: it carries this store's identity, its name
is one of that row's own (`<rowId>-<generation>`), and its id label names that
row. Every stop or removal asks this right before it acts (`recover`,
`remove`, `sweep`, the retries of `sweep` and `shutdown`, `open`'s removal of
the old VM, a close, a restart, a failed boot), and a VM is kept to retry only
if it passes. The instance label names a workspace, not a store, so two
engines over one workspace root (two Foundry homes, or a script with no host
database beside a daemon) share it; the store label is what keeps one's sweep
from taking the other's VMs.

A VM that does not pass is never stopped or removed, and never left unseen.
`recover` and `remove` name one that bears a claimed row's id or name in
`conflicts` and keep the row `removing`. `sweep` (and `recover`, through it)
names every VM under this instance's labels it could not prove its own in
`passedOver`: another store's, one with no store or no id label, one whose
name and label disagree. When `open` cannot read the runtime's inventory, the
old VM's name, the row's own, is kept to retry, and judged once the inventory
can be read; the registry says so through `report` (stderr by default).

VMs booted before stores had an identity carry no store label, so no sweep or
recovery removes them now. `msb` is the CLI of the `microsandbox` package
Foundry installs, at `node_modules/.bin/msb` in the install (it is not put on
PATH). List them with
`msb list --label com.foundry.environment.managed-by=foundry-sandbox`, check
one's labels with `msb inspect <name>`, and remove one, running or not, with
`msb rm -f <name>` (`-f` stops a running VM first). Every message that names a
VM left this way gives the same command (`removeByHand`).

A registry owns every VM it boots. If the commit that records a boot fails
(a SQLite store busy under another connection's lock, say), `start`, `open`
or `restart` removes the VM it just booted, tries to mark the row `failed`,
and rejects with the commit's error. A VM the registry cannot remove stays
the registry's: after a failed post-boot commit, after a guest setup that
failed, when its last handle closes, or when `open` or `remove` fails to
stop or remove an old native name (the runtime cannot say whether such a VM
is gone or stuck). `sweep` and `shutdown` retry it against the runtime's
inventory, which drops a VM that is gone; `shutdown` rejects while one
remains, and calling `shutdown` again retries it.

Limits:

- The list of VMs the registry could not remove is in memory. If the process
  is lost first, their cleanup is not guaranteed: the next process's `open`
  removes a VM whose name the row still records, but not one whose row has
  moved on to a later name. `remove` and `recover` delete a row only once
  every VM labelled with its id is gone, whatever its name.
- VMs a crashed engine left over a store in memory (a script with no host
  database) carry that store's identity, which no later store has: no one
  removes them, and they are named only by a start that reads the inventory.
- A row left `removing` whose claiming process still runs, as when two
  engine generations overlap, is named by no start while that process runs;
  once it is gone, a start takes the row over and retries it.
- `sweep` removes VMs; it does not repair rows. A row left `starting`,
  `restarting` or `running` with no VM (after a commit that failed while a
  VM was removed) stays so until a later `open` or `remove` of it.
- Once `open` has failed to stop an old native name, `shutdown` reads the
  runtime's inventory to settle it, even when that VM was simply gone.

Every container is parameterized by its spec: image, workdir, public
environment, ports, `resources` (memory, cpus, pids), network, mounts, labels,
and `detached`. `detached` defaults to `false`, so a VM dies with the process;
set it to `true` to let a VM outlive the process (experimental: nothing
reattaches yet, so the next `open` replaces it).

`createMicrosandboxRuntime()` is the real `ContainerRuntime`.

## `@foundry/sandbox/testing`

```typescript
createFakeContainerRuntime(options?): FakeContainerRuntime;
```

One file, `src/testing.ts`: an in-memory `ContainerRuntime` to put under
`createContainers` in a consumer's tests. It scripts `exec`, records every
booted instance, and can fail installs, stops and removes.

---

## Notes

### Entry points

The `./*` export maps leaf modules to source and built declarations, matching
Foundry's other packages. There is no root barrel. Imports from the sister
repository's root, `/tools`, `/container`, and `/virtual` barrels must use the
corresponding leaf module. For example, `createSandboxToolkit` comes from
`@foundry/sandbox/tools/toolkit` and `createContainers` comes from
`@foundry/sandbox/container/containers`.

Types resolve from `dist/*.d.ts`. Rebuild before a consumer typechecks
against a changed public API.

### Testing this package

One Vitest configuration defines two projects:

| Script             | What                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `test`             | `unit` project: portable contracts, virtual backend, fake container runtime, and import boundaries |
| `test:integration` | `integration` project: `*.integration.test.ts`, requires an installed MicroSandbox runtime |

`src/test/helpers/sandbox-contract.ts` is the battery virtual and container both
pass: argv versus shell, byte round trips, enumeration, traversal refusal.

Run the package checks from the repository root:

```sh
bun run test --filter=@foundry/sandbox
bun run typecheck --filter=@foundry/sandbox
bun run dead-code --workspace packages/sandbox
bun run turbo run test:integration --filter=@foundry/sandbox
bun run validate
```

Integration tests are uncached and require the native runtime and local port
access. Turbo forwards `MSB_HOME` when a separate runtime home is configured.

To install the SDK's matching runtime in a separate directory, set `MSB_HOME`
to an absolute path and keep it set for the test run:

```sh
export MSB_HOME="$HOME/.microsandbox-foundry-integration"
bun run --cwd packages/sandbox setup:integration
bun run --cwd packages/sandbox test:integration
```

Setup downloads the runtime binaries. It requires `MSB_HOME` explicitly to avoid
replacing the shared runtime installation.

`stdio.integration.test.ts` mounts this package read-only and checks `ls`,
`cat`, command errors, and interactive output before the next input is sent.
It exercises the adapter's combined terminal stream, the SDK's separate
stdout/stderr pipes, and public process pipes, including binary input, EOF,
nonzero exit, named signals, missing executables, launch/running cancellation,
backpressure, and guest process reaping. `piped-lifecycle.integration.test.ts`
checks the public registry facet and immediate hook bridge, including closing
a container with a live process. Network and executable workspace integrations
verify native destination rules and mount flags separately.
`commands.exec()` collects output until exit. The MicroSandbox backend keeps
the last 16 MiB of each of stdout and stderr; the virtual backend is bounded by
just-bash's `maxOutputSize` limit on their combined size. `shell.open()` exposes
live terminal output. `processes.spawn()` exposes separate live pipes.

```sh
bun run --cwd packages/sandbox test:integration -- src/test/stdio.integration.test.ts
```

`module-gateway-websocket.integration.test.ts` compares the Modules hello and
heartbeat exchange on a host Bun server and through a MicroSandbox VM, with
default and `Connection: close` HTTP health probes. It requires matching Bun
versions and revisions, reports the one-second application deadline separately,
and asserts a real clean socket close within five seconds in every case.

```sh
bun run --cwd packages/sandbox test:integration -- src/test/module-gateway-websocket.integration.test.ts --reporter=verbose --silent=false
```

### Observed native TCP close limitation

On 2026-10-03, the npm SDK and its selected bundled runtime both reported
`0.6.18`. The close comparison passed both direct host cases and failed
both VM cases plus the port-forward close test. Host and guest Bun were
`1.3.14` at revision `0d9b296af33f2b851fcbf4df3e9ec89751734ba4`;
the host client ran on Node `26.4.0`. Guest close callbacks recorded code
1000 and reason `done`, while host sockets stayed in `CLOSING` for five seconds.

A native SDK probe importing no Foundry code reproduced the WebSocket timeout.
A separate native TCP probe received `native-eof` from a guest `socket.end()`
but saw no host `end` event within two seconds, under both denied-egress and
the SDK's default policy. This isolates the observed failure below the Foundry
adapter; the exact native cause has not been established. The current changes
leave the disabled-network forwarding branch and background service transport
unchanged. No application workaround or runtime replacement was applied.

Reproduce the existing close checks with:

```sh
bun run --cwd packages/sandbox test:integration -- module-gateway-websocket port-forward-websocket --reporter=verbose --silent=false
node_modules/@superradcompany/microsandbox-darwin-arm64/bin/msb --version
```

The global `~/.microsandbox/bin/msb` separately reports `0.6.8`, but the SDK's
`dist/internal/resolve-binary.js` selects the platform package's bundled binary
and `napi.js` installs that path into the native resolver. `MSB_PATH` was unset,
and a direct `msbPath()` check returned the bundled `0.6.18` binary. These close
failures therefore already reproduce with a matching runtime. No runtime was
installed or upgraded during this diagnosis; the native close failures remain
part of the integration result.
