import { randomUUID } from "node:crypto";
import type { StreamPart } from "@foundry/core/agents";
import type {
  InferGenerateOutput,
  InferStreamOutput,
  LanguageModelUsage,
  Output,
  StreamTextResult,
  TextStreamPart,
  ToolSet,
} from "ai";
import { isDeepEqualData } from "ai";

import type { ModelRoute } from "../agents/model";
import type {
  AgentApprovalRequest,
  SessionEvent,
  SessionStream,
  SessionTurnOutcome,
  StreamHandlers,
} from "../session/events";
import { normalizeUsage } from "../session/metadata";
import { keptValue, stringifyValue } from "../session/serialize";
import type {
  MessageMetadata,
  MessageStatus,
  SessionMessage,
  SessionPart,
  SessionUsage,
} from "../session/types";

import { createEventQueue } from "./event-queue";

export type { HarnessStreamPart, StreamPart } from "@foundry/core/agents";

type SdkStreamPart = TextStreamPart<ToolSet>;

type RegisteredToolCallPart = Extract<StreamPart, { type: "tool-call" }>;

type RegisteredApprovalRequestPart = Extract<
  StreamPart,
  { type: "tool-approval-request" }
>;

export type StreamSource =
  | AsyncIterable<StreamPart>
  | Promise<AsyncIterable<StreamPart>>;

export interface TransformOptions<OUTPUT extends Output.Output = never> {
  commit?: (message: SessionMessage) => Promise<SessionMessage>;
  handlers?: StreamHandlers;
  model?: ModelRoute;
  output?: OUTPUT;
  result?: Promise<
    StreamTextResult<ToolSet, Record<string, unknown>, OUTPUT> | undefined
  >;
  sessionId?: string;
}

type AccumulatingPart = Extract<SessionPart, { type: "text" | "reasoning" }>;

