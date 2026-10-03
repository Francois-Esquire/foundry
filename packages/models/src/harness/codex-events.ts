import type { StreamPart } from "@foundry/agents/harness";
import { type DriverRun, inputSummary, record } from "./shared";
export type EmitTool = (
  toolName: string,
  toolCallId: string,
  input: unknown,
  outcome: "started" | "ran" | "refused" | "failed",
  reason?: string
) => Promise<void>;

interface EventOptions {
  agentId: string;
  onComplete: () => void;
  onTurn: (params: Record<string, unknown>) => void;
  push: (part: StreamPart) => void;
  run: DriverRun;
  stop: () => void;
}

export function createCodexEvents(options: EventOptions) {
  const { run, push } = options;
  const seen = new Set<string>();
  let steps = 0;
  const emit: EmitTool = async (
    toolName,
    toolCallId,
    input,
    outcome,
    reason
  ) => {
    const key = `${toolCallId}:${outcome}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    await run.onToolEvent({
      agentId: options.agentId,
      harness: "codex",
      inputSummary: inputSummary(input),
      outcome,
      sessionId: run.sessionId,
      toolCallId,
      toolName,
      ...(reason ? { reason } : {}),
    });
  };
  const itemEvent = async (
    params: Record<string, unknown>,
    started: boolean
  ) => {
    const item = record(params.item);
    if (!isTool(item.type)) {
      return;
    }
    const toolCallId = String(item.id ?? "unknown");
    const name = itemToolName(item);
    if (!started) {
      const outcome = toolOutcome(item);
      await emit(
        name,
        toolCallId,
        item,
        outcome,
        outcome === "ran" ? undefined : `CLI tool ${outcome}`
      );
      return;
    }
    steps += 1;
    await emit(name, toolCallId, item, "started");
    if (steps > run.profile.maxSteps) {
      await emit(
        name,
        toolCallId,
        item,
        "refused",
        "Harness tool step limit exceeded"
      );
      push({
        error: new Error("Codex exceeded the harness tool step limit."),
        type: "error",
      });
      options.stop();
    }
  };
  return {
    emit,
    async receive(method: string, params: Record<string, unknown>) {
      const handlers: Record<string, () => Promise<void> | void> = {
        error: () =>
          push({
            error: new Error(
              "Codex turn failed; raw CLI diagnostics are withheld."
            ),
            type: "error",
          }),
        "item/agentMessage/delta": () =>
          push({ delta: String(params.delta ?? ""), type: "text-delta" }),
        "item/completed": () => itemEvent(params, false),
        "item/reasoning/summaryTextDelta": () =>
          push({ delta: String(params.delta ?? ""), type: "reasoning-delta" }),
        "item/reasoning/textDelta": () =>
          push({ delta: String(params.delta ?? ""), type: "reasoning-delta" }),
        "item/started": () => itemEvent(params, true),
        "thread/tokenUsage/updated": () => push(usagePart(params)),
        "turn/completed": () => {
          const turn = record(params.turn);
          if (turn.status !== "completed") {
            push({
              error: new Error(
                `Codex turn ${String(turn.status ?? "failed")}.`
              ),
              type: "error",
            });
          }
          options.onComplete();
        },
        "turn/started": () => options.onTurn(params),
      };
      await handlers[method]?.();
    },
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

function usagePart(params: Record<string, unknown>): StreamPart {
  const usage = record(record(params.tokenUsage).last);
  return {
    type: "finish",
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
    },
  };
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
