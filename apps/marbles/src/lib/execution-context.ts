import { AsyncLocalStorage } from "node:async_hooks";

import { current } from "./run-scope";

/**
 * What a piece of work runs as: the workspace it belongs to, the directory
 * it starts in, and the environment its commands, harnesses and sandboxes
 * inherit. An engine has one, from the workspace's registration, and
 * hands it down explicitly: each run's steps reach it through their
 * bindings, an observer's handler through `inContext`. Nothing reads it
 * from `process.cwd()` or `process.env`, so engines over different
 * workspaces in one process never see each other's.
 *
 * Code that reads `process.env` itself sees the process's environment,
 * not the workspace's: the context is the supported way to the
 * workspace's values.
 */
export interface ExecutionContext {
  /** Where work starts when nothing narrows it, such as a worktree. */
  readonly cwd: string;
  /** What a command run here inherits, before anything it is given itself. */
  readonly environment: Readonly<Record<string, string>>;
  /** The workspace the work belongs to. */
  readonly workspaceId: string;
}

const outsideRuns = new AsyncLocalStorage<ExecutionContext>();

/** Run `work` as `context`, for work an engine does outside any run. */
export function inContext<T>(context: ExecutionContext, work: () => T): T {
  return outsideRuns.run(context, work);
}

/**
 * Run `work` as `context` when there is one, else as it is: what an
 * engine does at each place it calls code an author wrote, so that code,
 * and everything it starts, runs as that engine's work. A run scope it
 * inherits from another engine's run (one engine's step launching on
 * another) is left, since the run scope's context comes first; one of the
 * same engine (a dynamic child) is kept.
 */
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

/**
 * The context of the work calling: the step's run, else what the engine
 * entered (`inContext`), else none, as in a script no host loaded.
 */
export function activeContext(): ExecutionContext | undefined {
  return current.getStore()?.bindings.context ?? outsideRuns.getStore();
}
