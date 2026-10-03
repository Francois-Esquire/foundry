import { Buffer } from "node:buffer";
import { createServer } from "node:net";
import { normalizeSandboxPath } from "../path";
import type {
  SandboxCommand,
  SandboxDirectoryEntry,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxPipedProcess,
  SandboxShell,
  SandboxShellOptions,
} from "../types";
import {
  CONTAINER_ENVIRONMENT_ID_LABEL,
  CONTAINER_SANDBOX_BASE_LABEL,
  DEFAULT_CONTAINER_CPUS,
  DEFAULT_CONTAINER_IMAGE,
  DEFAULT_CONTAINER_MEMORY_MIB,
  DEFAULT_CONTAINER_WORKDIR,
} from "./constants";
import type {
  ContainerConfig,
  ContainerExecOptions,
  ContainerInstance,
  ContainerMountSpec,
  ContainerPortMapping,
  ContainerProcess,
  ContainerRuntime,
  ContainerSandbox,
  ContainerSandboxDeps,
  ContainerSpec,
  ContainerStatus,
} from "./types";

/** Create and boot a microVM sandbox, auto-removed on scope exit. */
export async function createContainerSandbox<TNative = unknown>(
  config: ContainerConfig = {},
  deps: ContainerSandboxDeps<TNative> = {}
): Promise<ContainerSandbox<TNative>> {
  const provisioned = await provisionContainerSandbox(config, deps);
  return startContainerSandbox(provisioned);
}

export interface ProvisionedContainerSandbox<TNative> {
  readonly runtime: ContainerRuntime<TNative>;
  readonly spec: ContainerSpec;
}

/**
 * Resolve the spec and reserve host ports without booting anything. Split from
 * {@link startContainerSandbox} because the Environment provider's `create`
 * must produce a stable id before `start` does the expensive work. A microVM
 * has no created-but-not-running state, so the boot happens entirely in
 * `start`.
 */
export async function provisionContainerSandbox<TNative = unknown>(
  config: ContainerConfig = {},
  deps: ContainerSandboxDeps<TNative> = {},
  mounts: readonly ContainerMountSpec[] = []
): Promise<ProvisionedContainerSandbox<TNative>> {
  const runtime = deps.runtime ?? (await defaultRuntime<TNative>());
  return { runtime, spec: await resolveContainerSpec(config, mounts) };
}

/**
 * Boot the provisioned spec and wrap it as a portable sandbox.
 *
 * The working directory is created here rather than left to the runtime. The
 * microVM runtime refuses to boot at all when its configured workdir is
 * absent, and stock images rarely carry the caller's chosen path
 * (`node:*-slim` ships `/home/node`, not `/home/user`). Creating it after boot
 * keeps any workdir usable on any image.
 */
export async function startContainerSandbox<TNative>(
  provisioned: ProvisionedContainerSandbox<TNative>
): Promise<ContainerSandbox<TNative>> {
  const instance = await provisioned.runtime.create(provisioned.spec);
  try {
    await instance.ensureDirectory(provisioned.spec.workdir);
    return new ContainerSandboxHandle(instance, provisioned.spec);
  } catch (error) {
    await instance.remove();
    throw error;
  }
}

export async function resolveContainerSpec(
  config: ContainerConfig,
  mounts: readonly ContainerMountSpec[] = []
): Promise<ContainerSpec> {
  const guestPorts = config.ports ?? [];
  assertGuestPorts(guestPorts);
  const ports = await reserveHostPorts(guestPorts);
  const memoryBytes = config.resources?.memoryBytes;
  const cpus = config.resources?.cpus;
  const name = config.name ?? `foundry-${crypto.randomUUID()}`;
  return {
    // The guest takes whole vCPUs, so a fractional budget rounds up to the
    // nearest core rather than silently truncating to zero.
    cpus:
      cpus === undefined
        ? DEFAULT_CONTAINER_CPUS
        : Math.max(1, Math.ceil(cpus)),
    detached: config.detached ?? false,
    disableNetwork:
      config.network === undefined
        ? (config.disableNetwork ?? true)
        : config.network !== "unrestricted",
    ...(config.network === undefined ? {} : { network: config.network }),
    env: config.env ?? {},
    image: config.image ?? DEFAULT_CONTAINER_IMAGE,
    // The environment-id label is stamped last: it is the immutable native
    // identity reconciliation validates, so caller labels can never spoof it.
    labels: {
      [CONTAINER_SANDBOX_BASE_LABEL]: "1",
      ...config.labels,
      [CONTAINER_ENVIRONMENT_ID_LABEL]: name,
    },
    memoryMib:
      memoryBytes === undefined
        ? DEFAULT_CONTAINER_MEMORY_MIB
        : Math.max(1, Math.round(memoryBytes / (1024 * 1024))),
    name,
    ports,
    pull: config.pull ?? "missing",
    workdir: config.workdir ?? DEFAULT_CONTAINER_WORKDIR,
    ...(config.resources?.pids === undefined
      ? {}
      : { pidsLimit: config.resources.pids }),
    mounts: Object.freeze([...mounts]),
  };
}

