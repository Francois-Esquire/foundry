import { ambient } from "./async-context";
import { sharedContextRuntime } from "./async-context/runtime";
import type { ExecutionContext } from "./execution-context";
import type { Current } from "./run-scope";

export interface ScopeStorage<T> {
  getStore(): T | undefined;
  run<R>(value: T, work: () => R): R;
}

export function scopeStorageFor<T>(key: symbol): ScopeStorage<T> {
  const variable = sharedContextRuntime().variable<T>(key);
  return {
    getStore: () => variable.get(),
    run: (value, work) => variable.run(value, work),
  };
}

export function currentRun(): Current | undefined {
  return ambient.currentRun.get();
}

export function currentSetupCounters(): Map<string, number> | undefined {
  return ambient.setupCounters.get();
}

export function currentExecutionContext(): ExecutionContext | undefined {
  return ambient.activeWorkspace();
}
