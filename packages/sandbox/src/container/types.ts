import type { Storage } from "@foundry/core/storage";

export interface ContainerNetworkAllowlist {
  readonly destinations: readonly {
    readonly host: string;
    /** TCP destination ports. Defaults to HTTPS, 443. */
    readonly ports?: readonly number[];
  }[];
  readonly mode: "allowlist";
}

export type ContainerNetwork =
  | "disabled"
  | "unrestricted"
  | ContainerNetworkAllowlist;

import type {
  SandboxCommand,
  SandboxDirectoryEntry,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxPipedProcess,
  SandboxResourceLimits,
  SandboxShell,
  SandboxShellOptions,
} from "../types";

/**
 * A microVM-backed sandbox: a hardware-isolated libkrun VM booted from a
 * standard OCI image. Everything microsandbox-specific hides behind
 * {@link ContainerRuntime}, so the runtime is swappable behind one seam.
 *
 * The native-only runtime contract lives here; the exec, command, result, and
 * limit types are the portable core ones, which the module normalizes once at
 * its boundary.
 */

/** When to pull the image relative to VM creation. */
export type PullPolicy = "missing" | "always" | "never";

/** Lifecycle of a sandbox from the caller's point of view. */
export type ContainerStatus = "running" | "stopped" | "removed";

/** Sandbox config; all optional. Image selection is the only image-specific field. */
export interface ContainerConfig {
  /**
   * Let the VM outlive this process. Defaults to `false`: an attached VM dies
   * with the host, which keeps its lifetime equal to the app's. Detached is
   * opt-in for experiments; nothing reattaches to one yet, so a detached VM
   * left behind is stopped and replaced on the next open.
   */
  detached?: boolean;
  /**
   * Legacy choice. Defaults to denied egress. Prefer `network`.
   */
  disableNetwork?: boolean;
  /** Environment variables present in every exec. */
  env?: Record<string, string>;
  /** Base image, fully qualified. Defaults to `DEFAULT_CONTAINER_IMAGE`. */
  image?: string;
  /** Labels stamped on the sandbox — used for inventory filtering and reaping. */
  labels?: Record<string, string>;
  /**
   * Optional sandbox name, unique per host. When omitted one is generated;
   * supplying a name makes a sandbox addressable across processes.
   */
  name?: string;
  network?: ContainerNetwork;
  /**
   * Guest TCP ports to publish to the host, each bound to an ephemeral
   * `127.0.0.1` host port. Read the assigned host port back with
   * {@link ContainerSandbox.hostPort}. Empty by default.
   */
  ports?: number[];
  /**
   * Pull the image before creating the sandbox. `"missing"` (default) pulls
   * only when absent locally; `"always"` re-pulls; `"never"` fails fast if the
   * image isn't present.
   */
  pull?: PullPolicy;
  /** Coarse resource ceilings. Unset fields inherit the runtime defaults. */
  resources?: SandboxResourceLimits;
  /**
   * Working directory inside the guest. Created on start and used as the
   * default `cwd` for exec. Defaults to `DEFAULT_CONTAINER_WORKDIR`.
   */
  workdir?: string;
}

/**
 * A microVM sandbox: a native handle plus native directory enumeration. The
 * exec surface uses the portable core types, so the adapter normalizes them
 * once. Applications acquire handles through the containers registry.
 */
export interface ContainerSandbox<TNative = unknown> {
  /**
   * Copy multiple files into the guest. Keys are absolute destination paths;
   * values are file contents. Parent directories are created.
   */
  copyIn(files: Record<string, string | Uint8Array>): Promise<void>;
  /**
   * Copy a file or directory tree out of the guest. Returns a flat map of
   * absolute guest paths to their byte contents.
   */
  copyOut(path: string): Promise<Record<string, Uint8Array>>;

  /** Run a command and resolve once it exits, with demultiplexed output and exit code. */
  exec(
    command: SandboxCommand,
    options?: SandboxExecOptions
  ): Promise<SandboxExecResult>;

