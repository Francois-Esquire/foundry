import type { Storage, StorageObserver } from "@foundry/core/storage";
import type {
  Sandbox,
  SandboxFilesystemFacet,
  SandboxPortsFacet,
  SandboxProcessesFacet,
  SandboxServicesFacet,
  SandboxShellFacet,
  SandboxVolumesFacet,
} from "../sandbox";
import type { ContainerStore } from "../store/index";
import type { ContainerRow, ContainerRowStatus } from "../store/schema";
import type { ContainerDefaults, Driver, DriverCapabilities } from "./driver";
import type { ContainerSpecInput } from "./spec";

export interface ContainerFacets extends Sandbox {
  readonly files: SandboxFilesystemFacet &
    Partial<Storage> &
    Partial<StorageObserver>;
  readonly ports?: SandboxPortsFacet;
  readonly processes?: SandboxProcessesFacet;
  readonly services?: SandboxServicesFacet;
  readonly shell?: SandboxShellFacet;
  readonly storage?: Storage;
  readonly volumes?: SandboxVolumesFacet;
}

export interface ContainerQuery {
  readonly holder?: string;
  readonly status?: ContainerRowStatus | readonly ContainerRowStatus[];
}

export interface CreateContainersOptions {
  readonly defaults?: ContainerDefaults;
  readonly driver: Driver;
  readonly fetch?: typeof globalThis.fetch;
  readonly holder?: string;
  readonly instanceLabel: string;
  readonly mountTargetRoot?: string;
  readonly report?: (line: string) => void;
  readonly store?: ContainerStore;
}

export interface Containers {
  readonly capabilities: DriverCapabilities;
  get(id: string): Promise<ContainerRow | undefined>;
  list(query?: ContainerQuery): Promise<readonly ContainerRow[]>;
  open(id: string, signal?: AbortSignal): Promise<Container>;
  pause(id: string): Promise<void>;
  recover(
    left: (row: ContainerRow) => boolean | Promise<boolean>,
    signal?: AbortSignal
  ): Promise<ContainerRecovery>;
  remove(id: string): Promise<void>;
  restart(
    id: string,
    spec?: ContainerSpecInput,
    signal?: AbortSignal
  ): Promise<void>;
  resume(id: string, signal?: AbortSignal): Promise<Container>;
  shutdown(): Promise<void>;
  start(spec: ContainerSpecInput, signal?: AbortSignal): Promise<Container>;
  stop(id: string): Promise<void>;
  sweep(signal?: AbortSignal): Promise<ContainerSweep>;
}

export type ContainerSweep = readonly string[] & {
  readonly passedOver: readonly string[];
};

export interface ContainerRecovery {
  readonly conflicts: readonly string[];
  readonly kept: readonly string[];
  readonly passedOver: readonly string[];
  readonly removed: readonly string[];
  readonly swept: readonly string[];
}

export interface Container extends ContainerFacets {
  close(): Promise<void>;
  readonly id: string;
  readonly row: ContainerRow;
}
