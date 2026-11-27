import type { Storage } from "@foundry/core/storage";
import type {
  SandboxCommand,
  SandboxDirectoryEntry,
  SandboxEndpoint,
  SandboxEndpointAccess,
  SandboxEndpointProtocol,
  SandboxExecResult,
  SandboxPipedProcess,
  SandboxResourceLimits,
  SandboxShell,
} from "../sandbox";

export interface NetworkDestination {
  readonly host: string;
  readonly ports?: readonly number[];
}

export interface NetworkAllowlist {
  readonly destinations: readonly NetworkDestination[];
  readonly mode: "allowlist";
}

export type NetworkPolicy = "none" | "internet" | "open" | NetworkAllowlist;

export type PullPolicy = "missing" | "always" | "never";

export interface ExposePort {
  readonly access?: SandboxEndpointAccess;
  readonly port: number;
  readonly protocol?: SandboxEndpointProtocol;
}

export type MountSource =
  | { readonly kind: "host-directory"; readonly path: string }
  | { readonly kind: "volume"; readonly name: string };

export interface ContainerMount {
  readonly access: "read-only" | "read-write";
  readonly executable?: boolean;
  readonly id: string;
  readonly source: MountSource;
  readonly target: string;
}

export interface SecretBinding {
  readonly hosts: readonly string[];
  readonly name: string;
  readonly target?: "header" | "env";
}

export interface ContainerLifetime {
  readonly idleTimeoutMs?: number;
  readonly ttlMs?: number;
  readonly whenReleased?: "stop" | "keep";
}

export interface ContainerSpec {
  readonly cpus: number;
  readonly detached: boolean;
  readonly env: Readonly<Record<string, string>>;
  readonly expose: readonly ExposePort[];
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly lifetime?: ContainerLifetime;
  readonly memoryMib: number;
  readonly mounts: readonly ContainerMount[];
  readonly name: string;
  readonly network: NetworkPolicy;
  readonly pidsLimit?: number;
  readonly ports: readonly number[];
  readonly pull: PullPolicy;
  readonly secrets: readonly SecretBinding[];
  readonly workdir: string;
}

export interface ContainerDefaults {
  readonly detached?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly image?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly lifetime?: ContainerLifetime;
  readonly network?: NetworkPolicy;
  readonly ports?: readonly number[];
  readonly pull?: PullPolicy;
  readonly resources?: SandboxResourceLimits;
  readonly workdir?: string;
}

export interface DriverExecOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly user?: string;
}

export interface DriverCapabilities {
  readonly endpoints?: readonly SandboxEndpointAccess[];
  readonly lifetime?: {
    readonly idle?: boolean;
    readonly ttl?: boolean;
  };
  readonly listing?: boolean;
  readonly mounts?: readonly MountSource["kind"][];
  readonly network?: readonly ("none" | "internet" | "open" | "allowlist")[];
  readonly pause?: boolean;
  readonly reconnect?: boolean;
  readonly secrets?: boolean;
}

export interface DriverCreateRequest {
  readonly containerId: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly name: string;
  readonly spec: ContainerSpec;
}

export interface DriverListQuery {
  readonly cursor?: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly limit?: number;
}

export type DriverResourceStatus =
  | "created"
  | "starting"
  | "running"
  | "paused"
  | "stopped"
  | "crashed"
  | "draining";

export interface DriverResourceSummary {
  readonly labels: Readonly<Record<string, string>>;
  readonly name: string;
  readonly status: DriverResourceStatus;
}

export interface DriverInventoryPage {
  readonly nextCursor?: string;
  readonly resources: readonly DriverResourceSummary[];
}

export interface DriverProcess {
  readonly id: string;
  kill(): Promise<void>;
  terminate(): Promise<void>;
  wait(): Promise<SandboxExecResult>;
}

export interface DriverHandle<TNative = unknown> {
  disconnect?(): Promise<void>;
  endpoint?(guestPort: number): Promise<SandboxEndpoint | undefined>;
  ensureDirectory(path: string): Promise<void>;
  exec(
    command: SandboxCommand,
    options: DriverExecOptions
  ): Promise<SandboxExecResult>;
  execStream?(
    command: SandboxCommand | undefined,
    options: DriverExecOptions
  ): Promise<SandboxShell>;
  readonly id: string;
  list(path: string): Promise<readonly SandboxDirectoryEntry[]>;
  readonly native?: TNative;
  pause?(): Promise<void>;
  probePort?(guestPort: number): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array>;
  remove(): Promise<void>;
  resume?(): Promise<void>;
  spawn?(
    command: SandboxCommand,
    options: DriverExecOptions
  ): Promise<SandboxPipedProcess>;
  startProcess?(
    command: SandboxCommand,
    options: DriverExecOptions
  ): Promise<DriverProcess>;
  stat(path: string): Promise<SandboxDirectoryEntry["type"] | undefined>;
  stop(): Promise<void>;
  readonly storage?: Storage;
  unmount?(id: string, target: string): Promise<void>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
}

export interface Driver<TNative = unknown> {
  readonly capabilities?: DriverCapabilities;
  connect?(
    ref: string,
    spec: ContainerSpec,
    signal?: AbortSignal
  ): Promise<DriverHandle<TNative> | undefined>;
  create(
    request: DriverCreateRequest,
    signal?: AbortSignal
  ): Promise<DriverHandle<TNative>>;
  inspect?(
    ref: string,
    signal?: AbortSignal
  ): Promise<DriverResourceStatus | undefined>;
  install?(): Promise<void>;
  isInstalled?(): Promise<boolean>;
  listResources?(query: DriverListQuery): Promise<DriverInventoryPage>;
  manualRemovalHint?(ref: string): string;
  readonly name?: string;
  pauseResource?(ref: string): Promise<void>;
  removeResource(ref: string): Promise<void>;
  resumeResource?(ref: string): Promise<void>;
  stopResource(ref: string): Promise<void>;
}
