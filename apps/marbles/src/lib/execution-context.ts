import { AsyncLocalStorage } from "node:async_hooks";

import { current } from "./run-scope";

export interface ExecutionContext {
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly workspaceId: string;
}

const outsideRuns = new AsyncLocalStorage<ExecutionContext>();

export function inContext<T>(context: ExecutionContext, work: () => T): T {
  return outsideRuns.run(context, work);
}

export function activeContext(): ExecutionContext | undefined {
  return current.getStore()?.bindings.context ?? outsideRuns.getStore();
}
