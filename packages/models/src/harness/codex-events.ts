import type { StreamPart } from "@foundry/agents/harness";
import { createNativeActivities } from "./native-activity";
import { type DriverRun, record, toolReporter } from "./shared";

interface EventOptions {
  agentId: string;
  isParentThread: (threadId: unknown) => boolean;
  onChildTurn: (threadId: string, turn: Record<string, unknown>) => void;
  onComplete: () => void | Promise<void>;
  onTurn: (params: Record<string, unknown>) => void;
  push: (part: StreamPart) => void;
  run: DriverRun;
  stop: () => void;
  subscribeChild: (threadId: string) => Promise<void>;
}

export function createCodexEvents(options: EventOptions) {
  let { run } = options;
  const { push } = options;
  const activities = createNativeActivities(run, crypto.randomUUID());
  const tools = toolReporter(options.agentId, "codex", () => run);
  let steps = 0;
  /** A child thread's activity; the parent thread runs under none. */
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
    steps += 1;
    await tools.report({ ...report, outcome: "started" });
    if (steps > run.profile.maxSteps) {
      await tools.report({
        input: item,
        outcome: "refused",
        reason: "Harness tool step limit exceeded",
        toolCallId,
        toolName: name,
      });
      push({
        error: new Error("Codex exceeded the harness tool step limit."),
        type: "error",
      });
      options.stop();
    }
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
    report: tools.report,
    setRun(value: DriverRun) {
      run = value;
      activities.setRun(value);
      tools.reset();
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

/** Codex reports usage as it changes; each update replaces the turn's total. */
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
