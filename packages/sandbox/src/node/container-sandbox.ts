import {
  CONTAINER_ENVIRONMENT_ID_LABEL,
  CONTAINER_SANDBOX_BASE_LABEL,
  DEFAULT_CONTAINER_CPUS,
  DEFAULT_CONTAINER_IMAGE,
  DEFAULT_CONTAINER_MEMORY_MIB,
  DEFAULT_CONTAINER_WORKDIR,
} from "../container/defaults";
import type {
  ContainerConfig,
  ContainerExecOptions,
  ContainerInstance,
  ContainerMountSpec,
  ContainerProcess,
  ContainerRuntime,
  ContainerSandbox,
  ContainerSandboxDeps,
  ContainerSpec,
  ContainerStatus,
} from "../container/runtime";
import { SandboxError } from "../errors";
import { normalizeSandboxPath } from "../path";
import type {
  SandboxCommand,
  SandboxDirectoryEntry,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxPipedProcess,
  SandboxShell,
  SandboxShellOptions,
} from "../sandbox";
import { assertGuestPorts, reserveHostPorts } from "./ports";

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

export async function provisionContainerSandbox<TNative = unknown>(
  config: ContainerConfig = {},
  deps: ContainerSandboxDeps<TNative> = {},
  mounts: readonly ContainerMountSpec[] = []
): Promise<ProvisionedContainerSandbox<TNative>> {
  const runtime = deps.runtime ?? (await defaultRuntime<TNative>());
  return { runtime, spec: await resolveContainerSpec(config, mounts) };
}

export async function startContainerSandbox<TNative>(
  provisioned: ProvisionedContainerSandbox<TNative>,
  options: StartContainerSandboxOptions = {}
): Promise<ContainerSandbox<TNative>> {
  const instance = await provisioned.runtime.create(provisioned.spec);
  try {
    await instance.ensureDirectory(provisioned.spec.workdir);
    return new ContainerSandboxHandle(instance, provisioned.spec);
  } catch (error) {
    const leftBehind = (cleanup: unknown): void => {
      try {
        options.onLeftBehind?.(cleanup);
      } catch {
        // biome-ignore lint/complexity/noUselessReturn: End the best-effort operation on failure.
        return;
      }
    };
    if (options.mayRemove?.() === false) {
      leftBehind(
        new SandboxError(
          "invalid-contract",
          "the VM is not its owner's to remove"
        )
      );
      throw error;
    }
    try {
      await instance.remove();
    } catch (cleanup: unknown) {
      leftBehind(cleanup);
    }
    throw error;
  }
}

export interface StartContainerSandboxOptions {
  readonly mayRemove?: () => boolean;
  readonly onLeftBehind?: (error: unknown) => void;
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
    labels: {
      [CONTAINER_SANDBOX_BASE_LABEL]: "1",
      ...config.labels,
      [CONTAINER_ENVIRONMENT_ID_LABEL]: name,
    },
    memoryMib:
      memoryBytes === undefined
        ? DEFAULT_CONTAINER_MEMORY_MIB
        : Math.max(1, Math.ceil(memoryBytes / (1024 * 1024))),
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

async function defaultRuntime<TNative>(): Promise<ContainerRuntime<TNative>> {
  const { createMicrosandboxRuntime } = await import("./microsandbox");
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

  async startProcess(
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

  private cwd(cwd: string | undefined): string {
    return cwd === undefined
      ? this.spec.workdir
      : normalizeSandboxPath(cwd, this.spec.workdir);
  }

  private execOptions(options: SandboxExecOptions): ContainerExecOptions {
    return {
      cwd: this.cwd(options.cwd),
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
    return new TextDecoder().decode(await this.readFile(path));
  }

  async copyIn(files: Record<string, string | Uint8Array>): Promise<void> {
    this.assertActive("copyIn");
    for (const [path, content] of Object.entries(files)) {
      await this.instance.writeFile(path, toBytes(content));
    }
  }

  async copyOut(path: string): Promise<Record<string, Uint8Array>> {
    this.assertActive("copyOut");
    const type = await this.instance.stat(path);
    if (type === undefined) {
      throw new SandboxError("invalid-contract", `No file found at ${path}`, {
        details: { path },
      });
    }
    if (type === "file") {
      return { [path]: await this.instance.readFile(path) };
    }

    if (type !== "directory") {
      return {};
    }

    const out: Record<string, Uint8Array> = {};
    for (const entry of await this.listDirectory(path, true)) {
      if (entry.type === "file") {
        out[entry.path] = await this.instance.readFile(entry.path);
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
      cwd: this.cwd(options.cwd),
      env: { ...this.spec.env, ...options.environment },
    });
  }

  hostPort(guestPort: number): Promise<number | undefined> {
    this.assertActive("hostPort");
    return Promise.resolve(
      this.spec.ports.find((p) => p.guestPort === guestPort)?.hostPort
    );
  }

  async stop(): Promise<void> {
    if (this.#status !== "running") {
      return;
    }
    this.lifetime.abort(new SandboxError("cancelled", "Sandbox stopped"));
    await this.instance.stop();
    this.#status = "stopped";
  }

  async remove(): Promise<void> {
    if (this.#status === "removed") {
      return;
    }
    this.lifetime.abort(new SandboxError("cancelled", "Sandbox removed"));
    await this.instance.remove();
    this.#status = "removed";
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.remove();
  }

  private assertActive(op: string) {
    if (this.#status === "removed") {
      throw new SandboxError(
        "invalid-transition",
        `Cannot ${op}: sandbox ${this.id} has been removed`
      );
    }
  }
}

function normalizeCommand(command: SandboxCommand): string[] {
  return typeof command === "string" ? ["sh", "-c", command] : [...command];
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string"
    ? new TextEncoder().encode(content)
    : content;
}
