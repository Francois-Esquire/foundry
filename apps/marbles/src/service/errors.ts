import { TaskError, type TaskErrorCode } from "@foundry/tasks";
import { ResourceAssociationError } from "~/lib/resources";
import { NotHostedError } from "~/model/errors";

export type MarblesErrorCode =
  | "not_found"
  | "invalid_argument"
  | "not_hosted"
  | "not_ready"
  | "busy"
  | "conflict"
  | "failed";

export class MarblesError extends Error {
  override readonly name = "MarblesError";
  readonly code: MarblesErrorCode;

  constructor(code: MarblesErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

const NOT_READY_NAMES = new Set(["NotReadyError", "RecordsHeldError"]);

const TASK_CODES: Readonly<Record<TaskErrorCode, MarblesErrorCode>> = {
  conflict: "conflict",
  cycle: "invalid_argument",
  invalid_operation: "invalid_argument",
  invalid_placement: "invalid_argument",
  invalid_status: "invalid_argument",
  not_found: "not_found",
  not_ready: "not_ready",
  task_in_use: "conflict",
};

const MISSING = /^no /;

function codeOf(error: Error): MarblesErrorCode {
  if (NOT_READY_NAMES.has(error.name)) {
    return "not_ready";
  }
  if (error instanceof NotHostedError || error.name === "NotHostedError") {
    return "not_hosted";
  }
  if (error instanceof TaskError) {
    return TASK_CODES[error.code];
  }
  if (error instanceof ResourceAssociationError) {
    return MISSING.test(error.message) ? "not_found" : "invalid_argument";
  }
  if (error.name === "DatabaseBusyError") {
    return "busy";
  }
  return "failed";
}

export function toMarblesError(error: unknown): MarblesError {
  if (error instanceof MarblesError) {
    return error;
  }
  if (!(error instanceof Error)) {
    return new MarblesError("failed", String(error), { cause: error });
  }
  return new MarblesError(codeOf(error), error.message, { cause: error });
}
