import type { Store, Wid, WorkspaceId } from "@c/core";

import { MemoryStore } from "@c/core";

export class SqliteStore implements Store {
  get(id: string): unknown {
    return id;
  }
}

export interface Status {
  code: number;
}

export function run(store: Store, ids: Array<WorkspaceId>): void {
  const memory = new MemoryStore();
  void memory;
  void store;
  void ids;
}

export const handler = (id: Wid): Wid => id;