  /**
   * The ephemeral `127.0.0.1` host port mapped to the given published guest
   * port (see {@link ContainerConfig.ports}), or `undefined` if that port
   * wasn't published.
   */
  hostPort(guestPort: number): Promise<number | undefined>;
  /** Sandbox id assigned by the runtime. */
  readonly id: string;
  /** Whether a readable directory exists at this path. */
  isDirectory(path: string): Promise<boolean>;

  /** Enumerate a directory; recursive descends into subdirectories. */
  listDirectory(
    path: string,
    recursive: boolean
  ): Promise<readonly SandboxDirectoryEntry[]>;
  /** Runtime-native escape hatch. Use only when the methods above don't suffice. */
  readonly native: TNative;

  /** Open a live interactive shell with combined output stream and writable stdin. */
  openShell(options?: SandboxShellOptions): Promise<SandboxShell>;
  /** Read a file out of the guest as raw bytes. Rejects if the path is missing. */
  readFile(path: string): Promise<Uint8Array>;
  /** Read a file out of the guest decoded as UTF-8 text. */
  readTextFile(path: string): Promise<string>;
  /** Stop if needed and delete the sandbox. Idempotent; terminal. */
  remove(): Promise<void>;
  spawn(
    command: SandboxCommand,
    options?: SandboxExecOptions
  ): Promise<SandboxPipedProcess>;

  /** Start a non-TTY process whose stdout and stderr remain separate. */
  startProcess(
    command: SandboxCommand,
    options?: SandboxExecOptions
  ): Promise<ContainerProcess>;
  /** Last known lifecycle state. Reflects local calls, not external changes. */
  readonly status: ContainerStatus;

  /** Stop the sandbox. Idempotent. */
  stop(): Promise<void>;
  readonly storage: Storage;
  /** Working directory inside the guest. */
  readonly workdir: string;

  /** Write a file inside the guest, creating parent directories. Binary-safe. */
  writeFile(path: string, content: string | Uint8Array): Promise<void>;

  /** `await using` support — delegates to {@link ContainerSandbox.remove}. */
  [Symbol.asyncDispose](): Promise<void>;
}

/** A fully-resolved VM creation request — no defaults left to apply. */
export interface ContainerSpec {
  readonly cpus: number;
  readonly detached: boolean;
  readonly disableNetwork: boolean;
  readonly env: Readonly<Record<string, string>>;
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly memoryMib: number;
  readonly mounts: readonly ContainerMountSpec[];
  /** Sandbox name, unique per host. Doubles as the environment id. */
  readonly name: string;
  readonly network?: ContainerNetwork;
  /** Max process/thread count, applied as an `nproc` rlimit. */
  readonly pidsLimit?: number;
  /**
   * Guest ports published to the host. The microVM runtime has no "bind :0 and
   * read it back" — the host port is chosen before boot, so it is resolved
   * here rather than inspected afterwards.
   */
  ports: readonly ContainerPortMapping[];
  readonly pull: PullPolicy;
  readonly workdir: string;
}

/** One published port, host side already assigned. */
export interface ContainerPortMapping {
  readonly guestPort: number;
  /** Host ingress is private by contract; public interfaces are never valid. */
  readonly host: string;
  readonly hostPort: number;
}

export interface ContainerMountSpec {
  /** Opt in to workspace executables. Other mounts remain noexec. */
  readonly executable?: boolean;
  readonly id: string;
  readonly readOnly: boolean;
  readonly source: string;
  readonly target: string;
}

/** Normalized exec request passed to a {@link ContainerInstance}. */
export interface ContainerExecOptions {
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  user?: string;
}

/**
 * Minimal backend the portable {@link ContainerSandbox} drives — the
 * microsandbox adapter in production, an in-memory fake in tests. Both backends
 * are exercised by the same conformance suite.
 */
