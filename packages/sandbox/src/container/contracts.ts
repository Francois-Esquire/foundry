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
import type { ContainerRow } from "../store/schema";
import type { ContainerSandboxConstraints } from "./constraints";
import type { ContainerConfig, ContainerRuntime } from "./runtime";

export interface ContainerFacets extends Sandbox {
  readonly files: SandboxFilesystemFacet & Storage & StorageObserver;
  readonly ports: SandboxPortsFacet;
  readonly processes: SandboxProcessesFacet;
  readonly services: SandboxServicesFacet;
  readonly shell: SandboxShellFacet;
  readonly volumes?: SandboxVolumesFacet;
}

export interface CreateContainersOptions {
  readonly allowedMountRoots?: readonly string[];
  readonly config?: ContainerConfig;
  readonly holder?: string;
  readonly instanceLabel: string;
  readonly mountTargetRoot?: string;
  readonly report?: (line: string) => void;
  readonly runtime: ContainerRuntime;
  readonly store?: ContainerStore;
}

export interface Containers {
  get(id: string): Promise<ContainerRow | undefined>;
  list(): Promise<readonly ContainerRow[]>;
  open(id: string, signal?: AbortSignal): Promise<Container>;
  recover(
    left: (row: ContainerRow) => boolean | Promise<boolean>,
    signal?: AbortSignal
  ): Promise<ContainerRecovery>;
  remove(id: string): Promise<void>;
  restart(
    id: string,
    spec?: ContainerSandboxConstraints,
    signal?: AbortSignal
  ): Promise<void>;
  shutdown(): Promise<void>;
  start(
    spec: ContainerSandboxConstraints,
    signal?: AbortSignal
  ): Promise<Container>;
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
