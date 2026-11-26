import { realpath, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { isAbsolute, relative, resolve } from "node:path";
import { SandboxError } from "../errors";
import { normalizeSandboxPath } from "../path";
import type {
  SandboxCommand,
  SandboxDirectoryEntry,
  SandboxExecOptions,
  SandboxProcessesFacet,
  SandboxProcessStatus,
  SandboxService,
  SandboxServiceExit,
  SandboxServicesFacet,
  SandboxShell,
  SandboxShellOptions,
  SandboxStartServiceInput,
  SandboxVolumesFacet,
} from "../sandbox";
import { sandboxFromAdapter } from "../sandbox-adapter";
import type { ContainerSandboxMount } from "./constraints";
import type { ContainerFacets } from "./contracts";
import { CONTAINER_PORTABLE_ID_PATTERN } from "./defaults";
import { isTcpPort } from "./ports";
import type {
  ContainerExecOptions,
  ContainerInstance,
  ContainerMountSpec,
  ContainerSpec,
} from "./runtime";

const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_TERMINATION_GRACE_MS = 5000;
const MAX_TERMINATION_GRACE_MS = 30_000;
const DEFAULT_READINESS_INTERVAL_MS = 50;
const GUEST_WATCH_INTERVAL_MS = 1000;

export interface AttachedContainer {
  readonly facets: ContainerFacets;
  remove(): Promise<void>;
}

type GuestContainer = ReturnType<typeof guestContainer>;

interface ContainerState {
  readonly mounts: Map<
    string,
    { readonly spec: ContainerMountSpec; mounted: boolean }
  >;
  readonly services: Map<string, SandboxService>;
}

export function attachContainer(
  instance: ContainerInstance,
  spec: ContainerSpec,
  { mountCapability }: { readonly mountCapability: boolean }
): AttachedContainer {
  const lifetime = new AbortController();
  let removed = false;
  return Object.freeze({
    facets: containerFacets(
      guestContainer(instance, spec, lifetime.signal),
      spec.mounts,
      mountCapability
    ),
    async remove() {
      if (removed) {
        return;
      }
      lifetime.abort(new SandboxError("cancelled", "Sandbox removed"));
      await instance.remove();
      removed = true;
    },
  });
}

function guestContainer(
  instance: ContainerInstance,
  spec: ContainerSpec,
  lifetime: AbortSignal
) {
  const active = (operation: string): ContainerInstance => {
    if (lifetime.aborted) {
      throw new SandboxError(
        "invalid-transition",
        `Cannot ${operation}: sandbox ${instance.id} has been removed`
      );
    }
    return instance;
  };
  const at = (path: string): string => normalizeSandboxPath(path, spec.workdir);
  const execOptions = (
    options: SandboxExecOptions = {}
  ): ContainerExecOptions => ({
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
    async exec(command: SandboxCommand, options?: SandboxExecOptions) {
      return active("exec").exec(
        normalizeCommand(command),
        execOptions(options)
      );
    },
    async hostPort(guestPort: number): Promise<number | undefined> {
      active("hostPort");
      return spec.ports.find((port) => port.guestPort === guestPort)?.hostPort;
    },
    async isDirectory(path: string) {
      return (await active("isDirectory").stat(path)) === "directory";
    },
    list,
    async openShell(options: SandboxShellOptions = {}): Promise<SandboxShell> {
      return active("openShell").execStream(
        options.command ? normalizeCommand(options.command) : ["/bin/sh"],
        execOptions({
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.environment === undefined
            ? {}
            : { environment: options.environment }),
        })
      );
    },
    async readFile(path: string) {
      return active("readFile").readFile(path);
    },
    async spawn(command: SandboxCommand, options: SandboxExecOptions = {}) {
      const guest = active("spawn");
      options.signal?.throwIfAborted();
      const signal =
        options.signal === undefined
          ? lifetime
          : AbortSignal.any([lifetime, options.signal]);
      return guest.spawn(
        normalizeCommand(command),
        execOptions({ ...options, signal })
      );
    },
    async startProcess(command: SandboxCommand, options?: SandboxExecOptions) {
      return active("startProcess").startProcess(
        normalizeCommand(command),
        execOptions(options)
      );
    },
    storage: {
      lstat: async (path: string) => active("storage").storage.lstat(at(path)),
      readDirectory: async (path: string) =>
        active("storage").storage.readDirectory(at(path)),
      readLink: async (path: string) =>
        active("storage").storage.readLink(at(path)),
      realpath: async (path: string) =>
        active("storage").storage.realpath(at(path)),
      replaceFile: async (path: string, bytes: Uint8Array) =>
        active("storage").storage.replaceFile(at(path), bytes),
    },
    workdir: spec.workdir,
    async writeFile(path: string, content: string | Uint8Array) {
      await active("writeFile").writeFile(path, toBytes(content));
    },
  };
}

function containerFacets(
  guest: GuestContainer,
  mounts: readonly ContainerMountSpec[],
  mountCapability: boolean
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
  return Object.freeze({
    ...base,
    files: Object.freeze({
      ...base.files,
      ...guest.storage,
      separator: "/" as const,
      watch(_root: string, changed: () => void) {
        const timer = setInterval(changed, GUEST_WATCH_INTERVAL_MS);
        return Promise.resolve({
          close() {
            clearInterval(timer);
            return Promise.resolve();
          },
        });
      },
    }),
    ports: Object.freeze({
      async hostPort(port: number) {
        const hostPort = await guest.hostPort(port);
        return hostPort === undefined
          ? undefined
          : { host: "127.0.0.1", port: hostPort };
      },
    }),
    processes: {
      spawn: guest.spawn,
      async start(command, options) {
        const process = await guest.startProcess(command, options);
        let status: SandboxProcessStatus = "running";
        const exited = process.wait().finally(() => {
          if (status === "running") {
            status = "exited";
          }
        });
        exited.catch(() => undefined);
        return {
          id: process.id,
          get status() {
            return status;
          },
          async terminate() {
            if (status !== "running") {
              return;
            }
            await process.kill();
            status = "terminated";
          },
          wait: () => exited,
        };
      },
    } satisfies SandboxProcessesFacet,
    services: createContainerServicesFacet(state, guest),
    shell: Object.freeze({
      open: (options?: SandboxShellOptions) => guest.openShell(options),
    }),
    ...(mountCapability
      ? { volumes: createContainerVolumesFacet(state, guest) }
      : {}),
  });
}

function normalizeCommand(command: SandboxCommand): string[] {
  return typeof command === "string" ? ["sh", "-c", command] : [...command];
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string"
    ? new TextEncoder().encode(content)
    : content;
}

function createContainerVolumesFacet(
  handle: ContainerState,
  guest: GuestContainer
): SandboxVolumesFacet {
  return Object.freeze({
    list: () =>
      Promise.resolve(
        Object.freeze(
          [...handle.mounts.values()]
            .filter((mount) => mount.mounted)
            .map((mount) =>
              Object.freeze({
                access: mount.spec.readOnly
                  ? ("read-only" as const)
                  : ("read-write" as const),
                id: mount.spec.id,
                target: mount.spec.target,
              })
            )
        )
      ),
    async unmount(id: string): Promise<void> {
      const mount = handle.mounts.get(id);
      if (mount === undefined) {
        throw new SandboxError(
          "invalid-contract",
          `sandbox mount "${id}" does not belong to this environment`
        );
      }
      if (!mount.mounted) {
        return;
      }
      const result = await guest.exec(["umount", mount.spec.target]);
      if (result.exitCode !== 0) {
        throw new SandboxError(
          "provider-failed",
          `sandbox mount "${id}" could not be unmounted`,
          { details: { exitCode: result.exitCode } }
        );
      }
      mount.mounted = false;
    },
  });
}

function createContainerServicesFacet(
  handle: ContainerState,
  guest: GuestContainer
): SandboxServicesFacet {
  const forget = (service: SandboxService): void => {
    if (handle.services.get(service.id) === service) {
      handle.services.delete(service.id);
    }
  };
  return Object.freeze({
    list: () => Promise.resolve(Object.freeze([...handle.services.values()])),
    async start(input: SandboxStartServiceInput): Promise<SandboxService> {
      validateServiceInput(input);
      if (handle.services.has(input.id)) {
        throw new SandboxError(
          "invalid-contract",
          `sandbox service "${input.id}" already exists`
        );
      }
      const process = await guest.startProcess([...input.argv], {
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.environment === undefined
          ? {}
          : { environment: { ...input.environment } }),
      });
      const startedAt = Date.now();
      let status: SandboxService["status"] = "starting";
      let readyAt: number | undefined;
      let terminationRequested = false;
      const exit = process.wait().then(
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
        await process.signal(15).catch(() => undefined);
        const graceMs =
          input.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
        const graceful = await raceExit(exit, graceMs);
        if (graceful !== undefined) {
          return graceful;
        }
        await process.kill().catch(() => undefined);
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
      handle.services.set(input.id, service);

      try {
        await waitForServiceReadiness(guest, input, exit);
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
      const service = handle.services.get(id);
      if (service === undefined) {
        throw new SandboxError(
          "invalid-contract",
          `sandbox service "${id}" does not belong to this environment`
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
    readiness.kind === "tcp" &&
    !(
      isTcpPort(readiness.port) &&
      isIntegerBetween(readiness.timeoutMs, 1, 120_000) &&
      (readiness.intervalMs === undefined ||
        isIntegerBetween(readiness.intervalMs, 10, 1000))
    )
  ) {
    throw new SandboxError(
      "invalid-contract",
      "sandbox service TCP readiness is invalid or unbounded"
    );
  }
}

async function waitForServiceReadiness(
  guest: GuestContainer,
  input: SandboxStartServiceInput,
  exit: Promise<SandboxServiceExit>
): Promise<void> {
  if (input.readiness.kind === "started") {
    return;
  }
  const hostPort = await guest.hostPort(input.readiness.port);
  if (hostPort === undefined) {
    throw new SandboxError(
      "invalid-contract",
      `sandbox service readiness port ${String(input.readiness.port)} is not published`
    );
  }
  const deadline = Date.now() + input.readiness.timeoutMs;
  const intervalMs =
    input.readiness.intervalMs ?? DEFAULT_READINESS_INTERVAL_MS;
  while (Date.now() < deadline) {
    const outcome = await Promise.race([
      probeTcp("127.0.0.1", hostPort).then((ready) =>
        ready ? "ready" : "retry"
      ),
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

function isIntegerBetween(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function probeTcp(host: string, port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ host, port });
    const settle = (ready: boolean): void => {
      socket.destroy();
      resolveProbe(ready);
    };
    socket.once("connect", () => {
      settle(true);
    });
    socket.once("error", () => {
      settle(false);
    });
    socket.setTimeout(250, () => {
      settle(false);
    });
  });
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

export async function resolveContainerMountSpecs(
  mounts: readonly ContainerSandboxMount[],
  allowedRoots: readonly string[],
  targetRoot?: string
): Promise<readonly ContainerMountSpec[]> {
  if (mounts.length === 0) {
    return Object.freeze([]);
  }
  if (allowedRoots.length === 0) {
    throw new SandboxError(
      "invalid-contract",
      "Container sandbox mounts require a trusted host-root allowlist"
    );
  }
  if (targetRoot !== undefined) {
    for (const mount of mounts) {
      if (
        mount.target !== targetRoot &&
        !mount.target.startsWith(`${targetRoot}/`)
      ) {
        throw new SandboxError(
          "invalid-contract",
          `sandbox mount "${mount.id}" target must be ${targetRoot} or a child of it`
        );
      }
    }
  }
  const roots = await Promise.all(
    allowedRoots.map(async (root) => {
      if (!isAbsolute(root)) {
        throw new SandboxError(
          "invalid-contract",
          "Container sandbox mount roots must be absolute"
        );
      }
      return realpath(resolve(root));
    })
  );
  const resolved: ContainerMountSpec[] = [];
  for (const mount of mounts) {
    if (!isAbsolute(mount.source)) {
      throw new SandboxError(
        "invalid-contract",
        `sandbox mount "${mount.id}" source must be absolute`
      );
    }
    const source = await realpath(resolve(mount.source));
    const metadata = await stat(source);
    if (!metadata.isDirectory()) {
      throw new SandboxError(
        "invalid-contract",
        `sandbox mount "${mount.id}" source must be a directory`
      );
    }
    if (!roots.some((root) => isWithin(root, source))) {
      throw new SandboxError(
        "invalid-contract",
        `sandbox mount "${mount.id}" escapes the trusted host roots`
      );
    }
    resolved.push(
      Object.freeze({
        id: mount.id,
        ...(mount.executable === undefined
          ? {}
          : { executable: mount.executable }),
        readOnly: mount.access === "read-only",
        source,
        target: mount.target,
      })
    );
  }
  return Object.freeze(resolved);
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || !(path.startsWith("..") || isAbsolute(path));
}
