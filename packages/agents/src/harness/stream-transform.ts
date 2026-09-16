import { randomUUID } from "node:crypto";

import type { ModelRoute } from "../agents/model";
import type { Capability } from "../authorization";
import type {
  MessageMetadata,
  MessageStatus,
  SessionEvent,
  SessionMessage,
  SessionPart,
  SessionStream,
  SessionTurnOutcome,
  SessionUsage,
  StreamHandlers,
  ToolProvenance,
} from "../session";

import { createEventQueue } from "./event-queue";

export type StreamPart = { type: string } & Record<string, unknown>;

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
  const text = new Promise<string>((r) => (resolveText = r));
  const usage = new Promise<SessionUsage>((r) => (resolveUsage = r));
  const message = new Promise<SessionMessage>((r) => (resolveMessage = r));
  const outcome = new Promise<SessionTurnOutcome>((r) => (resolveOutcome = r));

  const handlers = options.handlers;
  const emit = (event: SessionEvent) => {
    switch (event.type) {
      case "text-delta":
        handlers?.onText?.(event.delta);
        break;
      case "reasoning-delta":
        handlers?.onReasoning?.(event.delta);
        break;
      case "tool-call":
        handlers?.onToolCall?.({
          input: event.input,
          name: event.name,
          toolCallId: event.toolCallId,
          ...(event.provenance ? { provenance: event.provenance } : {}),
        });
        break;
      case "tool-result":
        handlers?.onToolResult?.({
          isError: event.isError,
          output: event.output,
          toolCallId: event.toolCallId,
          ...(event.preliminary ? { preliminary: true } : {}),
        });
        break;
      case "tool-approval-request":
        handlers?.onApprovalRequest?.({
          approvalId: event.approvalId,
          capability: event.capability,
          input: event.input,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ...(event.signature === undefined
            ? {}
            : { signature: event.signature }),
          ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
          ...(event.agentGeneration === undefined
            ? {}
            : { agentGeneration: event.agentGeneration }),
        });
        break;
      case "error":
        handlers?.onError?.(event.error);
        break;
      case "finish":
        handlers?.onFinish?.({ message: event.message, usage: event.usage });
        break;
    }
    queue.push(event);
  };

  const drive = async () => {
    const startedAt = Date.now();
    const parts: SessionPart[] = [];
    let textBuf = "";
    let textIdx: number | null = null;
    let reasoningIdx: number | null = null;
    let usageAcc: SessionUsage = emptyUsage();
    let hasApprovalRequest = false;

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

    try {
      const stream = await source;
      for await (const ev of stream) {
        switch (ev.type) {
          case "text-delta": {
            const delta = readString(ev, ["text", "delta"]);
            if (!delta) {
              break;
            }
            if (textIdx === null) {
              parts.push({ text: "", type: "text" });
              textIdx = parts.length - 1;
            }
            const part = parts[textIdx];
            if (part?.type === "text") {
              part.text += delta;
            }
            textBuf += delta;
            reasoningIdx = null;
            emit({ delta, type: "text-delta" });
            break;
          }
          case "text-end": {
            textIdx = null;
            break;
          }
          case "reasoning-delta": {
            const delta = readString(ev, ["text", "delta"]);
            if (!delta) {
              break;
            }
            if (reasoningIdx === null) {
              parts.push({ text: "", type: "reasoning" });
              reasoningIdx = parts.length - 1;
            }
            const part = parts[reasoningIdx];
            if (part?.type === "reasoning") {
              part.text += delta;
            }
            textIdx = null;
            emit({ delta, type: "reasoning-delta" });
            break;
          }
          case "reasoning-end": {
            reasoningIdx = null;
            break;
          }
          case "tool-call": {
            const toolCallId = readString(ev, ["toolCallId"]);
            const name = readString(ev, ["toolName", "name"]);
            const callInput = ev.input ?? ev.args;
            // Preserve provider metadata (e.g. Gemini 3's `thoughtSignature`)
            // so a persisted + replayed tool call stays valid on the next turn.
            const providerOptions = readProviderMetadata(ev);
            const provenance = readToolProvenance(ev.provenance);
            parts.push({
              input: callInput,
              name,
              toolCallId,
              type: "tool_call",
              ...(providerOptions ? { providerOptions } : {}),
              ...(provenance ? { provenance } : {}),
            });
            textIdx = null;
            reasoningIdx = null;
            emit({
              input: callInput,
              name,
              toolCallId,
              type: "tool-call",
              ...(provenance ? { provenance } : {}),
            });
            break;
          }
          case "tool-result": {
            const toolCallId = readString(ev, ["toolCallId"]);
            const output = ev.output ?? ev.result;
            // A generator tool yields interim results the SDK flags
            // `preliminary`; only the final one belongs in history.
            if (ev.preliminary === true) {
              emit({
                output,
                preliminary: true,
                toolCallId,
                type: "tool-result",
              });
              break;
            }
            parts.push({ output, toolCallId, type: "tool_result" });
            textIdx = null;
            reasoningIdx = null;
            emit({ output, toolCallId, type: "tool-result" });
            break;
          }
          case "tool-approval-request": {
            // The AI SDK nests the call under `toolCall`; fall back to the
            // chunk's own top-level fields for a looser/synthetic source.
            const toolCallRaw = ev.toolCall;
            const toolCall =
              toolCallRaw && typeof toolCallRaw === "object"
                ? (toolCallRaw as Record<string, unknown>)
                : undefined;
            const approvalId = readString(ev, ["approvalId"]);
            const toolCallId =
              stringField(toolCall, "toolCallId") ||
              readString(ev, ["toolCallId"]);
            const toolName =
              stringField(toolCall, "toolName") ||
              readString(ev, ["toolName", "name"]);
            const input = toolCall ? toolCall.input : ev.input;
            const signature = readString(ev, ["signature"]) || undefined;
            // Not resolvable from the raw stream chunk alone — the emitting
            // source (a tool compiled with its capability, per the design's
            // tool-registration seam) is responsible for attaching it.
            const capability = ev.capability as Capability;
            // Stamped by the registration-aware stream wrapper alongside the
            // capability, so an "always" answer resolved much later lands on
            // the Subject that actually asked.
            const agentId = readString(ev, ["agentId"]) || undefined;
            const agentGeneration =
              typeof ev.agentGeneration === "number"
                ? ev.agentGeneration
                : undefined;
            hasApprovalRequest = true;
            parts.push({
              approvalId,
              capability,
              input,
              name: toolName,
              toolCallId,
              type: "tool_approval_request",
              ...(signature ? { signature } : {}),
            });
            textIdx = null;
            reasoningIdx = null;
            emit({
              approvalId,
              capability,
              input,
              toolCallId,
              toolName,
              type: "tool-approval-request",
              ...(signature ? { signature } : {}),
              ...(agentId ? { agentId } : {}),
              ...(agentGeneration === undefined ? {} : { agentGeneration }),
            });
            break;
          }
          case "tool-error": {
            const toolCallId = readString(ev, ["toolCallId"]);
            const messageText = errMessage(ev.error);
            parts.push({
              isError: true,
              output: messageText,
              toolCallId,
              type: "tool_result",
            });
            emit({
              isError: true,
              output: messageText,
              toolCallId,
              type: "tool-result",
            });
            break;
          }
          case "finish": {
            usageAcc = normalizeUsage(ev.totalUsage ?? ev.usage);
            break;
          }
          case "error": {
            const error = toError(ev.error);
            parts.push({ message: error.message, type: "error" });
            emit({ error, type: "error" });
            break;
          }
          default:
            break;
        }
      }

      await finalize("complete");
    } catch (err) {
      const error = toError(err);
      parts.push({ message: error.message, type: "error" });
      await finalize("error", error);
    }
    queue.close();
  };

  void drive();

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

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeUsage(value: unknown): SessionUsage {
  const record = (value ?? {}) as Record<string, unknown>;
  const inputTokens = num(record.inputTokens) || num(record.promptTokens);
  const outputTokens = num(record.outputTokens) || num(record.completionTokens);
  const totalTokens = num(record.totalTokens) || inputTokens + outputTokens;
  const reasoningTokens = num(record.reasoningTokens);
  // Cache read/write: prefer the flat fields, fall back to the SDK's nested
  // `inputTokenDetails` (where v5+ reports `cacheReadTokens` / `cacheWriteTokens`).
  const cachedInputTokens = readUsageField(
    record,
    "cachedInputTokens",
    "cacheReadTokens"
  );
  const cacheWriteTokens = readUsageField(
    record,
    "cacheWriteTokens",
    "cacheWriteTokens"
  );
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(reasoningTokens ? { reasoningTokens } : {}),
    ...(cachedInputTokens ? { cachedInputTokens } : {}),
    ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
  };
}

