import { TaskError } from "@foundry/tasks";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { NotHostedError, NotReadyError } from "~/model/errors";
import { taskRefusal } from "~/workspace/tasks";

export type ToolErrorCode =
  | "daemon_outdated"
  | "failed"
  | "invalid_argument"
  | "invalid_fields"
  | "invalid_filter"
  | "invalid_input"
  | "not_found"
  | "not_hosted"
  | "not_ready";

export class ToolRefusal extends Error {
  override readonly name = "ToolRefusal";
  readonly code: string;

  constructor(code: ToolErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

interface ToolError {
  readonly code: string;
  readonly message: string;
}

const NOT_READY_NAMES = new Set(["NotReadyError", "RecordsHeldError"]);
const INVALID_INPUT_NAMES = new Set([
  "LaunchInputError",
  "SchemaError",
  "ZodError",
]);
const NOT_FOUND =
  /^no (?:engine run|run|workflow or step|agent|step, workflow, schedule, or monitor) (?:named )?"/;

export function isHostingUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error instanceof NotHostedError ||
      error.name === "NotHostedError" ||
      error instanceof NotReadyError ||
      NOT_READY_NAMES.has(error.name))
  );
}

function codeOf(error: Error): string {
  if (error instanceof ToolRefusal) {
    return error.code;
  }
  if (error instanceof NotReadyError || NOT_READY_NAMES.has(error.name)) {
    return "not_ready";
  }
  if (error instanceof NotHostedError || error.name === "NotHostedError") {
    return "not_hosted";
  }
  if (INVALID_INPUT_NAMES.has(error.name)) {
    return "invalid_input";
  }
  if (NOT_FOUND.test(error.message)) {
    return "not_found";
  }
  return "failed";
}

function toolError(error: unknown): ToolError {
  if (error instanceof TaskError) {
    return taskRefusal(error);
  }
  if (!(error instanceof Error)) {
    return { code: "failed", message: String(error) };
  }
  return { code: codeOf(error), message: error.message };
}

function refusedResult(error: unknown): CallToolResult {
  return {
    content: [
      { text: JSON.stringify({ error: toolError(error) }), type: "text" },
    ],
    isError: true,
  };
}

export async function answered(
  work: () => Promise<Record<string, unknown>>
): Promise<CallToolResult> {
  try {
    const structured = await work();
    return {
      content: [{ text: JSON.stringify(structured), type: "text" }],
      structuredContent: structured,
    };
  } catch (error) {
    return refusedResult(error);
  }
}
