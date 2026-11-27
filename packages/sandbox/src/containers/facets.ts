import { SandboxError } from "../errors";
import { normalizeSandboxPath } from "../path";
import type {
  SandboxCommand,
  SandboxDirectoryEntry,
  SandboxEndpoint,
  SandboxExecOptions,
  SandboxPortsFacet,
  SandboxProcessesFacet,
  SandboxProcessStatus,
  SandboxService,
  SandboxServiceExit,
  SandboxServicesFacet,
  SandboxShell,
  SandboxShellFacet,
  SandboxShellOptions,
  SandboxStartServiceInput,
  SandboxVolumesFacet,
} from "../sandbox";
import { sandboxFromAdapter } from "../sandbox-adapter";
import type { ContainerFacets } from "./contracts";
import { CONTAINER_PORTABLE_ID_PATTERN } from "./defaults";
import type {
  ContainerMount,
  ContainerSpec,
  DriverExecOptions,
  DriverHandle,
} from "./driver";
import { isTcpPort } from "./spec";

const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_TERMINATION_GRACE_MS = 5000;
const MAX_TERMINATION_GRACE_MS = 30_000;
const DEFAULT_READINESS_INTERVAL_MS = 50;
const GUEST_WATCH_INTERVAL_MS = 1000;

export interface AttachedContainer {
  disconnect(): Promise<void>;
  readonly facets: ContainerFacets;
  readonly handle: DriverHandle;
  remove(): Promise<void>;
}

interface AttachOptions {
  readonly fetch?: typeof globalThis.fetch;
}

interface ContainerState {
  readonly mounts: Map<
    string,
    { readonly spec: ContainerMount; mounted: boolean }
  >;
  readonly services: Map<string, SandboxService>;
}

export function attachContainer(
  handle: DriverHandle,
  spec: ContainerSpec,
  options: AttachOptions = {}
): AttachedContainer {
  const lifetime = new AbortController();
  let removed = false;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const guest = createGuestAdapter(handle, spec, lifetime.signal);
  return Object.freeze({
    async disconnect() {
      if (removed) {
        return;
      }
      lifetime.abort(new SandboxError("cancelled", "Sandbox disconnected"));
      await handle.disconnect?.();
      removed = true;
    },
    facets: buildContainerFacets(guest, handle, spec.mounts, fetchImpl),
    handle,
    async remove() {
      if (removed) {
        return;
      }
      lifetime.abort(new SandboxError("cancelled", "Sandbox removed"));
      await handle.remove();
      removed = true;
    },
  });
}

type GuestAdapter = ReturnType<typeof createGuestAdapter>;

