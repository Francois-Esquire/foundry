import { ambient, type ExecutionContext } from "./async-context";

export type { ExecutionContext } from "./async-context";

export function inContext<T>(context: ExecutionContext, work: () => T): T {
  return ambient.workspace.run(context, work);
}

export function withinContext<T>(
  context: ExecutionContext | undefined,
  work: () => T
): T {
  return ambient.withinWorkspace(context, work);
}

export function activeContext(): ExecutionContext | undefined {
  return ambient.activeWorkspace();
}
