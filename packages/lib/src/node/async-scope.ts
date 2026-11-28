import { AsyncLocalStorage } from "node:async_hooks";

import type { AsyncScope } from "../async-scope";

export type { AsyncScope } from "../async-scope";
// biome-ignore lint/performance/noBarrelFile: Declared Node adapter entry point re-exporting pure async-scope helpers alongside the Node adapter.
export { createPassThroughAsyncScope } from "../async-scope";

export function createNodeAsyncScope<T>(): AsyncScope<T> {
  const storage = new AsyncLocalStorage<T>();
  return {
    active: true,
    get: () => storage.getStore(),
    run: (value, work) => storage.run(value, work),
  };
}

export function asyncScope<T>(): AsyncScope<T> {
  return createNodeAsyncScope<T>();
}
