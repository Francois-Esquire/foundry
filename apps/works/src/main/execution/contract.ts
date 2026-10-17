import { MODULE_SETTING_HOST_POLICY } from "@foundry/modules/settings";
import type { ExecutionRuns, TaskContext } from "@foundry.sh/marbles/engine";
import type { WorksResults } from "~/shared/observations";

/**
 * What Works main dispatches through the execution engine, without loading
 * it: services depend on this contract, `engine.ts` composes Marbles.
 */

/**
 * Every existing Works action runs here: saves, import, publish, builds and
 * Program lifetimes. Admission is unbounded and so is concurrency: runs
 * start in the order they were admitted, synchronously, so the library's
 * per-Module turns commit saves to one Module in request order, and a build
 * or a Program never holds a save back.
 */
export const SYSTEM_QUEUE = "system";

/**
 * Concurrency of each Module's own queues until its settings apply: the
 * `queues.*.concurrency` host defaults (spec §10).
 */
export const MODULE_QUEUE_DEFAULTS = {
  authoring: MODULE_SETTING_HOST_POLICY["queues.authoring.concurrency"].default,
  workflows: MODULE_SETTING_HOST_POLICY["queues.workflows.concurrency"].default,
} as const;
export type ModuleQueueKind = keyof typeof MODULE_QUEUE_DEFAULTS;

/** One Module's queue for its work of one kind. */
export interface ModuleQueue {
  readonly kind: ModuleQueueKind;
  readonly moduleId: string;
}

/** The engine queue name of a Module's queue, as runs record it. */
export function moduleQueue(moduleId: string, kind: ModuleQueueKind): string {
  return `module/${moduleId}/${kind}`;
}

/**
 * How a run is dispatched. There is no request identity here: a retried
 * save is matched by its own operation identity (in the run's correlation
 * and the Content's origin), which outlives run retention, not by the
 * engine's `source`, which ends when the run is pruned.
 */
export interface DispatchOptions {
  /** Host identifiers the run belongs to, such as `moduleId`. */
  readonly correlation?: Readonly<Record<string, string>>;
  /** The Module queue it waits in; `system` when omitted. */
  readonly queue?: ModuleQueue;
  /**
   * Whether a failure's message goes on the run record beside its safe
   * code; on unless `false`. Turn it off for work whose failures may carry
   * provider text, such as an agent turn: the caller still gets the error.
   */
  readonly recordErrorMessage?: boolean;
  /** Aborting cancels the run through the engine, so it is recorded `cancelled`. */
  readonly signal?: AbortSignal;
}

/** The work itself: it calls Works services and reports on `context`. */
export type RunBody<O> = (context: TaskContext) => Promise<O> | O;

export interface WorksExecution {
  /** Cancel one run through the engine; a task has settled when this resolves. */
  cancel(id: string): Promise<void>;
  /** Cancel what is left and close the engine. */
  close(): Promise<void>;
  /** Set a Module's queue concurrency, live; omitted kinds keep their value. */
  configureModuleQueues(
    moduleId: string,
    settings: Partial<Record<ModuleQueueKind, number>>
  ): void;
  /** Run `body` as an engine run and wait for its value. */
  dispatch<O>(
    name: string,
    options: DispatchOptions,
    body: RunBody<O>
  ): Promise<O>;
  /** Run `body` as an engine run; resolves with its id once it is durably queued. */
  launch<O>(
    name: string,
    options: DispatchOptions,
    body: RunBody<O>
  ): Promise<{ id: string; result: Promise<O> }>;
  /** Durable runs, queue state and lifecycle subscription, read straight from the engine. */
  readonly runs: ExecutionRuns;
}

/**
 * Record a `result` of a type Works reads back, typed by that type, on the
 * run. False when the run store did not keep it.
 */
export function observeResult<T extends keyof WorksResults>(
  context: TaskContext,
  type: T,
  data: WorksResults[T]
): boolean {
  return context.observe({ data, kind: "result", type });
}
