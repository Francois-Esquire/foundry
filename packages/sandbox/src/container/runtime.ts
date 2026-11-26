import type { Storage } from "@foundry/core/storage";
import type {
  SandboxDirectoryEntry,
  SandboxExecResult,
  SandboxPipedProcess,
  SandboxResourceLimits,
  SandboxShell,
} from "../sandbox";

export interface ContainerNetworkAllowlist {
  readonly destinations: readonly {
    readonly host: string;
    readonly ports?: readonly number[];
  }[];
  readonly mode: "allowlist";
}

export type ContainerNetwork =
  | "disabled"
  | "unrestricted"
  | ContainerNetworkAllowlist;

export type PullPolicy = "missing" | "always" | "never";

export interface ContainerConfig {
  detached?: boolean;
  disableNetwork?: boolean;
  env?: Record<string, string>;
  image?: string;
  labels?: Record<string, string>;
  name?: string;
  network?: ContainerNetwork;
  ports?: number[];
  pull?: PullPolicy;
  resources?: SandboxResourceLimits;
  workdir?: string;
}

export interface ContainerSpec {
  readonly cpus: number;
  readonly detached: boolean;
  readonly disableNetwork: boolean;
  readonly env: Readonly<Record<string, string>>;
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly memoryMib: number;
  readonly mounts: readonly ContainerMountSpec[];
  readonly name: string;
  readonly network?: ContainerNetwork;
  readonly pidsLimit?: number;
  ports: readonly ContainerPortMapping[];
  readonly pull: PullPolicy;
  readonly workdir: string;
}

export interface ContainerPortMapping {
  readonly guestPort: number;
  readonly host: string;
  readonly hostPort: number;
}

export interface ContainerMountSpec {
  readonly executable?: boolean;
  readonly id: string;
  readonly readOnly: boolean;
  readonly source: string;
  readonly target: string;
}

export interface ContainerExecOptions {
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  user?: string;
}

export interface ContainerRuntime<TNative = unknown> {
  create(spec: ContainerSpec): Promise<ContainerInstance<TNative>>;
  install?(): Promise<void>;
  isInstalled(): Promise<boolean>;
  listResources(
    query: ContainerListResourcesQuery
  ): Promise<ContainerInventoryPage>;
  removeResource(name: string): Promise<void>;
  stopResource(name: string): Promise<void>;
}

export interface ContainerListResourcesQuery {
  readonly cursor?: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly limit?: number;
}

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
  readonly nextCursor?: string;
  readonly resources: readonly ContainerResourceSummary[];
}

export interface ContainerInstance<TNative = unknown> {
  ensureDirectory(path: string): Promise<void>;
  exec(
    command: string[],
    options: ContainerExecOptions
  ): Promise<SandboxExecResult>;
  execStream(
    command: string[],
    options: ContainerExecOptions
  ): Promise<SandboxShell>;
  readonly id: string;
  list(path: string): Promise<readonly SandboxDirectoryEntry[]>;
  readonly native: TNative;
  readFile(path: string): Promise<Uint8Array>;
  remove(): Promise<void>;
  spawn(
    command: string[],
    options: ContainerExecOptions
  ): Promise<SandboxPipedProcess>;
  startProcess(
    command: string[],
    options: ContainerExecOptions
  ): Promise<ContainerProcess>;
  stat(path: string): Promise<SandboxDirectoryEntry["type"] | undefined>;
  stop(): Promise<void>;
  readonly storage: Storage;
  writeFile(path: string, content: Uint8Array): Promise<void>;
}

export interface ContainerProcess {
  readonly id: string;
  kill(): Promise<void>;
  signal(signal: number): Promise<void>;
  wait(): Promise<SandboxExecResult>;
}
