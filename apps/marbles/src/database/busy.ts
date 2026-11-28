export class DatabaseBusyError extends Error {
  override readonly name = "DatabaseBusyError";
}

export function busyError(error: unknown): DatabaseBusyError | undefined {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (cause instanceof DatabaseBusyError) {
      return cause;
    }
    if (
      "code" in cause &&
      typeof cause.code === "string" &&
      cause.code.startsWith("SQLITE_BUSY")
    ) {
      return new DatabaseBusyError(
        "the Marbles database is busy: another process held its write lock longer than the busy timeout; retry",
        { cause: error }
      );
    }
  }
}

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
