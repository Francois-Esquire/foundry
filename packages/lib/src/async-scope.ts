export interface AsyncScope<T> {
  get(): T | undefined;
  run<R>(value: T, work: () => R): R;
}

export function createPassThroughAsyncScope<T>(): AsyncScope<T> {
  return {
    get: () => undefined,
    run: (_value, work) => work(),
  };
}

export function asyncScope<T>(): AsyncScope<T> {
  return createPassThroughAsyncScope<T>();
}