export function transformStream<OUTPUT extends Output.Output = never>(
  source: StreamSource,
  options: TransformOptions<OUTPUT> = {}
): SessionStream<OUTPUT> {
  const queue = createEventQueue<SessionEvent>();
  const parser = createOutputParser(options.output);

  let resolveText!: (value: string) => void;
  let resolveUsage!: (value: SessionUsage) => void;
  let resolveMessage!: (value: SessionMessage) => void;
  let resolveOutcome!: (value: SessionTurnOutcome) => void;
  const text = new Promise<string>((resolve) => {
    resolveText = resolve;
  });
  const usage = new Promise<SessionUsage>((resolve) => {
    resolveUsage = resolve;
  });
  const message = new Promise<SessionMessage>((resolve) => {
    resolveMessage = resolve;
  });
  const outcome = new Promise<SessionTurnOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  let settleOutput!: (parsed: Parsed) => void;
  const structured = new Promise<InferGenerateOutput<OUTPUT>>(
    (resolve, reject) => {
      settleOutput = (parsed) =>
        "error" in parsed
          ? reject(parsed.error)
          : resolve(parsed.value as InferGenerateOutput<OUTPUT>);
    }
  );
  structured.catch(() => undefined);

  const { handlers } = options;
  const emit = (event: SessionEvent) => {
    switch (event.type) {
      case "text-delta":
        handlers?.onText?.(event.delta);
        break;
      case "harness-activity":
        handlers?.onHarnessActivity?.(event.event);
        break;
      case "harness-tool":
        handlers?.onHarnessTool?.(event.event);
        break;
      case "reasoning-delta":
        handlers?.onReasoning?.(event.delta);
        break;
      case "tool-call":
        handlers?.onToolCall?.({
          input: event.input,
          name: event.name,
          provenance: event.provenance,
          toolCallId: event.toolCallId,
        });
        break;
      case "tool-result":
        handlers?.onToolResult?.({
          isError: event.isError,
          output: event.output,
          preliminary: event.preliminary,
          toolCallId: event.toolCallId,
        });
        break;
      case "tool-approval-request": {
        const { type: _type, ...request } = event;
        handlers?.onApprovalRequest?.(request);
        break;
      }
      case "error":
        handlers?.onError?.(event.error);
        break;
      case "finish":
        handlers?.onFinish?.({ message: event.message, usage: event.usage });
        break;
      default:
        break;
    }
    queue.push(event);
  };

  const drive = async () => {
    const startedAt = Date.now();
    const parts: SessionPart[] = [];
    let textBuf = "";
    let open: AccumulatingPart | undefined;
    let usageAcc: SessionUsage = emptyUsage();
    let finish: Extract<SdkStreamPart, { type: "finish" }> | undefined;
    let hasApprovalRequest = false;
    let unkept: Error | undefined;

    const append = (part: SessionPart) => {
      parts.push(part);
      open = undefined;
    };
    const accumulate = (type: AccumulatingPart["type"], delta: string) => {
      if (open?.type !== type) {
        const part: AccumulatingPart = { text: "", type };
        parts.push(part);
        open = part;
      }
      open.text += delta;
    };
    const close = (type: AccumulatingPart["type"]) => {
      if (open?.type === type) {
        open = undefined;
      }
    };

    const finalize = async (
      status: MessageStatus,
      error?: Error
    ): Promise<SessionMessage> => {
      const metadata = buildMetadata(options.model, usageAcc, startedAt);
      const assembled = assembleMessage(
        parts,
        status,
        metadata,
        options.sessionId ?? ""
      );
      const completed = await parser.complete(
        status === "complete" &&
          outputContext(assembled.id, options.model, finish),
        error
      );
      const output = options.output
        ? keptParse(completed, metadata)
        : completed;
      const kept = await keep(assembled, options.commit);
      const committed = kept.message;
      const parsed: Parsed =
        options.output && kept.error ? { error: kept.error } : output;
      resolveText(textBuf);
      resolveUsage(usageAcc);
      resolveMessage(committed);
      settleOutput(parsed);
      resolveOutcome(outcomeOf(kept, hasApprovalRequest));
      for (const event of terminalEvents(kept, status, error, usageAcc)) {
        emit(event);
      }
      return committed;
    };

    const toolCall = (part: RegisteredToolCallPart) => {
      const { input, provenance, providerMetadata, toolCallId, toolName } =
        part;
      const call: Extract<SessionPart, { type: "tool_call" }> = {
        input,
        name: toolName,
        toolCallId,
        type: "tool_call",
      };
      if (providerMetadata) {
        call.providerOptions = providerMetadata;
      }
      if (provenance) {
        call.provenance = provenance;
      }
      append(call);
      emit({
        input,
        name: toolName,
        provenance,
        toolCallId,
        type: "tool-call",
      });
    };

    const approvalRequest = (part: RegisteredApprovalRequestPart) => {
      const { approvalId, capability, signature, toolCall: call } = part;
      if (!capability) {
        throw new Error(
          `Approval request for "${call.toolName}" carries no registered capability.`
        );
      }
      const approval: AgentApprovalRequest = {
        approvalId,
        capability,
        input: call.input,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
      };
      if (signature) {
        approval.signature = signature;
      }
      if (part.agentId) {
        approval.agentId = part.agentId;
      }
      if (part.agentGeneration !== undefined) {
        approval.agentGeneration = part.agentGeneration;
      }
      hasApprovalRequest = true;
      append({
        approvalId,
        capability,
        input: call.input,
        name: call.toolName,
        signature,
        toolCallId: call.toolCallId,
        type: "tool_approval_request",
      });
      emit({ ...approval, type: "tool-approval-request" });
    };

    // biome-ignore-start lint/suspicious/noUnnecessaryConditions: Biome cannot resolve the AI SDK's `TextStreamPart` union, so it sees only the harness members of `StreamPart`; tsc validates each case label against the full union.
    const consume = (part: StreamPart) => {
      switch (part.type) {
        case "text-delta":
          if (part.text) {
            accumulate("text", part.text);
            textBuf += part.text;
            parser.text(part.text);
            emit({ delta: part.text, type: "text-delta" });
          }
          break;
        case "reasoning-delta":
          if (part.text) {
            accumulate("reasoning", part.text);
            emit({ delta: part.text, type: "reasoning-delta" });
          }
          break;
        case "text-end":
          close("text");
          break;
        case "reasoning-end":
          close("reasoning");
          break;
        case "tool-call":
          toolCall(part);
          break;
        case "tool-result":
          if (part.preliminary) {
            emit({
              output: part.output,
              preliminary: true,
              toolCallId: part.toolCallId,
              type: "tool-result",
            });
            break;
          }
          {
            const kept = keptToolResult(part, (error) => {
              unkept ??= error;
            });
            append(kept);
            emit(
              kept.isError === true
                ? {
                    isError: true,
                    output: kept.output,
                    toolCallId: part.toolCallId,
                    type: "tool-result",
                  }
                : {
                    output: part.output,
                    toolCallId: part.toolCallId,
                    type: "tool-result",
                  }
            );
          }
          break;
        case "tool-error": {
          const output = toError(part.error).message;
          const { toolCallId } = part;
          append({ isError: true, output, toolCallId, type: "tool_result" });
          emit({ isError: true, output, toolCallId, type: "tool-result" });
          break;
        }
        case "tool-approval-request":
          approvalRequest(part);
          break;
        case "harness-approval-request":
          emit({ ...part, type: "tool-approval-request" });
          break;
        case "harness-activity":
        case "harness-tool":
          emit(part);
          break;
        case "error": {
          const error = toError(part.error);
          append({ message: error.message, type: "error" });
          emit({ error, type: "error" });
          break;
        }
        case "abort":
          throw new Error(part.reason ?? "Harness turn interrupted.");
        case "start-step":
          parser.step();
          break;
        case "finish":
          finish = part;
          usageAcc = normalizeUsage(part.totalUsage);
          break;
        default:
          break;
      }
    };
    // biome-ignore-end lint/suspicious/noUnnecessaryConditions: see above

    try {
      const stream = await source;
      for await (const part of stream) {
        consume(part);
      }
      if (unkept) {
        throw unkept;
      }

      await finalize("complete");
    } catch (err) {
      const error = toError(err);
      parts.push({ message: error.message, type: "error" });
      await finalize("error", error);
    }
    queue.close();
  };

  drive();

  return {
    [Symbol.asyncIterator]: () => queue.iterator(),
    message,
    outcome,
    output: structured,
    partialOutputStream: parser.partials as AsyncIterable<
      InferStreamOutput<OUTPUT>
    >,
    result: options.result ?? Promise.resolve(undefined),
    text,
    usage,
  };
}

