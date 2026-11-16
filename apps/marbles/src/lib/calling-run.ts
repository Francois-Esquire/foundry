import { AsyncLocalStorage } from "node:async_hooks";

const calling = new AsyncLocalStorage<string>();

export function asRun<T>(runId: string, work: () => T): T {
  return calling.run(runId, work);
}

export function callingRun(): string | undefined {
  return calling.getStore();
}
