import { AsyncLocalStorage } from "node:async_hooks";
import type { Models } from "@foundry/models";
import type { Output } from "ai";
import { current } from "./run-scope";
import {
  ACTIVE_CONTEXT_KEY,
  registerAsyncStorageFactory,
  scopeStorageFor,
} from "./scope-bridge";
import type { AgentLike } from "./types";

export interface ExecutionContext {
  readonly agentIdOf?: (agent: AgentLike<Output.Output>) => string | undefined;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly models?: Models | undefined;
  readonly spawned?: string;
  readonly workspaceId: string;
}

registerAsyncStorageFactory(() => new AsyncLocalStorage());

function outsideRuns() {
  return scopeStorageFor<ExecutionContext | undefined>(ACTIVE_CONTEXT_KEY);
}

export function inContext<T>(context: ExecutionContext, work: () => T): T {
  return outsideRuns().run(context, work);
}

export function withinContext<T>(
  context: ExecutionContext | undefined,
  work: () => T
): T {
  if (context === undefined) {
    return work();
  }
  const inherited = current.getStore();
  if (inherited !== undefined && inherited.bindings.context !== context) {
    return current.exit(() => inContext(context, work));
  }
  return inContext(context, work);
}

export function activeContext(): ExecutionContext | undefined {
  return current.getStore()?.bindings.context ?? outsideRuns().getStore();
}
