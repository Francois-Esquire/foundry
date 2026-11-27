import type { StreamPart } from "@foundry/core/agents";
import { createNativeActivities } from "../harness/native-activity";
import { record } from "../harness/payload";
import { type DriverRun, toolReporter } from "../harness/tool-report";

interface EventOptions {
  agentId: string;
  isParentThread: (threadId: unknown) => boolean;
  onChildTurn: (threadId: string, turn: Record<string, unknown>) => void;
  onComplete: () => void | Promise<void>;
  onTurn: (params: Record<string, unknown>) => void;
  push: (part: StreamPart) => void;
  run: DriverRun;
  stop: (error?: Error) => void;
  subscribeChild: (threadId: string) => Promise<void>;
}

export function createCodexEvents(options: EventOptions) {
  let { run } = options;
  const { push } = options;
  const activities = createNativeActivities(run, crypto.randomUUID());
  const tools = toolReporter(options.agentId, "codex", () => run);
  const countedSteps = new Set<string>();
  let steps = 0;
  let limitExceeded = false;
  const recordStep = async (call: {
    activityId?: string;
    input: unknown;
    toolCallId: string;
    toolName: string;
  }): Promise<boolean> => {
    if (limitExceeded) {
      return false;
    }
    if (call.toolCallId === "unknown" || !countedSteps.has(call.toolCallId)) {
      if (call.toolCallId !== "unknown") {
        countedSteps.add(call.toolCallId);
      }
      steps += 1;
    }
    if (steps > run.profile.maxSteps) {
      limitExceeded = true;
      await tools.report({
        ...call,
        outcome: "refused",
        reason: "Harness tool step limit exceeded",
      });
      options.stop(new Error("Codex exceeded the harness tool step limit."));
      return false;
    }
    return true;
  };
  const activityId = (threadId: unknown) =>
    typeof threadId === "string" && !options.isParentThread(threadId)
      ? activities.id(threadId)
      : undefined;
  const itemEvent = async (
    params: Record<string, unknown>,
    started: boolean
  ) => {
    const item = record(params.item);
    for (const child of await activities.codexItem(item)) {
      try {
        await options.subscribeChild(child);
      } catch {
        await activities.codexTurn(child, undefined);
      }
    }
    if (!isTool(item.type)) {
      return;
    }
    const toolCallId = String(item.id ?? "unknown");
    const name = itemToolName(item);
    const report = {
      activityId: activityId(params.threadId),
      input: item,
      toolCallId,
      toolName: name,
    };
    if (!started) {
      const outcome = toolOutcome(item);
      await tools.report({
        ...report,
        outcome,
        ...(outcome === "ran" ? {} : { reason: `CLI tool ${outcome}` }),
      });
      return;
    }
    await tools.report({ ...report, outcome: "started" });
    await recordStep(report);
  };
  return {
    activityId,
    close: activities.close,
    async receive(method: string, params: Record<string, unknown>) {
      const parent = options.isParentThread(params.threadId);
      if (
        !parent &&
        (method === "turn/started" || method === "turn/completed") &&
        typeof params.threadId === "string"
      ) {
        const turn = record(params.turn);
        options.onChildTurn(params.threadId, turn);
        await activities.codexTurn(
          params.threadId,
          turn.status,
          method === "turn/started" && typeof turn.id === "string"
        );
        return;
      }
      if (!(parent || ["item/started", "item/completed"].includes(method))) {
        return;
      }
      const handlers: Record<string, () => Promise<void> | void> = {
        error: () =>
          push({
            error: new Error(
              "Codex turn failed; raw CLI diagnostics are withheld."
            ),
            type: "error",
          }),
        "item/agentMessage/delta": () => push(deltaPart("text-delta", params)),
        "item/completed": () => itemEvent(params, false),
        "item/reasoning/summaryTextDelta": () =>
          push(deltaPart("reasoning-delta", params)),
        "item/reasoning/textDelta": () =>
          push(deltaPart("reasoning-delta", params)),
        "item/started": () => itemEvent(params, true),
        "thread/tokenUsage/updated": () => push(usagePart(params)),
        "turn/completed": async () => {
          const turn = record(params.turn);
          if (turn.status !== "completed") {
            push({
              error: new Error(
                `Codex turn ${String(turn.status ?? "failed")}.`
              ),
              type: "error",
            });
          }
          await options.onComplete();
        },
        "turn/started": () => options.onTurn(params),
      };
      await handlers[method]?.();
    },
    recordStep,
    report: tools.report,
    setRun(value: DriverRun) {
      run = value;
      activities.setRun(value);
      tools.reset();
      countedSteps.clear();
      limitExceeded = false;
      steps = 0;
    },
    stoppableNativeId: activities.taskId,
  };
}

function isTool(type: unknown): boolean {
  return (
    typeof type === "string" &&
    [
      "commandExecution",
      "fileChange",
      "mcpToolCall",
      "dynamicToolCall",
      "webSearch",
      "imageGeneration",
      "collabAgentToolCall",
    ].includes(type)
  );
}

function toolOutcome(
  item: Record<string, unknown>
): "ran" | "refused" | "failed" {
  if (item.status === "declined") {
    return "refused";
  }
  if (item.status === "failed" || item.success === false) {
    return "failed";
  }
  return "ran";
}

function deltaPart(
  type: "text-delta" | "reasoning-delta",
  params: Record<string, unknown>
): StreamPart {
  return {
    id: String(params.itemId ?? ""),
    text: String(params.delta ?? ""),
    type,
  };
}

function usagePart(params: Record<string, unknown>): StreamPart {
  const usage = record(record(params.tokenUsage).last);
  return {
    finishReason: "other",
    rawFinishReason: undefined,
    totalUsage: {
      inputTokenDetails: {
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
        noCacheTokens: undefined,
      },
      inputTokens: tokenCount(usage.inputTokens),
      outputTokenDetails: { reasoningTokens: undefined, textTokens: undefined },
      outputTokens: tokenCount(usage.outputTokens),
      totalTokens: tokenCount(usage.totalTokens),
    },
    type: "finish",
  };
}

function tokenCount(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function itemToolName(item: Record<string, unknown>): string {
  if (item.type === "commandExecution") {
    return "Bash";
  }
  if (item.type === "fileChange") {
    return "Edit";
  }
  return String(item.tool ?? item.type);
}
