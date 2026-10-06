import type {
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import type { StreamPart } from "@foundry/agents/harness";
import type { LanguageModelUsage } from "ai";
import type { ClaudeCodeSettings } from "ai-sdk-provider-claude-code";
import type { ReportClaudeTool } from "./claude-code-tools";
import type { NativeActivities } from "./native-activity";
import { type DriverRun, record } from "./shared";

const POLICY_REFUSAL = "CLI permission policy refused the tool call";

/**
 * The CLI's message stream: native task activity, the session id it settles
 * on, and refusals its own policy made without asking Foundry.
 */
export function claudeMessages(
  run: DriverRun,
  activities: NativeActivities,
  report: ReportClaudeTool
): NonNullable<ClaudeCodeSettings["onSdkMessage"]> {
  let { nativeSessionId } = run;
  const refused = (denial: Record<string, unknown>) =>
    report({
      input: denial.tool_input,
      outcome: "refused",
      reason: POLICY_REFUSAL,
      toolCallId: String(denial.tool_use_id ?? "unknown"),
      toolName: String(denial.tool_name ?? "unknown"),
    });
  return async (message) => {
    const data = record(message);
    await activities.claudeMessage(data);
    if (
      typeof data.session_id === "string" &&
      data.session_id &&
      data.session_id !== nativeSessionId
    ) {
      nativeSessionId = data.session_id;
      await run.onSessionId(nativeSessionId);
    }
    if (Array.isArray(data.permission_denials)) {
      for (const denied of data.permission_denials) {
        await refused(record(denied));
      }
    }
    if (data.type === "system" && data.subtype === "permission_denied") {
      await refused(data);
    }
  };
}

/** Subagent and schedule lifecycle hooks; they only feed activities. */
export function claudeActivityHooks(
  activities: NativeActivities
): ClaudeCodeSettings["hooks"] {
  const subagent = async (data: unknown) => {
    await activities.claudeHook(record(data));
    return {};
  };
  return {
    Stop: [
      {
        hooks: [
          async (data) => {
            await activities.claudeSchedules(record(data));
            return {};
          },
        ],
      },
    ],
    SubagentStart: [{ hooks: [subagent] }],
    SubagentStop: [{ hooks: [subagent] }],
  };
}

/** The provider's stream as harness parts; `finish` runs however it ends. */
export async function* consume(
  stream: ReadableStream<LanguageModelV4StreamPart>,
  finish: () => Promise<void>
): AsyncGenerator<StreamPart> {
  const reader = stream.getReader();
  try {
    let item = await reader.read();
    while (!item.done) {
      const part = item.value;
      if (part.type === "text-delta" || part.type === "reasoning-delta") {
        yield { id: part.id, text: part.delta, type: part.type };
      } else if (part.type === "text-end" || part.type === "reasoning-end") {
        yield { id: part.id, type: part.type };
      } else if (part.type === "error") {
        yield {
          error: new Error(
            "Claude Code turn failed; raw CLI diagnostics are withheld."
          ),
          type: "error",
        };
      } else if (part.type === "finish") {
        yield {
          finishReason: part.finishReason.unified,
          rawFinishReason: part.finishReason.raw,
          totalUsage: languageModelUsage(part.usage),
          type: "finish",
        };
      }
      item = await reader.read();
    }
  } finally {
    reader.releaseLock();
    await finish();
  }
}

/** Provider-level usage lifted to the SDK's shape, as `streamText` does. */
function languageModelUsage({
  inputTokens,
  outputTokens,
  raw,
}: LanguageModelV4Usage): LanguageModelUsage {
  return {
    inputTokenDetails: {
      cacheReadTokens: inputTokens.cacheRead,
      cacheWriteTokens: inputTokens.cacheWrite,
      noCacheTokens: inputTokens.noCache,
    },
    inputTokens: inputTokens.total,
    outputTokenDetails: {
      reasoningTokens: outputTokens.reasoning,
      textTokens: outputTokens.text,
    },
    outputTokens: outputTokens.total,
    raw,
    totalTokens:
      inputTokens.total === undefined && outputTokens.total === undefined
        ? undefined
        : (inputTokens.total ?? 0) + (outputTokens.total ?? 0),
  };
}
