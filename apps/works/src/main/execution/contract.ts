import { MODULE_SETTING_HOST_POLICY } from "@foundry/modules/settings";
import type { ExecutionRuns, TaskContext } from "@foundry.sh/marbles/engine";
import type { WorksResults } from "~/shared/observations";

export const SYSTEM_QUEUE = "system";

export const MODULE_QUEUE_DEFAULTS = {
  authoring: MODULE_SETTING_HOST_POLICY["queues.authoring.concurrency"].default,
  workflows: MODULE_SETTING_HOST_POLICY["queues.workflows.concurrency"].default,
} as const;
export type ModuleQueueKind = keyof typeof MODULE_QUEUE_DEFAULTS;

export interface ModuleQueue {
  readonly kind: ModuleQueueKind;
  readonly moduleId: string;
}

export function moduleQueue(moduleId: string, kind: ModuleQueueKind): string {
  return `module/${moduleId}/${kind}`;
}

export interface DispatchOptions {
  readonly correlation?: Readonly<Record<string, string>>;
  readonly queue?: ModuleQueue;
  readonly recordErrorMessage?: boolean;
  readonly signal?: AbortSignal;
}

export type RunBody<O> = (context: TaskContext) => Promise<O> | O;

export interface WorksExecution {
  cancel(id: string): Promise<void>;
  close(): Promise<void>;
  configureModuleQueues(
    moduleId: string,
    settings: Partial<Record<ModuleQueueKind, number>>
  ): void;
  dispatch<O>(
    name: string,
    options: DispatchOptions,
    body: RunBody<O>
  ): Promise<O>;
  launch<O>(
    name: string,
    options: DispatchOptions,
    body: RunBody<O>
  ): Promise<{ id: string; result: Promise<O> }>;
  readonly runs: ExecutionRuns;
}

export function observeResult<T extends keyof WorksResults>(
  context: TaskContext,
  type: T,
  data: WorksResults[T]
): Promise<boolean> {
  return context.observe({ data, kind: "result", type });
}
