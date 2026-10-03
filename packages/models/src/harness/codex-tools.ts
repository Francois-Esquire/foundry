import {
  type HarnessPermissionResult,
  isHarnessQuestionTool,
} from "@foundry/agents/harness";
import { asSchema } from "ai";
import type { AppServerConnection } from "./app-server";
import type { EmitTool } from "./codex-events";
import { askQuestions, nativeQuestions } from "./questions";
import type { DriverRun } from "./shared";
export async function dynamicTools(run: DriverRun) {
  const result: {
    name: string;
    description: string;
    inputSchema: unknown;
    type: "function";
  }[] = [];
  for (const [name, tool] of Object.entries(run.tools ?? {})) {
    if (!tool.execute) {
      throw new Error(`Codex host tool ${name} requires an execute function.`);
    }
    result.push({
      description:
        typeof tool.description === "string" ? tool.description : name,
      inputSchema: await asSchema(tool.inputSchema).jsonSchema,
      name,
      type: "function",
    });
  }
  return result;
}

function requestToolName(
  method: string,
  params: Record<string, unknown>
): string {
  if (method === "item/tool/call") {
    return String(params.tool);
  }
  if (method === "item/commandExecution/requestApproval") {
    return "Bash";
  }
  if (method === "item/fileChange/requestApproval") {
    return "Edit";
  }
  return method;
}

export async function answerRequest(
  connection: AppServerConnection,
  method: string,
  params: Record<string, unknown>,
  id: string | number,
  run: DriverRun,
  emit: EmitTool,
  activityId?: string
) {
  if (method === "item/tool/call") {
    await callHostTool(connection, params, id, run, emit, activityId);
    return;
  }
  if (
    [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
    ].includes(method)
  ) {
    const toolCallId = String(params.itemId ?? id);
    const toolName = requestToolName(method, params);
    const result = await run.permission({
      input: params,
      sessionId: run.sessionId,
      signal: run.signal,
      toolCallId,
      toolName,
    });
    if (result.behavior === "deny") {
      await emit(toolName, toolCallId, params, "refused", result.message);
    }
    const response =
      method === "item/permissions/requestApproval"
        ? {
            permissions: result.behavior === "allow" ? params.permissions : {},
            scope: "turn",
          }
        : { decision: result.behavior === "allow" ? "accept" : "decline" };
    connection.respond(id, response);
    return;
  }
  if (method === "item/tool/requestUserInput") {
    await answerUserQuestion(connection, params, id, run, emit);
    return;
  }
  if (method === "mcpServer/elicitation/request") {
    connection.respond(id, { action: "decline", content: null });
    return;
  }
  connection.reject(id);
}

async function answerUserQuestion(
  connection: AppServerConnection,
  params: Record<string, unknown>,
  id: string | number,
  run: DriverRun,
  emit: EmitTool
) {
  const toolCallId = String(params.itemId ?? id);
  await emit("requestUserInput", toolCallId, params, "started");
  try {
    const questions = nativeQuestions(params.questions, toolCallId, "codex");
    const result = await askQuestions(run, toolCallId, questions, run.signal);
    if (result.outcome === "declined") {
      await emit(
        "requestUserInput",
        toolCallId,
        params,
        "refused",
        result.reason
      );
      connection.respondError(id, result.reason);
      return;
    }
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of questions) {
      answers[question.id] = { answers: result.answers[question.id] ?? [] };
    }
    await emit("requestUserInput", toolCallId, params, "ran");
    connection.respond(id, { answers });
  } catch (error) {
    await emit(
      "requestUserInput",
      toolCallId,
      params,
      "failed",
      run.signal.aborted ? "Question canceled" : "Question request failed"
    );
    throw error;
  }
}

async function callHostTool(
  connection: AppServerConnection,
  params: Record<string, unknown>,
  id: string | number,
  run: DriverRun,
  emit: EmitTool,
  activityId?: string
) {
  const toolName = String(params.tool);
  const toolCallId = String(params.callId ?? id);
  await emit(toolName, toolCallId, params.arguments, "started");
  const tool = run.tools?.[toolName];
  const result: HarnessPermissionResult =
    tool && isHarnessQuestionTool(tool)
      ? { behavior: "allow" }
      : await run.permission({
          input: params.arguments,
          sessionId: run.sessionId,
          signal: run.signal,
          toolCallId,
          toolName,
        });
  if (result.behavior === "deny") {
    await emit(
      toolName,
      toolCallId,
      params.arguments,
      "refused",
      result.message
    );
    connection.respond(id, toolResponse(result.message, false));
    return;
  }
  if (!tool?.execute) {
    connection.respond(id, toolResponse("Unknown host tool", false));
    return;
  }
  try {
    const input = result.updatedInput ?? params.arguments;
    const validated = await asSchema(tool.inputSchema).validate?.(input);
    if (validated && !validated.success) {
      throw new Error("Invalid host tool arguments");
    }
    const output = await tool.execute(
      validated?.success ? validated.value : input,
      {
        abortSignal: run.signal,
        context: { activityId },
        messages: [],
        toolCallId,
      }
    );
    if (
      typeof output === "object" &&
      output !== null &&
      Symbol.asyncIterator in output
    ) {
      throw new Error("Streaming host tools are not supported by Codex.");
    }
    await emit(toolName, toolCallId, params.arguments, "ran");
    connection.respond(
      id,
      toolResponse(
        typeof output === "string"
          ? output
          : (JSON.stringify(output) ?? "null"),
        true
      )
    );
  } catch {
    await emit(
      toolName,
      toolCallId,
      params.arguments,
      "failed",
      "Host tool failed"
    );
    connection.respond(id, toolResponse("Host tool failed", false));
  }
}

function toolResponse(text: string, success: boolean) {
  return { contentItems: [{ text, type: "inputText" }], success };
}
