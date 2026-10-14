export interface Store {
  get(id: string): unknown;
}

export interface CachedStore extends Store {
  clear(): void;
}

export class BaseStore implements Store {
  get(id: string): unknown {
    return id;
  }
}

export class MemoryStore extends BaseStore {}

export interface Status {
  ok: boolean;
}

export type StoreOptions = { store: Store; retries: number };

export type Shape = { foo: string; bar: number };

export function createStore(): Store {
  return new MemoryStore();
}

interface LocalOnly {
  a: number;
}

export function useLocal(value: LocalOnly): number {
  return value.a;
}
