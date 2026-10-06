import { randomUUID } from "node:crypto";
import type { TextStreamPart, ToolSet } from "ai";

import type { ModelRoute } from "../agents/model";
import type {
  AgentApprovalRequest,
  SessionEvent,
  SessionStream,
  SessionTurnOutcome,
  StreamHandlers,
} from "../session/events";
import { normalizeUsage } from "../session/metadata";
import { stringifyValue } from "../session/serialize";
import type {
  MessageMetadata,
  MessageStatus,
  SessionMessage,
  SessionPart,
  SessionUsage,
  ToolProvenance,
} from "../session/types";

import { createEventQueue } from "./event-queue";
import type { HarnessActivityEvent, HarnessToolEvent } from "./turn-driver";

type SdkStreamPart = TextStreamPart<ToolSet>;

/** The SDK's tool call, carrying the provenance `withToolCallRegistration`
 *  stamps on it. */
type RegisteredToolCallPart = Extract<SdkStreamPart, { type: "tool-call" }> & {
  provenance?: ToolProvenance;
};

/** The SDK's approval request, carrying the authority
 *  `withToolCallRegistration` stamps on it. Absent for an unregistered tool. */
type RegisteredApprovalRequestPart = Extract<
  SdkStreamPart,
  { type: "tool-approval-request" }
> &
  Partial<
    Pick<AgentApprovalRequest, "agentGeneration" | "agentId" | "capability">
  >;

/** Parts the harness mints beside the model's: a CLI driver session's native
 *  activity, tool, and approval observations. */
export type HarnessStreamPart =
  | { type: "harness-activity"; event: HarnessActivityEvent }
  | { type: "harness-tool"; event: HarnessToolEvent }
  | ({ type: "harness-approval-request" } & AgentApprovalRequest);

export type StreamPart =
  | Exclude<SdkStreamPart, { type: "tool-call" | "tool-approval-request" }>
  | RegisteredToolCallPart
  | RegisteredApprovalRequestPart
  | HarnessStreamPart;

export type StreamSource =
  | AsyncIterable<StreamPart>
  | Promise<AsyncIterable<StreamPart>>;

export interface TransformOptions {
  /** Adapter seam: called with the assembled message before the finish event.
   *  Return a replacement (e.g. a persisted record) to emit in its place. */
  commit?: (message: SessionMessage) => Promise<SessionMessage>;
  handlers?: StreamHandlers;
  /** The route that ran the turn — recorded on `metadata.model`. */
  model?: ModelRoute;
}

type AccumulatingPart = Extract<SessionPart, { type: "text" | "reasoning" }>;

/**
 * Transform a raw model stream into a {@link SessionStream}: map each model part
 * to {@link SessionEvent}s, fire {@link StreamHandlers} as events arrive,
 * enrich the assembled message with metadata, and optionally commit it through
 * an adapter seam.
 *
 * Deliberately session-free — no store, no prompt building, no agent. It is the
 * border between a raw model stream and the session/harness layer; adapters
 * (e.g. session persistence) compose around it via the {@link
 * TransformOptions.commit} callback.
 */
export function transformStream(
  source: StreamSource,
  options: TransformOptions = {}
): SessionStream {
  const queue = createEventQueue<SessionEvent>();

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
    // The text or reasoning part deltas are appending to. Any other part
    // entering history closes it, so later deltas start a part after it.
    let open: AccumulatingPart | undefined;
    let usageAcc: SessionUsage = emptyUsage();
    let hasApprovalRequest = false;

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

    const finalize = async (
      status: MessageStatus,
      error?: Error
    ): Promise<SessionMessage> => {
      const metadata = buildMetadata(options.model, usageAcc, startedAt);
      const assembled = assembleMessage(parts, status, metadata);
      const committed = options.commit
        ? await options.commit(assembled).catch(() => assembled)
        : assembled;
      resolveText(textBuf);
      resolveUsage(usageAcc);
      resolveMessage(committed);
      // A segment with an unresolved approval request is still a complete
      // Session message — it just reports "awaiting-approval" so a caller
      // (e.g. a Studio execution adapter) knows not to treat the turn as done.
      resolveOutcome(
        status === "complete" && hasApprovalRequest
          ? "awaiting-approval"
          : "complete"
      );
      // Emit the terminal event in the same tick as the resolves, so a consumer
      // awaiting `text`/`message` without iterating still observes the
      // finish/error handler having fired (no intervening microtask boundary).
      if (status === "error") {
        emit({ error: error ?? new Error("stream error"), type: "error" });
      } else if (committed.status === "complete") {
        emit({ message: committed, type: "finish", usage: usageAcc });
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
      // Preserve provider metadata (e.g. Gemini 3's `thoughtSignature`)
      // so a persisted + replayed tool call stays valid on the next turn.
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
      // The emitting source attaches the capability at its registration seam;
      // without one there is no authority the request could be resolved under.
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
        case "reasoning-end":
          open = undefined;
          break;
        case "tool-call":
          toolCall(part);
          break;
        case "tool-result":
          // A generator tool yields interim results the SDK flags
          // `preliminary`; only the final one belongs in history.
          if (part.preliminary) {
            emit({
              output: part.output,
              preliminary: true,
              toolCallId: part.toolCallId,
              type: "tool-result",
            });
            break;
          }
          append({
            output: part.output,
            toolCallId: part.toolCallId,
            type: "tool_result",
          });
          emit({
            output: part.output,
            toolCallId: part.toolCallId,
            type: "tool-result",
          });
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
        // Driver sessions persist native events immediately, before completion.
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
        case "finish":
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
    text,
    usage,
  };
}

function assembleMessage(
  parts: SessionPart[],
  status: MessageStatus,
  metadata: MessageMetadata
): SessionMessage {
  const now = Date.now();
  return {
    createdAt: now,
    id: randomUUID(),
    metadata,
    parts,
    role: "assistant",
    sessionId: "",
    status,
    updatedAt: now,
  };
}

function emptyUsage(): SessionUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
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
          model: {
            harness: model.harness,
            id: model.id,
            provider: model.provider,
          },
        }
      : {}),
    timing: { completedAt, durationMs: completedAt - startedAt, startedAt },
    usage,
  };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(stringifyValue(value));
}
