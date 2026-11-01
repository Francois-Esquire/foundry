export const TASK_ERROR_CODES = [
  "not_found",
  "conflict",
  "cycle",
  "invalid_status",
  "not_ready",
  "invalid_placement",
  "invalid_operation",
  "task_in_use",
] as const;

export type TaskErrorCode = (typeof TASK_ERROR_CODES)[number];

/** Every refusal the package makes; `code` is stable, `message` is not. */
export class TaskError extends Error {
  readonly code: TaskErrorCode;

  constructor(code: TaskErrorCode, message: string) {
    super(`[tasks] ${message}`);
    this.name = "TaskError";
    this.code = code;
  }
}
