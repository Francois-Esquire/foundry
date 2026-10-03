import type {
  EntryStats,
  StorageReader,
  StorageWriter,
} from "@foundry/core/storage";

export type SandboxCommand = string | readonly string[];
export type SandboxNetworkMode = "disabled" | "controlled" | "unrestricted";

export interface SandboxResourceLimits {
  readonly cpus?: number;
  readonly memoryBytes?: number;
  readonly pids?: number;
}

export interface SandboxSpec {
  readonly environment?: Readonly<Record<string, string>>;
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
  readonly labels?: Readonly<Record<string, string>>;
  readonly network?: SandboxNetworkMode;
  readonly ports?: readonly number[];
  readonly resources?: SandboxResourceLimits;
  readonly workingDirectory?: string;
}

export interface SandboxExecOptions {
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly user?: string;
}

export interface SandboxExecResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface SandboxDirectoryEntry extends EntryStats {
  /** Absolute, normalized sandbox path. */
  readonly path: string;
}

export interface SandboxListOptions {
  /** Descend into subdirectories. Default: false, one level only. */
  readonly recursive?: boolean;
}

export interface SandboxSearchOptions {
  readonly caseInsensitive?: boolean;
  /** Only search files matching this glob. */
  readonly glob?: string;
  /** Directory to search under. Defaults to the working directory. */
  readonly path?: string;
}

export interface SandboxSearchMatch {
  /** 1-based line number. */
  readonly line: number;
  /** Absolute, normalized sandbox path. */
  readonly path: string;
  readonly text: string;
}

export interface SandboxFilesystemFacet
  extends Pick<StorageReader, "readFile">,
    StorageWriter {
  copyIn(files: Readonly<Record<string, string | Uint8Array>>): Promise<void>;
  copyOut(path: string): Promise<Readonly<Record<string, Uint8Array>>>;
  /** Whether a readable directory exists at this path. */
  isDirectory(path: string): Promise<boolean>;
  /**
   * Enumerate a directory. The one primitive the facet needs beyond byte
   * transfer: `glob` is enumeration plus a pattern match, so with this every
   * provider gets it from one shared implementation instead of each growing
   * its own. Search stays off this facet — `grep` is a command, run through
   * {@link SandboxCommandFacet} against a formal definition.
   *
   * Symlinks are never followed. A path that isn't a readable directory
   * yields an empty list rather than throwing, so a scan over a partly
   * readable tree degrades instead of failing.
   */
  list(
    path: string,
    options?: SandboxListOptions
  ): Promise<readonly SandboxDirectoryEntry[]>;
  /**
   * Search file contents, when this environment can do it better than running
   * `grep` through {@link SandboxCommandFacet}. Optional: a container has a
   * real grep and needs no help, so the toolkit falls back to a command there.
   *
   * A provider implements this when command execution is unavailable or its
   * file policy requires filtering that the command fallback cannot enforce.
   */
  search?(
    pattern: string,
    options?: SandboxSearchOptions
  ): Promise<readonly SandboxSearchMatch[]>;
}

export interface SandboxCommandFacet {
  /**
   * Arrays execute directly as argv. Strings execute through the provider's
   * declared shell and never undergo host-side interpolation.
   */
  exec(
    command: SandboxCommand,
    options?: SandboxExecOptions
  ): Promise<SandboxExecResult>;
}

export interface SandboxShellOptions {
  /** Process to run. Defaults to the Provider's interactive shell. */
  readonly command?: SandboxCommand;
  /** Working directory. Defaults to the sandbox working directory. */
  readonly cwd?: string;
  /** Extra environment, merged over the sandbox-level environment. */
  readonly environment?: Readonly<Record<string, string>>;
}

/** Live TTY process: merged output stream and writable stdin. */
export interface SandboxShell {
  /** Terminate the process and release the stream. Idempotent. */
  close(): Promise<void>;
  /** Subscribe to combined stdout+stderr as it arrives. Returns an unsubscribe fn. */
  onData(listener: (chunk: string) => void): () => void;
  /** Write to the process stdin — a command line (with `"\n"`), or raw keystrokes. */
  write(data: string): void;
}

export interface SandboxShellFacet {
  open(options?: SandboxShellOptions): Promise<SandboxShell>;
}

export type SandboxProcessStatus = "running" | "exited" | "terminated";

export interface SandboxProcess {
  readonly id: string;
  readonly status: SandboxProcessStatus;
  terminate(): Promise<void>;
  wait(): Promise<SandboxExecResult>;
}