/**
 * Pick a free loopback port per requested guest port. The microVM runtime
 * wants the host port up front, so it is chosen here. The listener is closed
 * before the VM binds it, which leaves a small window where another process
 * could take the port — the boot then fails loudly rather than silently
 * mis-binding.
 */
async function reserveHostPorts(
  guestPorts: readonly number[]
): Promise<readonly ContainerPortMapping[]> {
  const mappings: ContainerPortMapping[] = [];
  for (const guestPort of guestPorts) {
    mappings.push({
      guestPort,
      host: "127.0.0.1",
      hostPort: await freeLoopbackPort(),
    });
  }
  return mappings;
}

function assertGuestPorts(guestPorts: readonly number[]): void {
  const seen = new Set<number>();
  for (const port of guestPorts) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new RangeError("guest ports must be integers from 1 through 65535");
    }
    if (seen.has(port)) {
      throw new RangeError("guest ports must be unique");
    }
    seen.add(port);
  }
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => {
        if (port > 0) {
          resolve(port);
        } else {
          reject(new Error("could not reserve a host port"));
        }
      });
    });
  });
}

/** Lazy-load the microsandbox adapter (avoids the native addon in fake-only paths). */
async function defaultRuntime<TNative>(): Promise<ContainerRuntime<TNative>> {
  const { createMicrosandboxRuntime } = await import("./microsandbox-runtime");
  return createMicrosandboxRuntime() as unknown as ContainerRuntime<TNative>;
}

class ContainerSandboxHandle<TNative> implements ContainerSandbox<TNative> {
  #status: ContainerStatus = "running";
  private readonly lifetime = new AbortController();
  private readonly instance: ContainerInstance<TNative>;
  private readonly spec: ContainerSpec;

  constructor(instance: ContainerInstance<TNative>, spec: ContainerSpec) {
    this.instance = instance;
    this.spec = spec;
  }

  get id() {
    return this.instance.id;
  }

  get native(): TNative {
    return this.instance.native;
  }

  get status() {
    return this.#status;
  }

  get workdir() {
    return this.spec.workdir;
  }

  get storage() {
    this.assertActive("storage");
    const { storage } = this.instance;
    if (!storage) {
      throw new Error("Container runtime does not implement strict storage");
    }
    const at = (path: string) => {
      this.assertActive("storage");
      return normalizeSandboxPath(path, this.workdir);
    };
    return {
      lstat: (path: string) => storage.lstat(at(path)),
      readDirectory: (path: string) => storage.readDirectory(at(path)),
      readFile: (path: string) => storage.readFile(at(path)),
      readLink: (path: string) => storage.readLink(at(path)),
      realpath: (path: string) => storage.realpath(at(path)),
      replaceFile: (path: string, bytes: Uint8Array) =>
        storage.replaceFile(at(path), bytes),
      separator: storage.separator,
      writeFile: (path: string, content: string | Uint8Array) =>
        storage.writeFile(at(path), content),
    };
  }

  async exec(
    command: SandboxCommand,
    options: SandboxExecOptions = {}
  ): Promise<SandboxExecResult> {
    this.assertActive("exec");
    return this.instance.exec(
      normalizeCommand(command),
      this.execOptions(options)
    );
  }

  startProcess(
    command: SandboxCommand,
    options: SandboxExecOptions = {}
  ): Promise<ContainerProcess> {
    this.assertActive("startProcess");
    return this.instance.startProcess(
      normalizeCommand(command),
      this.execOptions(options)
    );
  }

  async spawn(
    command: SandboxCommand,
    options: SandboxExecOptions = {}
  ): Promise<SandboxPipedProcess> {
    this.assertActive("spawn");
    options.signal?.throwIfAborted();
    const signal =
      options.signal === undefined
        ? this.lifetime.signal
        : AbortSignal.any([this.lifetime.signal, options.signal]);
    return this.instance.spawn(
      normalizeCommand(command),
      this.execOptions({ ...options, signal })
    );
  }

