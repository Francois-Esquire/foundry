import { posix } from "node:path";
import type { Storage } from "@foundry/core/storage";
import type {
  ExecHandle,
  Sandbox as MicroSandbox,
  SandboxBuilder,
} from "microsandbox";
import { BoundedBytes } from "../containers/bounded-bytes";
import type {
  ContainerSpec,
  Driver,
  DriverCapabilities,
  DriverExecOptions,
  DriverHandle,
  DriverProcess,
  NetworkAllowlist,
} from "../containers/driver";
import { isTcpPort } from "../containers/spec";
import { SandboxError } from "../errors";
import { type ResolvedHostMount, resolveHostMountSpecs } from "../node/mounts";
import {
  type LoopbackPortMapping,
  probeTcp,
  reserveLoopbackPorts,
} from "../node/network";
import type {
  SandboxCommand,
  SandboxDirectoryEntry,
  SandboxEndpoint,
  SandboxExecResult,
  SandboxShell,
} from "../sandbox";
import { pipedProcess } from "./microsandbox/piped-process";
import { guestStorage } from "./microsandbox/storage";

export interface MicrosandboxDriverOptions {
  readonly allowedMountRoots?: readonly string[];
}

export function microsandboxRemovalHint(name: string): string {
  return `\`msb rm -f ${name}\` (msb is node_modules/.bin/msb, in the Foundry install)`;
}

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

const MICROSANDBOX_CAPABILITIES: DriverCapabilities = Object.freeze({
  endpoints: Object.freeze(["loopback"] as const),
  lifetime: Object.freeze({ idle: false, ttl: false }),
  listing: true,
  mounts: Object.freeze(["host-directory"] as const),
  network: Object.freeze(["none", "allowlist", "open"] as const),
  pause: false,
  reconnect: false,
  secrets: false,
});

let installing: Promise<void> | undefined;
const MAX_SERVICE_OUTPUT_BYTES = 1024 * 1024;
const MAX_EXEC_OUTPUT_BYTES = 16 * 1024 * 1024;
const REMOVE_STOP_TIMEOUT_MS = 2000;
const SIGTERM = 15;

export function createMicrosandboxDriver(
  options: MicrosandboxDriverOptions = {}
): Driver<MicroSandbox> {
  const allowedMountRoots = options.allowedMountRoots ?? [];
  return {
    capabilities: MICROSANDBOX_CAPABILITIES,
    async create({ spec }) {
      const mounts = await resolveHostMountSpecs(
        spec.mounts,
        allowedMountRoots
      );
      const ports = await reserveLoopbackPorts(spec.ports);
      const { Sandbox } = await sdk();
      const sandbox = await applySpec(
        Sandbox.builder(spec.name),
        spec,
        mounts,
        ports
      ).create();
      return new MicrosandboxHandle(sandbox, spec, ports);
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
    manualRemovalHint: microsandboxRemovalHint,
    name: "microsandbox",
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
  spec: ContainerSpec,
  mounts: readonly ResolvedHostMount[],
  ports: readonly LoopbackPortMapping[]
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
    builder.envs({ ...spec.env });
  }
  if (Object.keys(spec.labels).length > 0) {
    builder.labels({ ...spec.labels });
  }
  if (spec.pidsLimit !== undefined) {
    builder.rlimit("nproc", spec.pidsLimit);
  }
  for (const mount of mounts) {
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
      if (mount.access === "read-only") {
        configured = configured.readonly();
      }
      return configured;
    });
  }
  configureNetwork(builder, spec, ports);
  return builder;
}

function configureNetwork(
  builder: SandboxBuilder,
  spec: ContainerSpec,
  ports: readonly LoopbackPortMapping[]
): void {
  builder.network((network: MicrosandboxNetworkBuilder) => {
    let configured = network;
    if (typeof spec.network === "object") {
      configured = allowlistNetwork(network, spec.network);
    } else if (spec.network === "none") {
      configured = network.policy(DENY_GUEST_EGRESS_POLICY);
    }
    for (const mapping of ports) {
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
  { destinations }: NetworkAllowlist
): MicrosandboxNetworkBuilder {
  const portsOf = (destination: NetworkAllowlist["destinations"][number]) =>
    destination.ports ?? [DEFAULT_ALLOWLIST_PORT];
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

function assertPrivatePortMapping(mapping: LoopbackPortMapping): void {
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

function toPosixArgv(command: SandboxCommand): string[] {
  return typeof command === "string" ? ["sh", "-c", command] : [...command];
}

class MicrosandboxHandle implements DriverHandle<MicroSandbox> {
  readonly native: MicroSandbox;
  private readonly spec: ContainerSpec;
  private readonly ports: readonly LoopbackPortMapping[];
  readonly storage: Storage;

  constructor(
    native: MicroSandbox,
    spec: ContainerSpec,
    ports: readonly LoopbackPortMapping[]
  ) {
    this.native = native;
    this.spec = spec;
    this.ports = ports;
    this.storage = guestStorage(native.fs(), (argv) =>
      this.exec(argv, { cwd: spec.workdir, env: {} })
    );
  }

  get id(): string {
    return this.spec.name;
  }

  endpoint(guestPort: number): Promise<SandboxEndpoint | undefined> {
    const mapping = this.ports.find((port) => port.guestPort === guestPort);
    if (mapping === undefined) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(
      Object.freeze({
        access: "loopback",
        host: mapping.host,
        port: mapping.hostPort,
        protocol: "http",
        url: `http://${mapping.host}:${String(mapping.hostPort)}`,
      })
    );
  }

  async probePort(guestPort: number): Promise<boolean> {
    const mapping = this.ports.find((port) => port.guestPort === guestPort);
    if (mapping === undefined) {
      return false;
    }
    return probeTcp(mapping.host, mapping.hostPort);
  }

  async exec(
    command: SandboxCommand,
    options: DriverExecOptions
  ): Promise<SandboxExecResult> {
    const [cmd, ...args] = toPosixArgv(command);
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
    command: SandboxCommand | undefined,
    options: DriverExecOptions
  ): Promise<SandboxShell> {
    const argv = command === undefined ? ["/bin/sh"] : toPosixArgv(command);
    const [cmd, ...args] = argv;
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
    command: SandboxCommand,
    options: DriverExecOptions
  ): Promise<DriverProcess> {
    const [cmd, ...args] = toPosixArgv(command);
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
      terminate: () => handle.signal(SIGTERM),
      wait: () => settled,
    });
  }

  async spawn(command: SandboxCommand, options: DriverExecOptions) {
    options.signal?.throwIfAborted();
    const [cmd, ...args] = toPosixArgv(command);
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

  async unmount(id: string, target: string): Promise<void> {
    const result = await this.exec(["umount", target], {
      cwd: this.spec.workdir,
      env: {},
    });
    if (result.exitCode !== 0) {
      throw new SandboxError(
        "provider-failed",
        `sandbox mount "${id}" could not be unmounted`,
        { details: { exitCode: result.exitCode } }
      );
    }
  }

  async stop(): Promise<void> {
    await this.native.stop();
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
  options: DriverExecOptions
): ExecBuilder {
  builder.args(args).cwd(options.cwd);
  if (Object.keys(options.env).length > 0) {
    builder.envs({ ...options.env });
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
