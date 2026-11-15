import { busyError } from "~/database/client";

/**
 * `store`, with each call of a method made through `around`, which is
 * handed the call to make and returns what the caller gets. For a store
 * whose methods all return promises, as every package store's do. Every
 * method is called on `store` itself, so a class with private fields
 * works as before, and `instanceof` still holds; a property that is not a
 * method is passed through as it is.
 */
export function aroundCalls<T extends object>(
  store: T,
  around: <R>(call: () => Promise<R>) => Promise<R>
): T {
  return new Proxy(store, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) =>
        around(() => Reflect.apply(value, target, args) as Promise<unknown>);
    },
  });
}

/**
 * `store`, with a lock the database waited too long for surfacing as a
 * `DatabaseBusyError` rather than the raw `SQLITE_BUSY` the package store
 * meets: what the Marbles database's own stores (`tasks.ts`,
 * `sessions.ts`) already say.
 */
export function surfacingBusy<T extends object>(store: T): T {
  return aroundCalls(store, asBusy);
}

/** `call`, a lock waited on too long rejecting as a `DatabaseBusyError`. */
export async function asBusy<R>(call: () => Promise<R>): Promise<R> {
  try {
    return await call();
  } catch (error) {
    throw busyError(error) ?? error;
  }
}
