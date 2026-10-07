import { realpath, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { isAbsolute, relative, resolve } from "node:path";

import type { Storage, StorageObserver } from "@foundry/core/storage";
import { SandboxError } from "../errors";
import { sandboxFromAdapter } from "../sandbox";
import type {
  Sandbox,
  SandboxFilesystemFacet,
  SandboxPortsFacet,
  SandboxProcessesFacet,
  SandboxProcessStatus,
  SandboxService,
  SandboxServiceExit,
  SandboxServicesFacet,
  SandboxShellFacet,
  SandboxShellOptions,
  SandboxStartServiceInput,
  SandboxVolumesFacet,
} from "../types";
import { CONTAINER_PORTABLE_ID_PATTERN } from "./constants";
import type { ContainerSandboxMount } from "./constraints";
import { isTcpPort } from "./ports";
import type { ContainerMountSpec, ContainerSandbox } from "./types";

const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_TERMINATION_GRACE_MS = 5000;
const MAX_TERMINATION_GRACE_MS = 30_000;
const DEFAULT_READINESS_INTERVAL_MS = 50;

/** What one VM's services and volumes track between calls. */
interface ContainerState {
  readonly mounts: Map<
    string,
    { readonly spec: ContainerMountSpec; mounted: boolean }
  >;
  readonly services: Map<string, SandboxService>;
}

/** Everything a running container offers beyond files and commands. */
export interface ContainerFacets extends Sandbox {
  readonly files: SandboxFilesystemFacet & Storage & StorageObserver;
  readonly ports: SandboxPortsFacet;
  readonly processes: SandboxProcessesFacet;
  readonly services: SandboxServicesFacet;
  readonly shell: SandboxShellFacet;
  /** Present only when the registry was given mount roots. */
  readonly volumes?: SandboxVolumesFacet;
}

/** Module-internal: the registry builds each handle from this. */
export function containerFacets(
  sandbox: ContainerSandbox,
  mounts: readonly ContainerMountSpec[],
  mountCapability: boolean
): ContainerFacets {
  const state: ContainerState = {
    mounts: new Map(mounts.map((spec) => [spec.id, { mounted: true, spec }])),
    services: new Map(),
  };
  // `list` goes straight to the guest filesystem rather than shelling out to `find`.
  const base = sandboxFromAdapter({
    copyIn: (files) => sandbox.copyIn(files),
    copyOut: (path) => sandbox.copyOut(path),
    exec: (command, options) => sandbox.exec(command, options),
    isDirectory: (path) => sandbox.isDirectory(path),
    list: (path, recursive) => sandbox.listDirectory(path, recursive),
    readFile: (path) => sandbox.readFile(path),
    workingDirectory: sandbox.workdir,
    writeFile: (path, content) => sandbox.writeFile(path, content),
  });
  return Object.freeze({
    ...base,
    files: Object.freeze({
      ...base.files,
      lstat: (path: string) => sandbox.storage.lstat(path),
      readDirectory: (path: string) => sandbox.storage.readDirectory(path),
      readLink: (path: string) => sandbox.storage.readLink(path),
      realpath: (path: string) => sandbox.storage.realpath(path),
      replaceFile: (path: string, bytes: Uint8Array) =>
        sandbox.storage.replaceFile(path, bytes),
      separator: "/" as const,
      // The guest SDK has no native change stream; reads still run in the VM.
      watch(_root: string, changed: () => void) {
        const timer = setInterval(changed, 1000);
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
        const hostPort = await sandbox.hostPort(port);
        return hostPort === undefined
          ? undefined
          : { host: "127.0.0.1", port: hostPort };
      },
    }),
    processes: {
      spawn: (command, options) => sandbox.spawn(command, options),
      async start(command, options) {
        const process = await sandbox.startProcess(command, options);
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
    services: createContainerServicesFacet(state, sandbox),
    shell: Object.freeze({
      open: (options?: SandboxShellOptions) => sandbox.openShell(options),
    }),
    ...(mountCapability
      ? { volumes: createContainerVolumesFacet(state, sandbox) }
      : {}),
  });
}

function createContainerVolumesFacet(
  handle: ContainerState,
  sandbox: ContainerSandbox
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
      const result = await sandbox.exec(["umount", mount.spec.target]);
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
  sandbox: ContainerSandbox
): SandboxServicesFacet {
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
      const process = await sandbox.startProcess([...input.argv], {
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
          // A killed exec session can end without an exit event (microsandbox
          // reports it as a runtime error). The process is gone either way, so
          // this settles as a kill-coded exit instead of poisoning every
          // wait/terminate/release consumer — and host shutdown — with a
          // rejection.
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
        await waitForServiceReadiness(sandbox, input, exit);
        if (service.status === "starting") {
          readyAt = Date.now();
          status = "ready";
        }
        return service;
      } catch (error: unknown) {
        await terminate().catch(() => undefined);
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
  sandbox: ContainerSandbox,
  input: SandboxStartServiceInput,
  exit: Promise<SandboxServiceExit>
): Promise<void> {
  if (input.readiness.kind === "started") {
    return;
  }
  const hostPort = await sandbox.hostPort(input.readiness.port);
  if (hostPort === undefined) {
    throw new SandboxError(
      "invalid-contract",
      `sandbox service readiness port ${String(input.readiness.port)} is not published`
    );
  }
  const deadline = Date.now() + input.readiness.timeoutMs;
  // Already bounded by `validateServiceInput`.
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

/**
 * The registry and provider share mount validation and path resolution.
 */
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
