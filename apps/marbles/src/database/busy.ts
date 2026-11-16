import { busyError } from "~/database/client";

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

export function surfacingBusy<T extends object>(store: T): T {
  return aroundCalls(store, asBusy);
}

export async function asBusy<R>(call: () => Promise<R>): Promise<R> {
  try {
    return await call();
  } catch (error) {
    throw busyError(error) ?? error;
  }
}
