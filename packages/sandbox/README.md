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

A container is a `Sandbox` with more on it: `ports`, `services`, `shell`, and
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
import { createMemoryContainerStore } from "@foundry/sandbox/container/store";
import { createVirtualSystem } from "@foundry/sandbox/virtual/system";

const containers = createContainers({
  instanceLabel: "example",
  runtime: createMicrosandboxRuntime(),
  store: createMemoryContainerStore(),
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
src/types, path, glob, errors, sandbox   the Sandbox vocabulary; no runtime imports
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
tree and only `files` sees those bytes. So per-file and per-sandbox byte
ceilings live on the backend (`HostLimits`), and call-rate and output ceilings
live on the tools (`SandboxToolLimits`).

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

`@foundry/sandbox/container/store` exports `ContainerStore`, `ContainerRow`,
`ContainerRowStatus`, and `createMemoryContainerStore` without importing a
runtime. `CONTAINER_ROW_STATUSES` lives in
`@foundry/sandbox/container/constants`.

Constants have scoped entry points: `@foundry/sandbox/constants`,
`@foundry/sandbox/container/constants`, and `@foundry/sandbox/tools/constants`.

## Sandbox tools

```typescript
createSandboxToolkit(sandbox: Sandbox, options?): SandboxToolkit;
createSandboxToolSchemas(options?): SandboxToolSchemas; // shapes only, no binding
```

```typescript
interface SandboxToolkitOptions extends SandboxToolGuards {
  tools?: readonly SandboxToolName[]; // restrict the set
  limits?: SandboxToolLimits;
  audit?: SandboxToolAudit;
}
```

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
import { directory, WorkspaceSystem } from "@foundry/workspaces";

const system = new WorkspaceSystem().extend(
  directory({ filesystem: container.files }),
);
try {
  const workspace = await system.add({ path: container.workingDirectory });
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
containers.list(); // rows for the UI
await containers.shutdown();
```

One persisted row per container, one VM per row at a time, a handle per holder.
The owner keeps the row id, the way an installation keeps `containerId`.

```typescript
interface Container extends Sandbox {
  id: string;
  row: ContainerRow;
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
It exercises the adapter's combined terminal stream and the SDK's separate
stdout/stderr pipes, including split UTF-8 input, EOF, and process exit.
`commands.exec()` collects output until exit; `shell.open()` exposes live
terminal output. Separate live pipes currently require the native SDK.

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
