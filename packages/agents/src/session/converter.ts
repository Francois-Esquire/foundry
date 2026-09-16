import type { ModelMessage, ProviderMetadata, ToolSet, UIMessage } from "ai";

import { convertToModelMessages } from "ai";
import { stringifyValue } from "./serialize";
import type { SessionMessage, SessionPart } from "./types";

type ToolResultPart = Extract<SessionPart, { type: "tool_result" }>;
type ToolCallPart = Extract<SessionPart, { type: "tool_call" }>;
type ApprovalRequestPart = Extract<
  SessionPart,
  { type: "tool_approval_request" }
>;
type ApprovalResponsePart = Extract<
  SessionPart,
  { type: "tool_approval_response" }
>;

/**
 * Pass the agent's tool set so `convertToModelMessages` can apply a tool's
 * `toModelOutput` — the one path that turns a host-executed tool's result into rich
 * model content (e.g. the preview snapshot's PNG into an image part). Tools
 * without `toModelOutput` fall back to text/JSON exactly as before.
 */
export async function toModelMessages(
  messages: SessionMessage[],
  tools?: ToolSet
): Promise<ModelMessage[]> {
  return convertToModelMessages(
    toUIMessages(messages),
    tools ? { tools } : undefined
  );
}

interface ConversionContext {
  requests: Map<string, ApprovalRequestPart>;
  responses: Map<string, ApprovalResponsePart>;
  results: Map<string, ToolResultPart>;
}

function toUIMessages(messages: SessionMessage[]): UIMessage[] {
  const results = new Map<string, ToolResultPart>();
  const requests = new Map<string, ApprovalRequestPart>();
  const responses = new Map<string, ApprovalResponsePart>();
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "tool_result") {
        results.set(p.toolCallId, p);
      }
      if (p.type === "tool_approval_request") {
        requests.set(p.toolCallId, p);
      }
      if (p.type === "tool_approval_response") {
        responses.set(p.approvalId, p);
      }
    }
  }
  const ctx: ConversionContext = { requests, responses, results };

  return messages
    .filter((m) => m.role !== "tool")
    .map((m) => ({
      id: m.id,
      parts: m.parts.flatMap((p) => toUIPart(p, ctx)),
      // A `"summary"` block is sent to the model as a system message.
      role: (m.role === "summary" ? "system" : m.role) as
        | "user"
        | "assistant"
        | "system",
    }));
}

function toUIPart(
  part: SessionPart,
  ctx: ConversionContext
): UIMessage["parts"] {
  if (part.type === "text") {
    return [{ state: "done", text: part.text, type: "text" }];
  }
  if (part.type === "reasoning") {
    return [{ state: "done", text: part.text, type: "reasoning" }];
  }
  if (part.type === "image") {
    return [
      { mediaType: part.mediaType ?? "image/*", type: "file", url: part.url },
    ];
  }
  if (part.type === "tool_call") {
    const request = ctx.requests.get(part.toolCallId);
    const response = request
      ? ctx.responses.get(request.approvalId)
      : undefined;
    return [
      toToolPart(part, ctx.results.get(part.toolCallId), request, response),
    ];
  }
  return [];
}

/**
 * Project a `tool_call` (plus its optional result/approval request/response)
 * onto the AI SDK's `ToolUIPart` state machine. `convertToModelMessages`
 * reads the `approval` field itself to (re)synthesize the real
 * `tool-approval-request`/`tool-approval-response` model parts — including
 * the denied tool-result it fabricates for `"output-denied"` — so this is the
 * one seam that has to get the state/approval shape exactly right.
 */