export interface SandboxProcessesFacet {
  /** Separate byte streams with backpressure. Callers must drain both outputs. */
  spawn(
    command: SandboxCommand,
    options?: SandboxExecOptions
  ): Promise<SandboxPipedProcess>;
  start(
    command: SandboxCommand,
    options?: SandboxExecOptions
  ): Promise<SandboxProcess>;
}

/** Structural streams keep portable consumers independent of Node ambient types. */
export interface SandboxWritable {
  destroy(error?: Error): this;
  readonly destroyed: boolean;
  end(chunk?: string | Uint8Array): this;
  write(chunk: string | Uint8Array): boolean;
}

export interface SandboxReadable extends AsyncIterable<Uint8Array> {
  readonly destroyed: boolean;
  resume(): this;
}

export interface SandboxPipedProcess {
  readonly exitCode: number | null;
  /** Settles after output has drained; rejects on transport failure. */
  readonly exited: Promise<{ readonly exitCode: number }>;
  kill(signal?: string | number): boolean;
  readonly killed: boolean;
  off(
    event: "exit",
    listener: (code: number | null, signal: string | null) => void
  ): this;
  off(event: "error", listener: (error: Error) => void): this;
  on(
    event: "exit",
    listener: (code: number | null, signal: string | null) => void
  ): this;
  on(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit",
    listener: (code: number | null, signal: string | null) => void
  ): this;
  once(event: "error", listener: (error: Error) => void): this;
  removeListener(
    event: "exit",
    listener: (code: number | null, signal: string | null) => void
  ): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  readonly stderr: SandboxReadable;
  readonly stdin: SandboxWritable;
  readonly stdout: SandboxReadable;
}

export interface SandboxPortBinding {
  readonly host: string;
  readonly port: number;
}

export interface SandboxPortsFacet {
  hostPort(port: number): Promise<SandboxPortBinding | undefined>;
}

export interface SandboxService {
  readonly id: string;
  readonly readyAt?: number;
  readonly startedAt: number;
  readonly status: "starting" | "ready" | "exited" | "terminated";
  terminate(): Promise<SandboxServiceExit>;
  wait(): Promise<SandboxServiceExit>;
}

export interface SandboxServiceExit extends SandboxExecResult {
  readonly finishedAt: number;
  readonly terminationRequested: boolean;
}

export type SandboxServiceReadiness =
  | { readonly kind: "started" }
  | {
      readonly kind: "tcp";
      readonly port: number;
      readonly timeoutMs: number;
      readonly intervalMs?: number;
    };

export interface SandboxStartServiceInput {
  readonly argv: readonly [string, ...string[]];
  readonly cwd?: string;
  /** Ephemeral process environment; never part of an Environment profile. */
  readonly environment?: Readonly<Record<string, string>>;
  readonly id: string;
  readonly readiness: SandboxServiceReadiness;
  /** Grace after SIGTERM before SIGKILL. Maximum 30 seconds. */
  readonly terminationGraceMs?: number;
}

export interface SandboxServicesFacet {
  list(): Promise<readonly SandboxService[]>;
  start(input: SandboxStartServiceInput): Promise<SandboxService>;
  stop(id: string): Promise<void>;
}

export interface SandboxImagesFacet {
  has(reference: string): Promise<boolean>;
  pull(reference: string, signal?: AbortSignal): Promise<void>;
}

export interface SandboxVolumeMount {
  readonly access: "read-only" | "read-write";
  readonly id: string;
  readonly target: string;
}

export interface SandboxVolumesFacet {
  list(): Promise<readonly SandboxVolumeMount[]>;
  unmount(id: string): Promise<void>;
}

export interface SandboxResourceUsage {
  readonly cpuPercent?: number;
  readonly memoryBytes?: number;
  readonly processes?: number;
}

export interface SandboxResourcesFacet {
  readonly limits: SandboxResourceLimits;
  usage(): Promise<SandboxResourceUsage>;
}

export interface SandboxHeadlessFacet {
  readonly supported: true;
}

export interface SandboxNetworkPolicyFacet {
  allows(url: string): boolean;
  readonly mode: SandboxNetworkMode;
}

/** Where paths resolve, plus files and commands. Every backend is one of these. */
export interface Sandbox {
  readonly commands: SandboxCommandFacet;
  readonly files: SandboxFilesystemFacet;
  readonly workingDirectory: string;
}

export type SandboxCapability =
  | "processes"
  | "ports"
  | "services"
  | "images"
  | "volumes"
  | "resources"
  | "headless"
  | "network-policy"
  | "shell";
