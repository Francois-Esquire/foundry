/**
 * Persistence contract for the containers registry. Runtime-free so storage
 * adapters can implement it without loading a microVM provider.
 */

/**
 * Status of the persisted row, distinct from a runtime's live VM status.
 */
export type ContainerRowStatus =
  | "starting"
  | "running"
  | "restarting"
  | "missing"
  | "stopped"
  | "failed";

export interface ContainerRow {
  readonly createdAt: number;
  readonly id: string;
  /** The runtime's name for the VM realizing this row. Undefined until the first start. */
  readonly nativeId: string | undefined;
  /**
   * The approved container constraints as JSON. Opaque here: parsing needs
   * the constraints schema from `./constraints`, which would break the
   * runtime-free rule. The registry parses; the store carries bytes.
   */
  readonly spec: string;
  readonly status: ContainerRowStatus;
  readonly updatedAt: number;
}

export type ContainerRowPatch = Partial<
  Pick<ContainerRow, "nativeId" | "spec" | "status" | "updatedAt">
>;

export interface ContainerStore {
  get(id: string): Promise<ContainerRow | undefined>;
  insert(row: ContainerRow): Promise<void>;
  list(): Promise<readonly ContainerRow[]>;
  remove(id: string): Promise<void>;
  update(id: string, patch: ContainerRowPatch): Promise<void>;
}

export function createMemoryContainerStore(): ContainerStore {
  const rows = new Map<string, ContainerRow>();
  return {
    get(id) {
      return Promise.resolve(rows.get(id));
    },
    insert(row) {
      if (rows.has(row.id)) {
        return Promise.reject(new Error(`container ${row.id} already exists`));
      }
      rows.set(row.id, Object.freeze({ ...row }));
      return Promise.resolve();
    },
    list() {
      return Promise.resolve(Object.freeze([...rows.values()]));
    },
    remove(id) {
      rows.delete(id);
      return Promise.resolve();
    },
    update(id, patch: ContainerRowPatch) {
      const current = rows.get(id);
      if (current === undefined) {
        return Promise.reject(new Error(`container ${id} does not exist`));
      }
      rows.set(id, Object.freeze({ ...current, ...patch }));
      return Promise.resolve();
    },
  };
}
