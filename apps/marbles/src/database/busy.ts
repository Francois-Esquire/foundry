import { busyError } from "~/database/client";

/**
 * `store`, as each of its calls is made, with a lock the database waited
 * too long for surfacing as a `DatabaseBusyError` rather than the raw
 * `SQLITE_BUSY` the package store meets: what the Marbles database's own
 * stores (`tasks.ts`, `sessions.ts`) already say. Every method is called on
 * `store` itself, so a class with private fields works as before, and
 * `instanceof` still holds; a call that returns no promise, and a property
 * that is not a method, are passed through as they are.
 */
export function surfacingBusy<T extends object>(store: T): T {
  return new Proxy(store, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(value, target, args);
        return result instanceof Promise
          ? result.catch((error: unknown) => {
              throw busyError(error) ?? error;
            })
          : result;
      };
    },
  });
}