function toToolPart(
  call: ToolCallPart,
  result: ToolResultPart | undefined,
  request: ApprovalRequestPart | undefined,
  response: ApprovalResponsePart | undefined
): UIMessage["parts"][number] {
  const type = `tool-${call.name}` as const;
  // `convertToModelMessages` copies a tool UI part's `callProviderMetadata`
  // onto the assistant tool-call's `providerOptions` — the one path that gets
  // Gemini 3's `thoughtSignature` back into the replayed request. Attach it to
  // every state so a paused/errored call doesn't silently drop it.
  const meta = call.providerOptions
    ? { callProviderMetadata: call.providerOptions as ProviderMetadata }
    : {};
  const signature = request?.signature;

  // Denial is terminal regardless of whether a tool_result was also
  // persisted — the AI SDK synthesizes the denied tool-result itself.
  if (request && response && !response.approved) {
    return {
      input: call.input,
      state: "output-denied",
      toolCallId: call.toolCallId,
      type,
      ...meta,
      approval: {
        approved: false,
        id: request.approvalId,
        ...(response.reason === undefined ? {} : { reason: response.reason }),
        ...(signature === undefined ? {} : { signature }),
      },
    };
  }

  if (request && !response) {
    return {
      input: call.input,
      state: "approval-requested",
      toolCallId: call.toolCallId,
      type,
      ...meta,
      approval: {
        id: request.approvalId,
        ...(signature === undefined ? {} : { signature }),
      },
    };
  }

  if (!result) {
    if (request && response?.approved) {
      return {
        input: call.input,
        state: "approval-responded",
        toolCallId: call.toolCallId,
        type,
        ...meta,
        approval: {
          approved: true,
          id: request.approvalId,
          ...(response.reason === undefined ? {} : { reason: response.reason }),
          ...(signature === undefined ? {} : { signature }),
        },
      };
    }
    return {
      input: call.input,
      state: "input-available",
      toolCallId: call.toolCallId,
      type,
      ...meta,
    };
  }

  if (result.isError) {
    if (request && response?.approved) {
      return {
        errorText: stringifyValue(result.output),
        input: call.input,
        state: "output-error",
        toolCallId: call.toolCallId,
        type,
        ...meta,
        approval: {
          approved: true,
          id: request.approvalId,
          ...(response.reason === undefined ? {} : { reason: response.reason }),
          ...(signature === undefined ? {} : { signature }),
        },
      };
    }
    return {
      errorText: stringifyValue(result.output),
      input: call.input,
      state: "output-error",
      toolCallId: call.toolCallId,
      type,
      ...meta,
    };
  }

  if (request && response?.approved) {
    return {
      input: call.input,
      output: result.output,
      state: "output-available",
      toolCallId: call.toolCallId,
      type,
      ...meta,
      approval: {
        approved: true,
        id: request.approvalId,
        ...(response.reason === undefined ? {} : { reason: response.reason }),
        ...(signature === undefined ? {} : { signature }),
      },
    };
  }
  return {
    input: call.input,
    output: result.output,
    state: "output-available",
    toolCallId: call.toolCallId,
    type,
    ...meta,
  };
}

/** A malformed, duplicate, or mismatched approval response — rejected before
 *  it's appended to history, and therefore before any tool can execute. */
export class InvalidApprovalResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidApprovalResponseError";
  }
}

/**
 * Validate a `tool_approval_response` against the session's existing
 * (pre-append) history: it must resolve a real, still-pending request, and
 * must not already have a response or an executed result. Throws
 * {@link InvalidApprovalResponseError} on any violation.
 */
export function validateApprovalResponse(
  history: SessionMessage[],
  response: ApprovalResponsePart
): void {
  let request: ApprovalRequestPart | undefined;
  let hasExistingResponse = false;
  for (const m of history) {
    for (const p of m.parts) {
      if (
        p.type === "tool_approval_request" &&
        p.approvalId === response.approvalId
      ) {
        request = p;
      }
      if (
        p.type === "tool_approval_response" &&
        p.approvalId === response.approvalId
      ) {
        hasExistingResponse = true;
      }
    }
  }

  if (!request) {
    throw new InvalidApprovalResponseError(
      `No pending approval request for approvalId "${response.approvalId}"`
    );
  }
  if (hasExistingResponse) {
    throw new InvalidApprovalResponseError(
      `Approval "${response.approvalId}" already has a response`
    );
  }

  const alreadyExecuted = history.some((m) =>
    m.parts.some(
      (p) => p.type === "tool_result" && p.toolCallId === request.toolCallId
    )
  );
  if (alreadyExecuted) {
    throw new InvalidApprovalResponseError(
      `Tool call "${request.toolCallId}" already executed`
    );
  }
}
