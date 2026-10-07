/** microsandbox adapter: implements {@link ContainerRuntime}, absorbing SDK quirks. */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import type {
  ExecHandle,
  Sandbox as MicroSandbox,
  SandboxBuilder,
} from "microsandbox";
import { SandboxError } from "../errors";
import type {
  SandboxDirectoryEntry,
  SandboxExecResult,
  SandboxShell,
} from "../types";
import { pipedProcess } from "./piped-process";
import { isTcpPort } from "./ports";
import { guestStorage } from "./storage";
import type {
  ContainerExecOptions,
  ContainerInstance,
  ContainerNetworkAllowlist,
  ContainerProcess,
  ContainerRuntime,
  ContainerSpec,
} from "./types";

/**
 * Keep the native addon out of registry imports and fake-runtime tests.
 * Import the optional SDK only when a VM is actually asked for.
 */
async function sdk() {
  return import("microsandbox");
}

/**
 * The exec-options builder the SDK hands to `execWith`. Its class is internal
 * to the package, so the type is read off the call signature rather than
 * imported.
 */
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

interface MicrosandboxNetworkConfigurable {
  network(
    configure: (
      network: MicrosandboxNetworkBuilder
    ) => MicrosandboxNetworkBuilder
  ): unknown;
}

/** Container pull policies onto the SDK's spelling. */
const PULL_POLICY = {
  always: "always",
  missing: "if-missing",
  never: "never",
} as const;

/** Allowlisted destinations without explicit ports are HTTPS only. */
const DEFAULT_ALLOWLIST_PORT = 443;

const DENY_GUEST_EGRESS_POLICY: MicrosandboxNetworkPolicy = Object.freeze({
  defaultEgress: "deny",
  defaultIngress: "allow",
  rules: Object.freeze([]),
});

/**
 * One shared install for the whole process. Every workspace session preflights
 * its own provider, so without this a cold start would kick off one ~24 MB
 * download per concurrent session, all writing the same files.
 */
let installing: Promise<void> | undefined;
const MAX_SERVICE_OUTPUT_BYTES = 1024 * 1024;
const REMOVE_STOP_TIMEOUT_MS = 2000;

/**
 * The installed microsandbox SDK package version, for `applied.engine.version`.
 * The package does not export `./package.json`, so it is read by walking up from
 * the resolved entry rather than required directly; any failure yields
 * `undefined` and the engine is reported without a version.
 */
export function microsandboxEngineVersion(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    let directory = dirname(require.resolve("microsandbox"));
    for (let depth = 0; depth < 8; depth += 1) {
      const version = packageVersion(join(directory, "package.json"));
      if (version !== undefined) {
        return version;
      }
      const parent = dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
  } catch {
    // No installed SDK, or an unreadable manifest — reported without a version.
  }
  return undefined;
}

function packageVersion(manifestPath: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  if (!("name" in parsed) || parsed.name !== "microsandbox") {
    return undefined;
  }
  if (!("version" in parsed)) {
    return undefined;
  }
  const version: unknown = parsed.version;
  return typeof version === "string" ? version : undefined;
}

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
        // Let the next attempt retry rather than caching the failure — a
        // download that failed on a flaky network should not disable the
        // backend for the rest of the session.
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
    async removeResource(name) {
      const { Sandbox, SandboxNotFoundError } = await sdk();
      try {
        await Sandbox.remove(name);
      } catch (error: unknown) {
        // Every VM is created ephemeral, so the runtime removes it itself once
        // it stops; a remove that follows a stop is expected to find nothing.
        if (!(error instanceof SandboxNotFoundError)) {
          throw error;
        }
      }
    },
    async stopResource(name) {
      const { Sandbox } = await sdk();
      const handle = await Sandbox.get(name);
      await handle.stop();
    },
  };
}

/** The SDK's config is an untyped record; read only a well-formed label map. */
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

/**
 * The guest working directory is deliberately NOT set here. `create()` stats
 * the configured workdir after boot and fails the whole sandbox if it is
 * missing — and nothing creates it for us, so an image without that exact path
 * (`node:*-slim` has `/home/node`, not `/home/user`) can never boot. Leaving it
 * unset skips that validation; the portable layer then creates the directory
 * and passes an explicit `cwd` on every exec, so nothing relies on the guest
 * default.
 */
