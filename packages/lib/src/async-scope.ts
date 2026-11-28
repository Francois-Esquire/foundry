export interface AsyncScope<T> {
  readonly active?: boolean;
  get(): T | undefined;
  run<R>(value: T, work: () => R): R;
}

export function createPassThroughAsyncScope<T>(): AsyncScope<T> {
  return {
    active: false,
    get: () => undefined,
    run: (_value, work) => work(),
  };
}

export function asyncScope<T>(): AsyncScope<T> {
  return createPassThroughAsyncScope<T>();
}
