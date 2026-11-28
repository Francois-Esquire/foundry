import { ambient } from "./async-context";

export function asRun<T>(runId: string, work: () => T): T {
  return ambient.callingRun.run(runId, work);
}

export function callingRun(): string | undefined {
  return ambient.callingRun.get();
}
