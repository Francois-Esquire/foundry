import { posix } from "node:path";
import type { Storage } from "@foundry/core/storage";
import type {
  ExecHandle,
  Sandbox as MicroSandbox,
  SandboxBuilder,
} from "microsandbox";
import { BoundedBytes } from "../container/bounded-bytes";
import { pipedProcess } from "../container/piped-process";
import { isTcpPort } from "../container/ports";
import type {
  ContainerExecOptions,
  ContainerInstance,
  ContainerNetworkAllowlist,
  ContainerProcess,
  ContainerRuntime,
  ContainerSpec,
} from "../container/runtime";
import { guestStorage } from "../container/storage";
import { SandboxError } from "../errors";
import type {
  SandboxDirectoryEntry,
  SandboxExecResult,
  SandboxShell,
} from "../sandbox";

async function sdk() {
  return import("microsandbox");
}

type ExecBuilder = Parameters<Parameters<MicroSandbox["execWith"]>[1]>[0];

interface MicrosandboxMountBuilder {
  bind(path: string): MicrosandboxMountBuilder;
  hostPermissions(mode: "private"): MicrosandboxMountBuilder;
  nodev(): MicrosandboxMountBuilder;
  noexec(): MicrosandboxMountBuilder;
  nosuid(): MicrosandboxMountBuilder;
  readonly(): MicrosandboxMountBuilder;
  statVirtualization(mode: "relaxed"): MicrosandboxMountBuilder;
}

interface MicrosandboxNetworkBuilder {
  policy(policy: MicrosandboxNetworkPolicy): MicrosandboxNetworkBuilder;
  portBind(
    bind: string,
    hostPort: number,
    guestPort: number
  ): MicrosandboxNetworkBuilder;
  strict(enabled: boolean): MicrosandboxNetworkBuilder;
  tls(
    configure: (tls: MicrosandboxTlsBuilder) => MicrosandboxTlsBuilder
  ): MicrosandboxNetworkBuilder;
}

interface MicrosandboxTlsBuilder {
  interceptedPorts(ports: number[]): MicrosandboxTlsBuilder;
  verifyUpstream(enabled: boolean): MicrosandboxTlsBuilder;
}

interface MicrosandboxNetworkPolicy {
  readonly defaultEgress: "deny";
  readonly defaultIngress: "allow";
  readonly rules: readonly unknown[];
}

const PULL_POLICY = {
  always: "always",
  missing: "if-missing",
  never: "never",
} as const;

const DEFAULT_ALLOWLIST_PORT = 443;

const DENY_GUEST_EGRESS_POLICY: MicrosandboxNetworkPolicy = Object.freeze({
  defaultEgress: "deny",
  defaultIngress: "allow",
  rules: Object.freeze([]),
});

let installing: Promise<void> | undefined;
const MAX_SERVICE_OUTPUT_BYTES = 1024 * 1024;
const MAX_EXEC_OUTPUT_BYTES = 16 * 1024 * 1024;
const REMOVE_STOP_TIMEOUT_MS = 2000;

export function createMicrosandboxRuntime(): ContainerRuntime<MicroSandbox> {
  return {
    async create(spec) {
      const { Sandbox } = await sdk();
      const sandbox = await applySpec(
        Sandbox.builder(spec.name),
        spec
      ).create();
      return new MicrosandboxInstance(sandbox, spec);
    },
    async install() {
      installing ??= (async () => {
        const { install } = await sdk();
        await install();
      })().catch((error: unknown) => {
        installing = undefined;
        throw error;
      });
      await installing;
    },
    async isInstalled() {
      const { isInstalled } = await sdk();
      return isInstalled();
    },
    async listResources(query) {
      const { Sandbox } = await sdk();
      const page = await Sandbox.listWith((list) => {
        let configured = list.labels({ ...query.labels });
        if (query.limit !== undefined) {
          configured = configured.limit(query.limit);
        }
        if (query.cursor !== undefined) {
          configured = configured.cursor(query.cursor);
        }
        return configured;
      });
      return {
        resources: page.sandboxes.map((handle) => ({
          labels: labelsOf(handle.config()),
          name: handle.name,
          status: handle.status,
        })),
        ...(page.nextCursor === undefined
          ? {}
          : { nextCursor: page.nextCursor }),
      };
    },
    removeResource: removeIfPresent,
    async stopResource(name) {
      const { Sandbox } = await sdk();
      const handle = await Sandbox.get(name);
      await handle.stop();
    },
  };
}

async function removeIfPresent(name: string): Promise<void> {
  const { Sandbox, SandboxNotFoundError } = await sdk();
  try {
    await Sandbox.remove(name);
  } catch (error: unknown) {
    if (!(error instanceof SandboxNotFoundError)) {
      throw error;
    }
  }
}