  private execOptions(options: SandboxExecOptions): ContainerExecOptions {
    return {
      cwd: options.cwd ?? this.spec.workdir,
      env: { ...this.spec.env, ...options.environment },
      ...(options.user === undefined ? {} : { user: options.user }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    this.assertActive("writeFile");
    await this.instance.writeFile(path, toBytes(content));
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.assertActive("readFile");
    return this.instance.readFile(path);
  }

  async readTextFile(path: string): Promise<string> {
    return Buffer.from(await this.readFile(path)).toString("utf8");
  }

  async copyIn(files: Record<string, string | Uint8Array>): Promise<void> {
    this.assertActive("copyIn");
    // Sequential: the writes share parent directories, and concurrent mkdir of
    // the same path races inside the guest.
    for (const [path, content] of Object.entries(files)) {
      await this.instance.writeFile(path, toBytes(content));
    }
  }

  async copyOut(path: string): Promise<Record<string, Uint8Array>> {
    this.assertActive("copyOut");
    const type = await this.instance.stat(path);
    if (type === undefined) {
      throw new Error(`No file found at ${path}`);
    }
    if (type === "file") {
      return { [path]: await this.instance.readFile(path) };
    }

    if (type !== "directory") {
      return {};
    }

    const out: Record<string, Uint8Array> = {};
    const pending = [path];
    while (pending.length > 0) {
      const dir = pending.pop();
      if (dir === undefined) {
        continue;
      }
      for (const entry of await this.instance.list(dir)) {
        if (entry.type === "directory") {
          pending.push(entry.path);
        } else if (entry.type === "file") {
          out[entry.path] = await this.instance.readFile(entry.path);
        }
      }
    }
    return out;
  }

  async listDirectory(
    path: string,
    recursive: boolean
  ): Promise<readonly SandboxDirectoryEntry[]> {
    this.assertActive("listDirectory");
    const entries = await this.instance.list(path);
    if (!recursive) {
      return entries;
    }

    const out = [...entries];
    const pending = entries.filter((e) => e.type === "directory");
    while (pending.length > 0) {
      const dir = pending.pop();
      if (dir === undefined) {
        continue;
      }
      const children = await this.instance.list(dir.path);
      out.push(...children);
      pending.push(...children.filter((e) => e.type === "directory"));
    }
    return out;
  }

  async isDirectory(path: string): Promise<boolean> {
    this.assertActive("isDirectory");
    return (await this.instance.stat(path)) === "directory";
  }

  async openShell(options: SandboxShellOptions = {}): Promise<SandboxShell> {
    this.assertActive("openShell");
    const command = options.command
      ? normalizeCommand(options.command)
      : ["/bin/sh"];
    return this.instance.execStream(command, {
      cwd: options.cwd ?? this.spec.workdir,
      env: { ...this.spec.env, ...options.environment },
    });
  }

  hostPort(guestPort: number): Promise<number | undefined> {
    this.assertActive("hostPort");
    // Resolved at provision time rather than inspected from the runtime — see
    // `reserveHostPorts`.
    return Promise.resolve(
      this.spec.ports.find((p) => p.guestPort === guestPort)?.hostPort
    );
  }

  async stop(): Promise<void> {
    if (this.#status !== "running") {
      return;
    }
    this.lifetime.abort(new Error("Sandbox stopped"));
    await this.instance.stop();
    this.#status = "stopped";
  }

  async remove(): Promise<void> {
    if (this.#status === "removed") {
      return;
    }
    this.lifetime.abort(new Error("Sandbox removed"));
    await this.instance.remove();
    this.#status = "removed";
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.remove();
  }

  private assertActive(op: string) {
    if (this.#status === "removed") {
      throw new Error(`Cannot ${op}: sandbox ${this.id} has been removed`);
    }
  }
}

function normalizeCommand(command: SandboxCommand): string[] {
  return typeof command === "string" ? ["sh", "-c", command] : [...command];
}

/**
 * Encodes to a plain `Uint8Array`, not a `Buffer`. A `Buffer` would satisfy
 * the type but survives the round trip as a `Buffer`, and the facet contract
 * is plain bytes.
 */
function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string"
    ? new TextEncoder().encode(content)
    : content;
}
