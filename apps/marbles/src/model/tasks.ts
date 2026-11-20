import type { Page } from "@foundry/core/pagination";
import type {
  ReadyQuery,
  Task,
  TaskChange,
  TaskChangeResult,
  TaskErrorCode,
  TaskNode,
  TaskQuery,
  TaskRelations,
} from "@foundry/tasks";

interface TaskCommandInputs {
  readonly change: { readonly change: TaskChange };
  readonly dependencies: { readonly id: string };
  readonly get: { readonly depth?: number; readonly id: string };
  readonly list: { readonly query: TaskQuery };
  readonly ready: { readonly query: ReadyQuery };
}

interface TaskCommandResults {
  readonly change: TaskChangeResult;
  readonly dependencies: TaskRelations;
  readonly get: TaskNode;
  readonly list: Page<TaskNode, number>;
  readonly ready: Page<Task, number>;
}

export type TaskCommandKind = keyof TaskCommandInputs;

export type TaskCommand<K extends TaskCommandKind = TaskCommandKind> = {
  readonly [P in K]: { readonly kind: P } & TaskCommandInputs[P];
}[K];

export type TaskCommandResult<K extends TaskCommandKind = TaskCommandKind> =
  TaskCommandResults[K];

export interface TaskRefusal {
  readonly code: TaskErrorCode;
  readonly message: string;
}

export type TaskOutcome<K extends TaskCommandKind = TaskCommandKind> =
  | { readonly result: TaskCommandResult<K> }
  | { readonly refusal: TaskRefusal };
