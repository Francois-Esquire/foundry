import type {
  EntryStats,
  StorageReader,
  StorageWriter,
} from "@foundry/core/storage";

export type SandboxCommand = string | readonly string[];

export interface SandboxResourceLimits {
  readonly cpus?: number;
  readonly memoryBytes?: number;
  readonly pids?: number;
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
  readonly path: string;
}

export interface SandboxListOptions {
  readonly recursive?: boolean;
}

export interface SandboxFilesystemFacet
  extends Pick<StorageReader, "readFile">,
    StorageWriter {
  copyIn(files: Readonly<Record<string, string | Uint8Array>>): Promise<void>;
  copyOut(path: string): Promise<Readonly<Record<string, Uint8Array>>>;
  isDirectory(path: string): Promise<boolean>;
  list(
    path: string,
    options?: SandboxListOptions
  ): Promise<readonly SandboxDirectoryEntry[]>;
}

export interface SandboxCommandFacet {
  exec(
    command: SandboxCommand,
    options?: SandboxExecOptions
  ): Promise<SandboxExecResult>;
}

export interface SandboxShellOptions {
  readonly command?: SandboxCommand;
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
}

export interface SandboxShell {
  close(): Promise<void>;
  onData(listener: (chunk: string) => void): () => void;
  write(data: string): void;
}

export interface SandboxShellFacet {
  open(options?: SandboxShellOptions): Promise<SandboxShell>;
}

export type SandboxProcessStatus = "running" | "exited" | "terminated";

export interface SandboxProcess {
  readonly id: string;
  kill?(): Promise<void>;
  readonly status: SandboxProcessStatus;
  terminate(): Promise<void>;
  wait(): Promise<SandboxExecResult>;
}

export interface SandboxProcessesFacet {
  spawn?(
    command: SandboxCommand,
    options?: SandboxExecOptions
  ): Promise<SandboxPipedProcess>;
  start(
    command: SandboxCommand,
    options?: SandboxExecOptions
  ): Promise<SandboxProcess>;
}

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

export type SandboxEndpointAccess = "loopback" | "private" | "public";

export type SandboxEndpointProtocol = "http" | "https" | "tcp" | "ws" | "wss";

export interface SandboxEndpoint {
  readonly access: SandboxEndpointAccess;
  readonly expiresAt?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly host?: string;
  readonly port?: number;
  readonly protocol: SandboxEndpointProtocol;
  readonly url: string;
}

export interface SandboxPortBinding {
  readonly host: string;
  readonly port: number;
}

export interface SandboxPortsFacet {
  endpoint(port: number): Promise<SandboxEndpoint | undefined>;
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
    }
  | {
      readonly kind: "http";
      readonly port: number;
      readonly path?: string;
      readonly timeoutMs: number;
      readonly intervalMs?: number;
    };

export interface SandboxStartServiceInput {
  readonly argv: readonly [string, ...string[]];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly id: string;
  readonly readiness: SandboxServiceReadiness;
  readonly terminationGraceMs?: number;
}

export interface SandboxServicesFacet {
  list(): Promise<readonly SandboxService[]>;
  start(input: SandboxStartServiceInput): Promise<SandboxService>;
  stop(id: string): Promise<void>;
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

export interface Sandbox {
  readonly commands: SandboxCommandFacet;
  readonly files: SandboxFilesystemFacet;
  readonly workingDirectory: string;
}