export interface ContainerRuntime<TNative = unknown> {
  /** Boot a microVM from a normalized spec. Resolves once it accepts commands. */
  create(spec: ContainerSpec): Promise<ContainerInstance<TNative>>;
  /**
   * Download and install the runtime binaries. A missing microVM runtime is a
   * ~24 MB download the SDK performs itself, so "not installed yet" is a state
   * the provider resolves rather than reports.
   *
   * Optional — a runtime that cannot self-install (a fake, or a pinned
   * deployment) omits it, and preflight reports `action-required` instead.
   */
  install?(): Promise<void>;
  /**
   * Whether the microVM runtime binaries are present and runnable. Unlike a
   * container daemon there is no socket to probe: the runtime is a local
   * binary, either installed or not.
   */
  isInstalled(): Promise<boolean>;
  /**
   * One page of the native inventory matching every given label. Startup
   * reconciliation drives this; a page's `nextCursor` continues the same
   * enumeration until the inventory is complete.
   */
  listResources(
    query: ContainerListResourcesQuery
  ): Promise<ContainerInventoryPage>;
  /** The resource must already be stopped. A resource already gone is not an error. */
  removeResource(name: string): Promise<void>;
  stopResource(name: string): Promise<void>;
}

export interface ContainerListResourcesQuery {
  readonly cursor?: string;
  /** Selection is the conjunction of every entry. */
  readonly labels: Readonly<Record<string, string>>;
  readonly limit?: number;
}

/** Native lifecycle status of one enumerated resource. */
export type ContainerResourceStatus =
  | "created"
  | "starting"
  | "running"
  | "paused"
  | "stopped"
  | "crashed"
  | "draining";

export interface ContainerResourceSummary {
  readonly labels: Readonly<Record<string, string>>;
  readonly name: string;
  readonly status: ContainerResourceStatus;
}

export interface ContainerInventoryPage {
  /** Present only when more of the inventory remains. */
  readonly nextCursor?: string;
  readonly resources: readonly ContainerResourceSummary[];
}

/** A handle to one booted microVM, as seen by the portable sandbox. */
export interface ContainerInstance<TNative = unknown> {
  /** Create a directory and its parents. Succeeds if it already exists. */
  ensureDirectory(path: string): Promise<void>;
  /** Run a command to completion, with separated output and exit code. */
  exec(
    command: string[],
    options: ContainerExecOptions
  ): Promise<SandboxExecResult>;
  /** Open a live TTY process with a merged output stream and writable stdin. */
  execStream(
    command: string[],
    options: ContainerExecOptions
  ): Promise<SandboxShell>;
  readonly id: string;
  /** One level of a directory. A path that is not a readable directory yields `[]`. */
  list(path: string): Promise<readonly SandboxDirectoryEntry[]>;
  /** The runtime-native handle, surfaced via `ContainerSandbox.native`. */
  readonly native: TNative;
  readFile(path: string): Promise<Uint8Array>;
  remove(): Promise<void>;
  spawn(
    command: string[],
    options: ContainerExecOptions
  ): Promise<SandboxPipedProcess>;
  /** Start a non-TTY process whose stdout and stderr remain separate. */
  startProcess(
    command: string[],
    options: ContainerExecOptions
  ): Promise<ContainerProcess>;
  /** The entry type without following links, or `undefined` when unavailable. */
  stat(path: string): Promise<SandboxDirectoryEntry["type"] | undefined>;
  stop(): Promise<void>;
  /** Strict storage operations for consumers of the Core storage contract. */
  readonly storage?: Storage;
  /** Write a file, creating parent directories. */
  writeFile(path: string, content: Uint8Array): Promise<void>;
}

export interface ContainerProcess {
  readonly id: string;
  kill(): Promise<void>;
  signal(signal: number): Promise<void>;
  wait(): Promise<SandboxExecResult>;
}

/** Injectable dependencies for the container sandbox. Tests pass a fake runtime here. */
export interface ContainerSandboxDeps<TNative = unknown> {
  /** microVM backend. Defaults to the microsandbox adapter. */
  runtime?: ContainerRuntime<TNative>;
}
