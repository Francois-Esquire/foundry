import { AsyncLocalStorage } from "node:async_hooks";
import {
  type ContextKey,
  type ContextRuntime,
  type ContextSnapshot,
  type ContextVariable,
  installContextRuntime,
} from "./runtime";

function createAsyncVariable<T>(): ContextVariable<T> {
  const storage = new AsyncLocalStorage<T | undefined>();
  return {
    exit: (work) => storage.run(undefined, work),
    get: () => storage.getStore(),
    run: (value, work) => storage.run(value, work),
  };
}

export function createNodeContextRuntime(): ContextRuntime {
  const variables = new Map<ContextKey, ContextVariable<unknown>>();
  return {
    snapshot(): ContextSnapshot {
      const captured = AsyncLocalStorage.snapshot();
      return (work) => captured(work);
    },
    variable<T>(key: ContextKey): ContextVariable<T> {
      let variable = variables.get(key) as ContextVariable<T> | undefined;
      if (variable === undefined) {
        variable = createAsyncVariable<T>();
        variables.set(key, variable as ContextVariable<unknown>);
      }
      return variable;
    },
  };
}

export function installNodeContextRuntime(): void {
  installContextRuntime(createNodeContextRuntime());
}
