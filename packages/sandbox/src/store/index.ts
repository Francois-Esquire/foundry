import type { ContainerRow, SandboxEvent } from "./schema";

export type { ContainerRow, ContainerRowStatus, SandboxEvent } from "./schema";

export interface ContainerStoreWrite {
  readonly deleteContainers?: readonly string[];
  readonly events?: readonly SandboxEvent[];
  readonly putContainers?: readonly ContainerRow[];
}

export interface ContainerStore {
  commit(write: ContainerStoreWrite): Promise<void>;
  get(id: string): Promise<ContainerRow | undefined>;
  identity(): Promise<string>;
  list(): Promise<readonly ContainerRow[]>;
  transaction?<T>(work: (view: ContainerStore) => Promise<T>): Promise<T>;
}