type Parsed = { value: unknown } | { error: unknown };
type OutputContext = Parameters<Output.Output["parseCompleteOutput"]>[1];

interface OutputParser {
  complete(context: OutputContext | false, error?: Error): Promise<Parsed>;
  readonly partials: AsyncIterable<unknown>;
  step(): void;
  text(delta: string): void;
}

function createOutputParser(output: Output.Output | undefined): OutputParser {
  const partials = createEventQueue<unknown>();
  let stepText = "";
  let last: unknown;
  let pending: Promise<void> = Promise.resolve();
  return {
    async complete(context, error) {
      await pending;
      partials.close();
      if (!output) {
        return { value: undefined };
      }
      if (!context) {
        return { error: error ?? new Error("The turn ended with an error.") };
      }
      try {
        return {
          value: await output.parseCompleteOutput({ text: stepText }, context),
        };
      } catch (invalid) {
        return { error: invalid };
      }
    },
    partials: { [Symbol.asyncIterator]: () => partials.iterator() },
    step() {
      stepText = "";
    },
    text(delta) {
      if (!output) {
        return;
      }
      stepText += delta;
      const text = stepText;
      pending = pending.then(() => parsePartial(output, text));
    },
  };

  async function parsePartial(spec: Output.Output, text: string) {
    const result = await spec
      .parsePartialOutput({ text })
      .catch(() => undefined);
    if (result && !isDeepEqualData(result.partial, last)) {
      last = result.partial;
      partials.push(result.partial);
    }
  }
}