/** Read a usage token field, preferring the flat key and falling back to the
 *  SDK's nested `inputTokenDetails` bag. */
function readUsageField(
  record: Record<string, unknown>,
  flatKey: string,
  detailKey: string
): number {
  const flat = num(record[flatKey]);
  if (flat) {
    return flat;
  }
  const details = record.inputTokenDetails;
  return details && typeof details === "object"
    ? num((details as Record<string, unknown>)[detailKey])
    : 0;
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
            id: model.id,
            ...(model.provider ? { provider: model.provider } : {}),
            ...(model.harness ? { harness: model.harness } : {}),
          },
        }
      : {}),
    timing: { completedAt, durationMs: completedAt - startedAt, startedAt },
    usage,
  };
}

function errMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(errMessage(value));
}

function readString(ev: StreamPart, keys: string[]): string {
  for (const key of keys) {
    const value = ev[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

/** Read a string field off a loosely-typed nested bag (e.g. a chunk's `toolCall`). */
function stringField(
  bag: Record<string, unknown> | undefined,
  key: string
): string {
  const value = bag?.[key];
  return typeof value === "string" ? value : "";
}

/** Read the AI SDK provider-metadata bag off a stream part (it arrives as
 *  `providerMetadata` on the model stream; tolerate `providerOptions` too). */
function readProviderMetadata(
  ev: StreamPart
): Record<string, Record<string, unknown>> | undefined {
  const value = ev.providerMetadata ?? ev.providerOptions;
  return value && typeof value === "object"
    ? (value as Record<string, Record<string, unknown>>)
    : undefined;
}

function readToolProvenance(value: unknown): ToolProvenance | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as Partial<ToolProvenance>;
  if (
    !["runtime", "host", "executor"].includes(
      candidate.effectLocation as string
    ) ||
    typeof candidate.invocationId !== "string" ||
    !isToolProvenanceSource(candidate.source)
  ) {
    return undefined;
  }
  return candidate as ToolProvenance;
}

function isToolProvenanceSource(
  value: unknown
): value is ToolProvenance["source"] {
  return [
    "declared",
    "builtin",
    "skill",
    "mcp",
    "mesh",
    "module",
    "external",
  ].includes(value as string);
}