function applySpec(
  builder: SandboxBuilder,
  spec: ContainerSpec
): SandboxBuilder {
  builder
    .image(spec.image)
    .cpus(spec.cpus)
    .memory(spec.memoryMib)
    .pullPolicy(PULL_POLICY[spec.pull])
    // Removed by the host runtime once the VM reaches a terminal status, so a
    // crashed Studio leaks a stopped VM directory at worst, not a live guest.
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
  const configurable = builder as unknown as MicrosandboxNetworkConfigurable;
  // A disabled guest interface also disables host forwarding in MicroSandbox.
  // Keep the interface present for a loopback-only Program mapping, then deny
  // all guest egress through the native policy instead.
  configurable.network((network) => {
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

/** Deny egress except TLS to the listed hosts, which the runtime verifies upstream. */
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
  get storage() {
    return guestStorage(this.native.fs(), (argv) =>
      this.exec(argv, { cwd: this.spec.workdir, env: {} })
    );
  }
  constructor(native: MicroSandbox, spec: ContainerSpec) {
    this.native = native;
    this.spec = spec;
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

    // The SDK has no AbortSignal seam, so a cancellable exec goes through the
    // streaming path purely to get a handle we can kill.
    if (options.signal) {
      const handle = await this.native.execStreamWith(cmd, (b) =>
        configureExec(b, args, options)
      );
      return collectWithSignal(handle, options.signal);
    }

    const output = await this.native.execWith(cmd, (b) =>
      configureExec(b, args, options)
    );
    return {
      exitCode: output.code,
      stderr: output.stderr(),
      stdout: output.stdout(),
    };
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

    // A TTY merges stdout+stderr into the single un-framed stream a terminal
    // wants, and makes the shell interactive (prompt, echo).
    const handle = await this.native.execStreamWith(cmd, (b) =>
      configureExec(b, args, options).tty(true).stdinPipe()
    );
    const stdin = await handle.takeStdin();

    const listeners = new Set<(chunk: string) => void>();
    const decoder = new TextDecoder();
    let closed = false;

    // Pump events into the listener set until the process exits. Detached: the
    // caller subscribes via `onData` rather than awaiting this.
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
        await handle.kill().catch(() => undefined);
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
    const settled = collectBoundedProcess(handle);
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
    // mkdir on an existing directory is not an error worth surfacing here; the
    // write below is what actually reports a bad path.
    if (parent !== path) {
      await this.ensureDirectory(parent).catch(() => undefined);
    }
    await this.native.fs().write(path, content);
  }

  async ensureDirectory(path: string): Promise<void> {
    // The SDK's mkdir creates parents already.
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
      // An unreadable directory lists as empty under the facet contract.
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

  async stop(): Promise<void> {
    await this.native.stop();
  }

  async remove(): Promise<void> {
    const { Sandbox } = await sdk();
    // The VM is discarded, so it gets a short flush window rather than the
    // SDK's 10s graceful default, which outlasts callers' teardown budgets.
    // Both steps are best effort; ephemeral VMs may already be gone after stop.
    await this.native
      .stopWithTimeout(REMOVE_STOP_TIMEOUT_MS)
      .catch(() => undefined);
    await Sandbox.remove(this.spec.name).catch(() => undefined);
  }
}

async function collectBoundedProcess(
  handle: ExecHandle
): Promise<SandboxExecResult> {
  const stdout = new BoundedBytes(MAX_SERVICE_OUTPUT_BYTES);
  const stderr = new BoundedBytes(MAX_SERVICE_OUTPUT_BYTES);
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

class BoundedBytes {
  #value = new Uint8Array();
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  append(chunk: Uint8Array): void {
    if (chunk.byteLength >= this.limit) {
      this.#value = chunk.slice(-this.limit);
      return;
    }
    const retained = Math.min(
      this.#value.byteLength,
      this.limit - chunk.length
    );
    const next = new Uint8Array(retained + chunk.byteLength);
    next.set(this.#value.slice(-retained));
    next.set(chunk, retained);
    this.#value = next;
  }

  text(): string {
    return new TextDecoder().decode(this.#value);
  }
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

/** Drain a streaming exec into a settled result, killing it if the signal fires. */
async function collectWithSignal(
  handle: ExecHandle,
  signal: AbortSignal
): Promise<SandboxExecResult> {
  if (signal.aborted) {
    await handle.kill().catch(() => undefined);
    throw new SandboxError("cancelled", "exec aborted");
  }
  // Raced rather than polled, so an abort rejects immediately instead of
  // waiting for the killed process to finish draining.
  let onAbort = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      handle.kill().catch(() => undefined);
      reject(new SandboxError("cancelled", "exec aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    const output = await Promise.race([handle.collect(), aborted]);
    return {
      exitCode: output.code,
      stderr: output.stderr(),
      stdout: output.stdout(),
    };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
