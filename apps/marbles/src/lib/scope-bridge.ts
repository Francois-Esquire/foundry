import type { ExecutionContext } from "./execution-context";
import type { Current } from "./run-scope";

export interface ScopeStorage<T> {
  getStore(): T | undefined;
  run<R>(value: T, work: () => R): R;
}

function createSyncStorage<T>(): ScopeStorage<T> {
  const stack: T[] = [];
  return {
    getStore(): T | undefined {
      return stack.at(-1);
    },
    run<R>(value: T, work: () => R): R {
      stack.push(value);
      try {
        return work();
      } finally {
        stack.pop();
      }
    },
  };
}

interface ScopeBridgeState {
  storageFactory: (<T>() => ScopeStorage<T>) | undefined;
  readonly storages: Map<symbol, ScopeStorage<unknown>>;
}

const SCOPE_BRIDGE_KEY = Symbol.for("marbles.scope-bridge.v2");

export const CURRENT_RUN_KEY = Symbol.for("marbles.scope.current-run.v1");
export const SETUP_COUNTERS_KEY = Symbol.for("marbles.scope.setup-counters.v1");
export const ACTIVE_CONTEXT_KEY = Symbol.for("marbles.scope.active-context.v1");

function bridgeState(): ScopeBridgeState {
  const holder = globalThis as Record<symbol, ScopeBridgeState | undefined>;
  let state = holder[SCOPE_BRIDGE_KEY];
  if (state === undefined) {
    state = {
      storageFactory: undefined,
      storages: new Map<symbol, ScopeStorage<unknown>>(),
    };
    holder[SCOPE_BRIDGE_KEY] = state;
  }
  return state;
}

export function registerAsyncStorageFactory(
  factory: <T>() => ScopeStorage<T>
): void {
  const state = bridgeState();
  if (state.storageFactory !== undefined) {
    return;
  }
  state.storageFactory = factory;
  for (const key of state.storages.keys()) {
    state.storages.set(key, factory());
  }
}

export function scopeStorageFor<T>(key: symbol): ScopeStorage<T> {
  const state = bridgeState();
  let storage = state.storages.get(key) as ScopeStorage<T> | undefined;
  if (storage === undefined) {
    storage =
      state.storageFactory === undefined
        ? createSyncStorage<T>()
        : state.storageFactory<T>();
    state.storages.set(key, storage as ScopeStorage<unknown>);
  }
  return storage;
}

export function currentRun(): Current | undefined {
  return scopeStorageFor<Current | undefined>(CURRENT_RUN_KEY).getStore();
}

export function currentSetupCounters(): Map<string, number> | undefined {
  return scopeStorageFor<Map<string, number> | undefined>(
    SETUP_COUNTERS_KEY
  ).getStore();
}

export function currentExecutionContext(): ExecutionContext | undefined {
  return (
    currentRun()?.bindings.context ??
    scopeStorageFor<ExecutionContext | undefined>(ACTIVE_CONTEXT_KEY).getStore()
  );
}