function labelsOf(config: Record<string, unknown>): Record<string, string> {
  const { labels } = config;
  if (labels === null || typeof labels !== "object") {
    return {};
  }
  return Object.fromEntries(
    Object.entries(labels).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}

function applySpec(
  builder: SandboxBuilder,
  spec: ContainerSpec
): SandboxBuilder {
  builder
    .image(spec.image)
    .cpus(spec.cpus)
    .memory(spec.memoryMib)
    .pullPolicy(PULL_POLICY[spec.pull])
    .ephemeral(true)
    .detached(spec.detached)
    .quietLogs();

  if (Object.keys(spec.env).length > 0) {
    builder.envs(spec.env);
  }
  if (Object.keys(spec.labels).length > 0) {
    builder.labels(spec.labels);
  }
  if (spec.pidsLimit !== undefined) {
    builder.rlimit("nproc", spec.pidsLimit);
  }
  for (const mount of spec.mounts) {
    builder.volume(mount.target, (volume: MicrosandboxMountBuilder) => {
      let configured = volume
        .bind(mount.source)
        .nosuid()
        .nodev()
        .statVirtualization("relaxed")
        .hostPermissions("private");
      if (!mount.executable) {
        configured = configured.noexec();
      }
      if (mount.readOnly) {
        configured = configured.readonly();
      }
      return configured;
    });
  }
  configureNetwork(builder, spec);
  return builder;
}

function configureNetwork(builder: SandboxBuilder, spec: ContainerSpec): void {
  builder.network((network: MicrosandboxNetworkBuilder) => {
    let configured = network;
    if (typeof spec.network === "object") {
      configured = allowlistNetwork(network, spec.network);
    } else if (spec.disableNetwork) {
      configured = network.policy(DENY_GUEST_EGRESS_POLICY);
    }
    for (const mapping of spec.ports) {
      assertPrivatePortMapping(mapping);
      configured = configured.portBind(
        mapping.host,
        mapping.hostPort,
        mapping.guestPort
      );
    }
    return configured;
  });
}

function allowlistNetwork(
  network: MicrosandboxNetworkBuilder,
  { destinations }: ContainerNetworkAllowlist
): MicrosandboxNetworkBuilder {
  const portsOf = (
    destination: ContainerNetworkAllowlist["destinations"][number]
  ) => destination.ports ?? [DEFAULT_ALLOWLIST_PORT];
  const interceptedPorts = [...new Set(destinations.flatMap(portsOf))];
  return network
    .policy({
      defaultEgress: "deny",
      defaultIngress: "allow",
      rules: destinations.map((destination) => ({
        action: "allow",
        destination: { domain: destination.host, kind: "domain" },
        direction: "egress",
        ports: portsOf(destination).map((port) => ({ end: port, start: port })),
        protocols: ["tcp"],
      })),
    })
    .strict(true)
    .tls((tls) => tls.interceptedPorts(interceptedPorts).verifyUpstream(true));
}

function assertPrivatePortMapping(
  mapping: ContainerSpec["ports"][number]
): void {
  if (mapping.host !== "127.0.0.1") {
    throw new SandboxError(
      "invalid-contract",
      "VM ports may bind only to the loopback interface"
    );
  }
  if (!(isTcpPort(mapping.guestPort) && isTcpPort(mapping.hostPort))) {
    throw new SandboxError(
      "invalid-contract",
      "VM port mappings must contain valid TCP ports"
    );
  }
}

class MicrosandboxInstance implements ContainerInstance<MicroSandbox> {
  readonly native: MicroSandbox;
  private readonly spec: ContainerSpec;
  readonly storage: Storage;

  constructor(native: MicroSandbox, spec: ContainerSpec) {
    this.native = native;
    this.spec = spec;
    this.storage = guestStorage(native.fs(), (argv) =>
      this.exec(argv, { cwd: spec.workdir, env: {} })
    );
  }

  get id(): string {
    return this.spec.name;
  }

  async exec(
    command: string[],
    options: ContainerExecOptions
  ): Promise<SandboxExecResult> {
    const [cmd, ...args] = command;
    if (cmd === undefined) {
      throw new SandboxError("invalid-contract", "exec requires a command");
    }

    const handle = await this.native.execStreamWith(cmd, (b) =>
      configureExec(b, args, options)
    );
    return options.signal
      ? collectWithSignal(handle, options.signal)
      : collectBoundedProcess(handle, MAX_EXEC_OUTPUT_BYTES);
  }

  async execStream(
    command: string[],
    options: ContainerExecOptions
  ): Promise<SandboxShell> {
    const [cmd, ...args] = command;
    if (cmd === undefined) {
      throw new SandboxError(
        "invalid-contract",
        "execStream requires a command"
      );
    }

    const handle = await this.native.execStreamWith(cmd, (b) =>
      configureExec(b, args, options).tty(true).stdinPipe()
    );
    const stdin = await handle.takeStdin();

    const listeners = new Set<(chunk: string) => void>();
    const decoder = new TextDecoder();
    let closed = false;

    (async () => {
      for await (const event of handle) {
        if (event.kind !== "stdout" && event.kind !== "stderr") {
          continue;
        }
        const text = decoder.decode(event.data, { stream: true });
        for (const listener of listeners) {
          listener(text);
        }
      }
    })().catch(() => undefined);

    return {
      async close() {
        if (closed) {
          return;
        }
        closed = true;
        listeners.clear();
        await stdin?.close().catch(() => undefined);
        await handle[Symbol.asyncDispose]();
      },
      onData(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      write(data) {
        if (!closed) {
          stdin?.write(data).catch(() => undefined);
        }
      },
    };
  }

  async startProcess(
    command: string[],
    options: ContainerExecOptions
  ): Promise<ContainerProcess> {
    const [cmd, ...args] = command;
    if (cmd === undefined) {
      throw new SandboxError(
        "invalid-contract",
        "startProcess requires a command"
      );
    }
    const handle = await this.native.execStreamWith(cmd, (builder) =>
      configureExec(builder, args, options).tty(false).stdinNull()
    );
    const settled = collectBoundedProcess(handle, MAX_SERVICE_OUTPUT_BYTES);
    return Object.freeze({
      id: `container-process-${globalThis.crypto.randomUUID()}`,
      kill: () => handle.kill(),
      signal: (signal: number) => handle.signal(signal),
      wait: () => settled,
    });
  }

  async spawn(command: string[], options: ContainerExecOptions) {
    options.signal?.throwIfAborted();
    const [cmd, ...args] = command;
    if (cmd === undefined) {
      throw new SandboxError("invalid-contract", "spawn requires a command");
    }
    const cancellation = Promise.withResolvers<never>();
    const abort = () =>
      cancellation.reject(
        options.signal?.reason ??
          new SandboxError("cancelled", "Process launch aborted")
      );
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const launch = (async () => {
        const handle = await this.native.execStreamWith(cmd, (builder) =>
          configureExec(builder, args, options).tty(false).stdinPipe()
        );
        return pipedProcess(handle, options.signal);
      })();
      return await Promise.race([launch, cancellation.promise]);
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    return this.native.fs().read(path);
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    const parent = posix.dirname(path);
    if (parent !== path) {
      await this.ensureDirectory(parent).catch(() => undefined);
    }
    await this.native.fs().write(path, content);
  }

  async ensureDirectory(path: string): Promise<void> {
    await this.native.fs().mkdir(path);
  }

  async list(path: string): Promise<readonly SandboxDirectoryEntry[]> {
    try {
      if ((await this.storage.lstat(path)).type !== "directory") {
        return [];
      }
      return (await this.storage.readDirectory(path)).map(({ name, type }) => ({
        path: posix.join(path, name),
        type,
      }));
    } catch {
      return [];
    }
  }

  async stat(path: string): Promise<SandboxDirectoryEntry["type"] | undefined> {
    try {
      return (await this.storage.lstat(path)).type;
    } catch {
      return undefined;
    }
  }

  async remove(): Promise<void> {
    await this.native
      .stopWithTimeout(REMOVE_STOP_TIMEOUT_MS)
      .catch(() => undefined);
    await removeIfPresent(this.spec.name);
  }
}

async function collectBoundedProcess(
  handle: ExecHandle,
  limit: number
): Promise<SandboxExecResult> {
  const stdout = new BoundedBytes(limit);
  const stderr = new BoundedBytes(limit);
  let exitCode: number | undefined;
  for await (const event of handle) {
    if (event.kind === "stdout") {
      stdout.append(event.data);
    }
    if (event.kind === "stderr") {
      stderr.append(event.data);
    }
    if (event.kind === "exited") {
      exitCode = event.code;
    }
  }
  exitCode ??= (await handle.wait()).code;
  return {
    exitCode,
    stderr: stderr.text(),
    stdout: stdout.text(),
  };
}

function configureExec(
  builder: ExecBuilder,
  args: string[],
  options: ContainerExecOptions
): ExecBuilder {
  builder.args(args).cwd(options.cwd);
  if (Object.keys(options.env).length > 0) {
    builder.envs(options.env);
  }
  if (options.user !== undefined) {
    builder.user(options.user);
  }
  return builder;
}

async function collectWithSignal(
  handle: ExecHandle,
  signal: AbortSignal
): Promise<SandboxExecResult> {
  const aborted = Promise.withResolvers<never>();
  const onAbort = (): void => {
    aborted.reject(new SandboxError("cancelled", "exec aborted"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) {
      throw new SandboxError("cancelled", "exec aborted");
    }
    return await Promise.race([
      collectBoundedProcess(handle, MAX_EXEC_OUTPUT_BYTES),
      aborted.promise,
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    await handle[Symbol.asyncDispose]();
  }
}
