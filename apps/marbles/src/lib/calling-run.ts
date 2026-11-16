import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The run whose own body is running now: a step of a workflow run, or a
 * task's body, innermost first, so a task a step launched is its own run
 * inside its body, and a child workflow's step is the child's. Set only
 * where a body is entered (`asRun`); nothing outside a run's body (a
 * request, a schedule's tick, an observer's handler) is inside one. Like
 * the run scope's frame, it is module-level and holds only what each call
 * hands it, so two engines in one process never see each other's: each
 * engine asks whether the id is one of its own runs.
 */
const calling = new AsyncLocalStorage<string>();

/** Run `work` as the body of run `runId`. */
export function asRun<T>(runId: string, work: () => T): T {
  return calling.run(runId, work);
}

/** The run whose body is calling, if any. */
export function callingRun(): string | undefined {
  return calling.getStore();
}
