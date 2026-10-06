import {
  type HarnessPermissionRequest,
  type HarnessPermissionResult,
  isHarnessQuestionTool,
} from "@foundry/agents/harness";
import type {
  CanUseTool,
  ClaudeCodeSettings,
} from "ai-sdk-provider-claude-code";
import type { NativeActivities } from "./native-activity";
import { answerClaudeQuestion } from "./questions";
import {
  type DriverRun,
  record,
  type ToolReport,
  toolReporter,
} from "./shared";

/** Reports one tool outcome; the activity is filled in from the tool-use id. */
export type ReportClaudeTool = (
  report: Omit<ToolReport, "activityId">
) => Promise<void>;

type ToolCall = Pick<ToolReport, "input" | "toolCallId" | "toolName">;

/** The prefix the CLI gives tools served by Foundry's MCP server. */
const FOUNDRY_MCP_PREFIX = "mcp__foundry__";

export interface ClaudeToolsOptions {
  activities: NativeActivities;
  agentId: string;
  run: DriverRun;
  /** The turn's own abort, joined with each request's signal. */
  signal: AbortSignal;
}

/**
 * Tool authority for one Claude Code turn. The CLI asks through two channels,
 * the PreToolUse hook and `canUseTool`, and either may arrive first; both
 * reach the same permission decision, the same AskUserQuestion bridge, and the
 * same deduplicated outcome reports.
 */
export function createClaudeTools({
  activities,
  agentId,
  run,
  signal,
}: ClaudeToolsOptions) {
  /** Native tool-use id → the activity (subagent) the call runs under. */
  const toolActivities = new Map<string, string>();
  const reporter = toolReporter(agentId, "claude-code", () => run);
  const report: ReportClaudeTool = (event) =>
    reporter.report({
      ...event,
      activityId: toolActivities.get(event.toolCallId),
    });

  /** One answer per tool call, however many channels ask for it. */
  const questionReplies = new Map<string, Promise<HarnessPermissionResult>>();
  const questionReply = (request: HarnessPermissionRequest) => {
    let reply = questionReplies.get(request.toolCallId);
    if (!reply) {
      reply = answerClaudeQuestion(
        {
          ...run,
          question: (question) =>
            run.question({
              ...question,
              activityId: toolActivities.get(request.toolCallId),
            }),
        },
        request.toolCallId,
        record(request.input),
        request.signal
      );
      questionReplies.set(request.toolCallId, reply);
    }
    return reply;
  };

  const askQuestion = async (
    request: HarnessPermissionRequest
  ): Promise<HarnessPermissionResult> => {
    const call = {
      input: request.input,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
    };
    await report({ ...call, outcome: "started" });
    try {
      return await questionReply(request);
    } catch (error) {
      await report({
        ...call,
        outcome: "failed",
        reason: request.signal.aborted
          ? "Question canceled"
          : "Question request failed",
      });
      throw error;
    }
  };

  const permission = async (
    request: HarnessPermissionRequest
  ): Promise<HarnessPermissionResult> => {
    if (request.toolName === "AskUserQuestion") {
      return await askQuestion(request);
    }
    const toolName = permissionToolName(request.toolName, run.tools);
    const hostTool = run.tools?.[toolName];
    if (hostTool && isHarnessQuestionTool(hostTool)) {
      return { behavior: "allow", updatedInput: request.input };
    }
    return await run.permission({ ...request, toolName });
  };

  /** The PreToolUse decision, in the hook's own output shape. */
  const preToolUse = async (call: ToolCall, hookOptions: unknown) => {
    const result = await permission({
      activityId: toolActivities.get(call.toolCallId),
      input: call.input,
      sessionId: run.sessionId,
      signal: hookSignal(hookOptions, signal),
      toolCallId: call.toolCallId,
      toolName: call.toolName,
    });
    if (result.behavior === "deny") {
      await report({ ...call, outcome: "refused", reason: result.message });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: result.message,
        },
      };
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        ...(result.updatedInput === undefined
          ? {}
          : { updatedInput: result.updatedInput }),
      },
    };
  };

  const hook =
    (outcome: "started" | "ran" | "failed") =>
    async (...args: unknown[]) => {
      const data = record(args[0]);
      if (
        typeof data.agent_id === "string" &&
        typeof data.tool_use_id === "string"
      ) {
        toolActivities.set(data.tool_use_id, activities.id(data.agent_id));
      }
      if (outcome === "ran") {
        await activities.claudeTool(data);
      }
      const call: ToolCall = {
        input: data.tool_input,
        toolCallId: String(data.tool_use_id ?? args[1] ?? "unknown"),
        toolName: String(data.tool_name ?? "unknown"),
      };
      await report({
        ...call,
        outcome,
        ...(outcome === "failed" ? { reason: "CLI tool failed" } : {}),
      });
      return outcome === "started" ? await preToolUse(call, args[2]) : {};
    };

  const canUseTool: CanUseTool = async (toolName, input, context) => {
    if (context.agentID) {
      toolActivities.set(context.toolUseID, activities.id(context.agentID));
    }
    const result = await permission({
      activityId: toolActivities.get(context.toolUseID),
      input,
      sessionId: run.sessionId,
      signal: AbortSignal.any([signal, context.signal]),
      suggestions: context.suggestions,
      title: context.title,
      toolCallId: context.toolUseID,
      toolName,
    });
    if (result.behavior === "deny") {
      await report({
        input,
        outcome: "refused",
        reason: result.message,
        toolCallId: context.toolUseID,
        toolName,
      });
      return result;
    }
    return {
      behavior: "allow",
      updatedInput: record(result.updatedInput ?? input),
    };
  };

  const hooks: ClaudeCodeSettings["hooks"] = {
    PostToolUse: [{ hooks: [hook("ran")] }],
    PostToolUseFailure: [{ hooks: [hook("failed")] }],
    PreToolUse: [{ hooks: [hook("started")] }],
  };

  return { canUseTool, hooks, report };
}

function hookSignal(value: unknown, parent: AbortSignal): AbortSignal {
  const { signal } = record(value);
  return signal instanceof AbortSignal
    ? AbortSignal.any([parent, signal])
    : parent;
}

/** A Foundry MCP tool answers to its host name, so host policy sees one name. */
function permissionToolName(
  toolName: string,
  tools: DriverRun["tools"]
): string {
  const localName = toolName.startsWith(FOUNDRY_MCP_PREFIX)
    ? toolName.slice(FOUNDRY_MCP_PREFIX.length)
    : toolName;
  return tools?.[localName] ? localName : toolName;
}
