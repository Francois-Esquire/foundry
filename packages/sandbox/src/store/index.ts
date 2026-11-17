import type { ContainerRow } from "../schema";

export type { ContainerRow, ContainerRowStatus } from "../schema";

export interface ContainerStoreWrite {
  readonly deleteContainers?: readonly string[];
  readonly putContainers?: readonly ContainerRow[];
}

export interface ContainerStore {
  commit(write: ContainerStoreWrite): Promise<void>;
  get(id: string): Promise<ContainerRow | undefined>;
  list(): Promise<readonly ContainerRow[]>;
  transaction?<T>(work: (view: ContainerStore) => Promise<T>): Promise<T>;
}
