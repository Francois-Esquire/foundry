import type { ExecutionStore, ExecutionView } from "@foundry.sh/marbles/engine";

/** Fail result evidence at the real store boundary, including transactions. */
export class FlakyExecutionStore {
  failing = false as boolean;

  wrap(inner: ExecutionStore): ExecutionStore {
    const view = <T extends ExecutionView>(target: T): T =>
      new Proxy(target, {
        get: (object, key) => {
          if (key === "observe") {
            return (...args: Parameters<ExecutionView["observe"]>) => {
              if (this.failing && args[1].kind === "result") {
                return Promise.reject(new Error("disk full"));
              }
              return object.observe(...args);
            };
          }
          const value = Reflect.get(object, key);
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
    const guarded = view(inner);
    return new Proxy(guarded, {
      get: (object, key) =>
        key === "transaction"
          ? <T>(work: (store: ExecutionView) => Promise<T>) =>
              inner.transaction((store) => work(view(store)))
          : Reflect.get(object, key),
    });
  }
}
