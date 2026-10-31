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

/**
 * What the CLI and the MCP tools ask of a workspace's backlog, wherever its
 * engine runs. Every write is one `TaskChange` batch, so the package checks
 * hierarchy, cycles, statuses, and tokens once, whichever edge sent it;
 * reads are the package's own queries. `workspace/tasks.ts` runs them.
 */
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

/** A refusal as an edge reports it: the stable code and the message. */
export interface TaskRefusal {
  readonly code: TaskErrorCode;
  readonly message: string;
}

/**
 * A command's answer as it crosses a process boundary: a refusal is a
 * value, so its code survives where a thrown error keeps only its message.
 */
export type TaskOutcome<K extends TaskCommandKind = TaskCommandKind> =
  | { readonly result: TaskCommandResult<K> }
  | { readonly refusal: TaskRefusal };