function outputContext(
  id: string,
  model: ModelRoute | undefined,
  finish: Extract<SdkStreamPart, { type: "finish" }> | undefined
): OutputContext {
  return {
    finishReason: finish?.finishReason ?? "other",
    response: { id, modelId: model?.id ?? "unknown", timestamp: new Date() },
    usage: finish?.totalUsage ?? emptyModelUsage(),
  };
}

function keptParse(parsed: Parsed, metadata: MessageMetadata): Parsed {
  if (!("value" in parsed)) {
    return parsed;
  }
  try {
    metadata.output = keptValue(parsed.value);
    return parsed;
  } catch (cause) {
    return {
      error: new Error(
        `The turn's structured output has no JSON form, so the session cannot keep it: ${toError(cause).message}`,
        { cause }
      ),
    };
  }
}

function keptToolResult(
  part: { output: unknown; toolCallId: string; toolName: string },
  unkept: (error: Error) => void
): Extract<SessionPart, { type: "tool_result" }> {
  const { output, toolCallId, toolName } = part;
  try {
    return { output: keptValue(output), toolCallId, type: "tool_result" };
  } catch (cause) {
    const error = new Error(
      `Tool "${toolName}" (call ${toolCallId}) returned a value with no JSON form, so the session cannot keep it: ${toError(cause).message}`,
      { cause }
    );
    unkept(error);
    return {
      isError: true,
      output: error.message,
      toolCallId,
      type: "tool_result",
    };
  }
}

function assembleMessage(
  parts: SessionPart[],
  status: MessageStatus,
  metadata: MessageMetadata,
  sessionId: string
): SessionMessage {
  const now = Date.now();
  return {
    createdAt: now,
    id: randomUUID(),
    metadata,
    parts,
    role: "assistant",
    sessionId,
    status,
    updatedAt: now,
  };
}

function outcomeOf(
  kept: { readonly error?: Error; readonly message: SessionMessage },
  hasApprovalRequest: boolean
): SessionTurnOutcome {
  if (kept.error) {
    return "failed";
  }
  return kept.message.status === "complete" && hasApprovalRequest
    ? "awaiting-approval"
    : "complete";
}

function terminalEvents(
  kept: { readonly error?: Error; readonly message: SessionMessage },
  status: MessageStatus,
  error: Error | undefined,
  usage: SessionUsage
): SessionEvent[] {
  const events: SessionEvent[] = kept.error
    ? [{ error: kept.error, type: "error" }]
    : [];
  if (status === "error") {
    events.push({ error: error ?? new Error("stream error"), type: "error" });
  } else if (kept.message.status === "complete") {
    events.push({ message: kept.message, type: "finish", usage });
  }
  return events;
}

async function keep(
  assembled: SessionMessage,
  commit: TransformOptions["commit"]
): Promise<{ readonly error?: Error; readonly message: SessionMessage }> {
  if (!commit) {
    return { message: assembled };
  }
  try {
    return { message: await commit(assembled) };
  } catch (cause) {
    const error = new Error(
      `The session could not keep the turn's reply: ${toError(cause).message}`,
      { cause }
    );
    return {
      error,
      message: {
        ...assembled,
        parts: [...assembled.parts, { message: error.message, type: "error" }],
        status: "error",
      },
    };
  }
}

function emptyUsage(): SessionUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function emptyModelUsage(): LanguageModelUsage {
  return {
    inputTokenDetails: {
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      noCacheTokens: undefined,
    },
    inputTokens: undefined,
    outputTokenDetails: { reasoningTokens: undefined, textTokens: undefined },
    outputTokens: undefined,
    totalTokens: undefined,
  };
}

function buildMetadata(
  model: ModelRoute | undefined,
  usage: SessionUsage,
  startedAt: number
): MessageMetadata {
  const completedAt = Date.now();
  return {
    ...(model
      ? {
          model: { id: model.id, provider: model.provider },
        }
      : {}),
    timing: { completedAt, durationMs: completedAt - startedAt, startedAt },
    usage,
  };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(stringifyValue(value));
}
