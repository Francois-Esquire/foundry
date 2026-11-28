import type { Current } from "~/lib/run-scope";
import type { ExecutionContext } from "./model";
import {
  type ContextRuntime,
  type ContextSnapshot,
  type ContextVariable,
  createPortableContextRuntime,
  sharedContextRuntime,
} from "./runtime";

export type { ExecutionContext } from "./model";
export type {
  ContextRuntime,
  ContextSnapshot,
  ContextVariable,
} from "./runtime";

const CURRENT_RUN_KEY = Symbol.for("marbles.scope.current-run.v1");
const SETUP_COUNTERS_KEY = Symbol.for("marbles.scope.setup-counters.v1");
const ACTIVE_CONTEXT_KEY = Symbol.for("marbles.scope.active-context.v1");
const CALLING_RUN_KEY = Symbol.for("marbles.scope.calling-run.v1");

export interface AmbientScope {
  activeWorkspace(): ExecutionContext | undefined;
  readonly callingRun: ContextVariable<string>;
  readonly currentRun: ContextVariable<Current>;
  readonly setupCounters: ContextVariable<Map<string, number>>;
  snapshot(): ContextSnapshot;
  withinWorkspace<T>(context: ExecutionContext | undefined, work: () => T): T;
  readonly workspace: ContextVariable<ExecutionContext>;
}

export function createAmbientScope(
  runtime: ContextRuntime = createPortableContextRuntime()
): AmbientScope {
  const currentRun = runtime.variable<Current>(CURRENT_RUN_KEY);
  const setupCounters =
    runtime.variable<Map<string, number>>(SETUP_COUNTERS_KEY);
  const workspace = runtime.variable<ExecutionContext>(ACTIVE_CONTEXT_KEY);
  const callingRun = runtime.variable<string>(CALLING_RUN_KEY);

  return {
    activeWorkspace: () =>
      currentRun.get()?.bindings.context ?? workspace.get(),
    callingRun,
    currentRun,
    setupCounters,
    snapshot: () => runtime.snapshot(),
    withinWorkspace<T>(
      context: ExecutionContext | undefined,
      work: () => T
    ): T {
      if (context === undefined) {
        return work();
      }
      const inherited = currentRun.get();
      if (inherited !== undefined && inherited.bindings.context !== context) {
        return currentRun.exit(() => workspace.run(context, work));
      }
      return workspace.run(context, work);
    },
    workspace,
  };
}

export const ambient = createAmbientScope(sharedContextRuntime());