function createGuestAdapter(
  handle: DriverHandle,
  spec: ContainerSpec,
  lifetime: AbortSignal
) {
  const active = (operation: string): DriverHandle => {
    if (lifetime.aborted) {
      throw new SandboxError(
        "invalid-transition",
        `Cannot ${operation}: sandbox ${handle.id} has been removed`
      );
    }
    return handle;
  };
  const at = (path: string): string => normalizeSandboxPath(path, spec.workdir);
  const execOptions = (
    options: SandboxExecOptions = {}
  ): DriverExecOptions => ({
    cwd: options.cwd === undefined ? spec.workdir : at(options.cwd),
    env: { ...spec.env, ...options.environment },
    ...(options.user === undefined ? {} : { user: options.user }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const list = async (
    path: string,
    recursive: boolean
  ): Promise<readonly SandboxDirectoryEntry[]> => {
    const entries = await active("listDirectory").list(path);
    if (!recursive) {
      return entries;
    }
    const found = [...entries];
    const pending = entries.filter((entry) => entry.type === "directory");
    while (pending.length > 0) {
      const directory = pending.pop();
      if (directory === undefined) {
        continue;
      }
      const children = await active("listDirectory").list(directory.path);
      found.push(...children);
      pending.push(...children.filter((entry) => entry.type === "directory"));
    }
    return found;
  };

  return {
    assertActive(operation: string): void {
      active(operation);
    },
    async copyIn(files: Readonly<Record<string, string | Uint8Array>>) {
      active("copyIn");
      for (const [path, content] of Object.entries(files)) {
        await active("copyIn").writeFile(path, toBytes(content));
      }
    },
    async copyOut(path: string): Promise<Record<string, Uint8Array>> {
      const type = await active("copyOut").stat(path);
      if (type === undefined) {
        throw new SandboxError("invalid-contract", `No file found at ${path}`, {
          details: { path },
        });
      }
      if (type === "file") {
        return { [path]: await active("copyOut").readFile(path) };
      }
      const copied: Record<string, Uint8Array> = {};
      if (type !== "directory") {
        return copied;
      }
      for (const entry of await list(path, true)) {
        if (entry.type === "file") {
          copied[entry.path] = await active("copyOut").readFile(entry.path);
        }
      }
      return copied;
    },
    async endpoint(guestPort: number): Promise<SandboxEndpoint | undefined> {
      const target = active("endpoint");
      return target.endpoint?.(guestPort);
    },
    async exec(command: SandboxCommand, options?: SandboxExecOptions) {
      return active("exec").exec(command, execOptions(options));
    },
    async isDirectory(path: string) {
      return (await active("isDirectory").stat(path)) === "directory";
    },
    lifetime,
    list,
    async openShell(options: SandboxShellOptions = {}): Promise<SandboxShell> {
      const target = active("openShell");
      if (target.execStream === undefined) {
        throw new SandboxError(
          "unsupported",
          "driver does not support interactive shell sessions"
        );
      }
      return target.execStream(
        options.command,
        execOptions({
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.environment === undefined
            ? {}
            : { environment: options.environment }),
        })
      );
    },
    async probePort(guestPort: number): Promise<boolean> {
      const target = active("probePort");
      if (target.probePort === undefined) {
        throw new SandboxError(
          "unsupported",
          "driver does not support TCP port readiness probing"
        );
      }
      return target.probePort(guestPort);
    },
    async readFile(path: string) {
      return active("readFile").readFile(path);
    },
    async spawn(command: SandboxCommand, options: SandboxExecOptions = {}) {
      const target = active("spawn");
      if (target.spawn === undefined) {
        throw new SandboxError(
          "unsupported",
          "driver does not support piped process spawning"
        );
      }
      options.signal?.throwIfAborted();
      const signal =
        options.signal === undefined
          ? lifetime
          : AbortSignal.any([lifetime, options.signal]);
      return target.spawn(command, execOptions({ ...options, signal }));
    },
    async startProcess(command: SandboxCommand, options?: SandboxExecOptions) {
      const target = active("startProcess");
      if (target.startProcess === undefined) {
        throw new SandboxError(
          "unsupported",
          "driver does not support background processes"
        );
      }
      return target.startProcess(command, execOptions(options));
    },
    storage:
      handle.storage === undefined
        ? undefined
        : {
            lstat: async (path: string) => {
              const s = active("storage").storage;
              if (s === undefined) {
                throw new SandboxError("unsupported", "storage unavailable");
              }
              return s.lstat(at(path));
            },
            readDirectory: async (path: string) => {
              const s = active("storage").storage;
              if (s === undefined) {
                throw new SandboxError("unsupported", "storage unavailable");
              }
              return s.readDirectory(at(path));
            },
            readFile: async (path: string) =>
              active("readFile").readFile(at(path)),
            readLink: async (path: string) => {
              const s = active("storage").storage;
              if (s === undefined) {
                throw new SandboxError("unsupported", "storage unavailable");
              }
              return s.readLink(at(path));
            },
            realpath: async (path: string) => {
              const s = active("storage").storage;
              if (s === undefined) {
                throw new SandboxError("unsupported", "storage unavailable");
              }
              return s.realpath(at(path));
            },
            replaceFile: async (path: string, bytes: Uint8Array) => {
              const s = active("storage").storage;
              if (s === undefined) {
                throw new SandboxError("unsupported", "storage unavailable");
              }
              return s.replaceFile(at(path), bytes);
            },
            separator: handle.storage.separator,
            writeFile: async (path: string, content: string | Uint8Array) =>
              active("writeFile").writeFile(at(path), toBytes(content)),
          },
    async unmount(id: string, target: string): Promise<void> {
      const current = active("unmount");
      if (current.unmount === undefined) {
        throw new SandboxError(
          "unsupported",
          "driver does not support runtime unmounting"
        );
      }
      await current.unmount(id, target);
    },
    workdir: spec.workdir,
    async writeFile(path: string, content: string | Uint8Array) {
      await active("writeFile").writeFile(path, toBytes(content));
    },
  };
}

function buildContainerFacets(
  guest: GuestAdapter,
  handle: DriverHandle,
  mounts: readonly ContainerMount[],
  fetchImpl: typeof globalThis.fetch
): ContainerFacets {
  const state: ContainerState = {
    mounts: new Map(mounts.map((spec) => [spec.id, { mounted: true, spec }])),
    services: new Map(),
  };
  const base = sandboxFromAdapter({
    copyIn: guest.copyIn,
    copyOut: guest.copyOut,
    exec: guest.exec,
    isDirectory: guest.isDirectory,
    list: guest.list,
    readFile: guest.readFile,
    workingDirectory: guest.workdir,
    writeFile: guest.writeFile,
  });

  const files: ContainerFacets["files"] = Object.freeze({
    ...base.files,
    ...(guest.storage === undefined ? {} : guest.storage),
    ...(guest.storage === undefined
      ? {}
      : {
          async watch(_root: string, changed: () => void) {
            guest.assertActive("watch");
            const timer = setInterval(changed, GUEST_WATCH_INTERVAL_MS);
            const stop = (): void => {
              clearInterval(timer);
              guest.lifetime.removeEventListener("abort", stop);
            };
            guest.lifetime.addEventListener("abort", stop);
            return {
              close() {
                stop();
                return Promise.resolve();
              },
            };
          },
        }),
  });

  const ports: SandboxPortsFacet | undefined =
    handle.endpoint === undefined
      ? undefined
      : Object.freeze({
          endpoint: (port: number) => guest.endpoint(port),
        });

  const processes: SandboxProcessesFacet | undefined =
    handle.startProcess === undefined && handle.spawn === undefined
      ? undefined
      : Object.freeze({
          ...(handle.spawn === undefined ? {} : { spawn: guest.spawn }),
          async start(command: SandboxCommand, options?: SandboxExecOptions) {
            const proc = await guest.startProcess(command, options);
            let status: SandboxProcessStatus = "running";
            let terminationRequested = false;
            const exited = proc.wait().finally(() => {
              if (status === "running") {
                status = terminationRequested ? "terminated" : "exited";
              }
            });
            exited.catch(() => undefined);
            const hardStop = async (): Promise<void> => {
              if (status !== "running") {
                return;
              }
              terminationRequested = true;
              try {
                await proc.kill();
              } catch (error: unknown) {
                if (status === "running") {
                  terminationRequested = false;
                }
                throw error;
              }
              await exited.catch(() => undefined);
            };
            return {
              id: proc.id,
              kill: hardStop,
              get status() {
                return status;
              },
              terminate: hardStop,
              wait: () => exited,
            };
          },
        });

  const services: SandboxServicesFacet | undefined =
    handle.startProcess === undefined
      ? undefined
      : createServicesFacet(state, guest, fetchImpl);

  const shell: SandboxShellFacet | undefined =
    handle.execStream === undefined
      ? undefined
      : Object.freeze({
          open: (options?: SandboxShellOptions) => guest.openShell(options),
        });

  const volumes: SandboxVolumesFacet | undefined =
    mounts.length > 0 ? createVolumesFacet(state, guest) : undefined;

  return Object.freeze({
    ...base,
    files,
    ...(ports === undefined ? {} : { ports }),
    ...(processes === undefined ? {} : { processes }),
    ...(services === undefined ? {} : { services }),
    ...(shell === undefined ? {} : { shell }),
    ...(guest.storage === undefined ? {} : { storage: guest.storage }),
    ...(volumes === undefined ? {} : { volumes }),
  });
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string"
    ? new TextEncoder().encode(content)
    : content;
}

function createVolumesFacet(
  state: ContainerState,
  guest: GuestAdapter
): SandboxVolumesFacet {
  return Object.freeze({
    async list() {
      guest.assertActive("listVolumes");
      return Object.freeze(
        [...state.mounts.values()]
          .filter((mount) => mount.mounted)
          .map((mount) =>
            Object.freeze({
              access: mount.spec.access,
              id: mount.spec.id,
              target: mount.spec.target,
            })
          )
      );
    },
    async unmount(id: string): Promise<void> {
      guest.assertActive("unmount");
      const mount = state.mounts.get(id);
      if (!mount) {
        throw new SandboxError(
          "invalid-contract",
          `sandbox mount "${id}" does not belong to this container`
        );
      }
      if (!mount.mounted) {
        return;
      }
      await guest.unmount(mount.spec.id, mount.spec.target);
      mount.mounted = false;
    },
  });
}

function createServicesFacet(
  state: ContainerState,
  guest: GuestAdapter,
  fetchImpl: typeof globalThis.fetch
): SandboxServicesFacet {
  const forget = (service: SandboxService): void => {
    if (state.services.get(service.id) === service) {
      state.services.delete(service.id);
    }
  };
  return Object.freeze({
    async list() {
      guest.assertActive("listServices");
      return Object.freeze([...state.services.values()]);
    },
    async start(input: SandboxStartServiceInput): Promise<SandboxService> {
      guest.assertActive("startService");
      validateServiceInput(input);
      if (state.services.has(input.id)) {
        throw new SandboxError(
          "invalid-contract",
          `sandbox service "${input.id}" already exists`
        );
      }
      const proc = await guest.startProcess([...input.argv], {
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.environment === undefined
          ? {}
          : { environment: { ...input.environment } }),
      });
      const startedAt = Date.now();
      let status: SandboxService["status"] = "starting";
      let readyAt: number | undefined;
      let terminationRequested = false;
      const exit = proc.wait().then(
        (result): SandboxServiceExit => {
          status = terminationRequested ? "terminated" : "exited";
          return Object.freeze({
            ...result,
            finishedAt: Date.now(),
            terminationRequested,
          });
        },
        (): SandboxServiceExit => {
          status = terminationRequested ? "terminated" : "exited";
          return Object.freeze({
            exitCode: 137,
            finishedAt: Date.now(),
            stderr: "",
            stdout: "",
            terminationRequested,
          });
        }
      );
      const terminate = async (): Promise<SandboxServiceExit> => {
        if (status === "exited" || status === "terminated") {
          return exit;
        }
        terminationRequested = true;
        await proc.terminate().catch(() => undefined);
        const graceMs =
          input.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
        const graceful = await raceExit(exit, graceMs);
        if (graceful !== undefined) {
          return graceful;
        }
        await proc.kill().catch(() => undefined);
        return exit;
      };
      const service: SandboxService = Object.freeze({
        id: input.id,
        get readyAt() {
          return readyAt;
        },
        startedAt,
        get status() {
          return status;
        },
        terminate,
        wait: () => exit,
      });
      state.services.set(input.id, service);

      try {
        await waitForServiceReadiness(guest, input, exit, fetchImpl);
        if (service.status === "starting") {
          readyAt = Date.now();
          status = "ready";
        }
        return service;
      } catch (error: unknown) {
        await terminate().catch(() => undefined);
        forget(service);
        throw error;
      }
    },
    async stop(id: string): Promise<void> {
      guest.assertActive("stopService");
      const service = state.services.get(id);
      if (service === undefined) {
        throw new SandboxError(
          "invalid-contract",
          `sandbox service "${id}" does not belong to this container`
        );
      }
      await service.terminate();
      forget(service);
    },
  });
}

function validateServiceInput(input: SandboxStartServiceInput): void {
  if (!CONTAINER_PORTABLE_ID_PATTERN.test(input.id)) {
    throw new SandboxError(
      "invalid-contract",
      "sandbox service id must be a lowercase portable identifier"
    );
  }
  if (input.argv.length === 0 || input.argv.some((part) => part.length === 0)) {
    throw new SandboxError(
      "invalid-contract",
      "sandbox service argv must contain non-empty values"
    );
  }
  if (
    input.argv.length > 256 ||
    input.argv.some((part) => part.length > 8192)
  ) {
    throw new SandboxError(
      "invalid-contract",
      "sandbox service argv exceeds its bounded contract"
    );
  }
  const graceMs = input.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  if (!isIntegerBetween(graceMs, 0, MAX_TERMINATION_GRACE_MS)) {
    throw new SandboxError(
      "invalid-contract",
      "sandbox service termination grace must be between 0 and 30000ms"
    );
  }
  if (input.environment !== undefined) {
    const entries = Object.entries(
      input.environment as Readonly<Record<string, unknown>>
    );
    if (
      entries.length > 64 ||
      entries.some(
        ([name, value]) =>
          !ENVIRONMENT_NAME_PATTERN.test(name) ||
          typeof value !== "string" ||
          value.length > 8192
      )
    ) {
      throw new SandboxError(
        "invalid-contract",
        "sandbox service environment exceeds its bounded portable contract"
      );
    }
  }
  const { readiness } = input;
  if (
    (readiness.kind === "tcp" || readiness.kind === "http") &&
    !(
      isTcpPort(readiness.port) &&
      isIntegerBetween(readiness.timeoutMs, 1, 120_000) &&
      (readiness.intervalMs === undefined ||
        isIntegerBetween(readiness.intervalMs, 10, 1000))
    )
  ) {
    throw new SandboxError(
      "invalid-contract",
      `sandbox service ${readiness.kind.toUpperCase()} readiness is invalid or unbounded`
    );
  }
}

async function waitForServiceReadiness(
  guest: GuestAdapter,
  input: SandboxStartServiceInput,
  exit: Promise<SandboxServiceExit>,
  fetchImpl: typeof globalThis.fetch
): Promise<void> {
  const { readiness } = input;
  if (readiness.kind === "started") {
    return;
  }
  const endpoint = await guest.endpoint(readiness.port);
  if (endpoint === undefined) {
    throw new SandboxError(
      "invalid-contract",
      `sandbox service readiness port ${String(readiness.port)} is not exposed`
    );
  }
  const deadline = Date.now() + readiness.timeoutMs;
  const intervalMs = readiness.intervalMs ?? DEFAULT_READINESS_INTERVAL_MS;
  const probe = (): Promise<boolean> =>
    readiness.kind === "http"
      ? probeHttp(endpoint, readiness.path ?? "/", fetchImpl)
      : guest.probePort(readiness.port);

  while (Date.now() < deadline) {
    const outcome = await Promise.race([
      probe().then((ready) => (ready ? "ready" : "retry")),
      exit.then(() => "exited" as const),
    ]);
    if (outcome === "ready") {
      return;
    }
    if (outcome === "exited") {
      throw new SandboxError(
        "provider-failed",
        `sandbox service "${input.id}" exited before readiness`
      );
    }
    await delay(intervalMs);
  }
  throw new SandboxError(
    "provider-failed",
    `sandbox service "${input.id}" did not become ready before timeout`
  );
}

async function probeHttp(
  endpoint: SandboxEndpoint,
  path: string,
  fetchImpl: typeof globalThis.fetch
): Promise<boolean> {
  try {
    const base = new URL(endpoint.url);
    const url = new URL(path, base);
    if (url.origin !== base.origin) {
      return false;
    }
    const response = await fetchImpl(url, {
      ...(endpoint.headers === undefined ? {} : { headers: endpoint.headers }),
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function isIntegerBetween(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function raceExit(
  exit: Promise<SandboxServiceExit>,
  timeoutMs: number
): Promise<SandboxServiceExit | undefined> {
  return Promise.race([exit, delay(timeoutMs).then(() => undefined)]);
}
