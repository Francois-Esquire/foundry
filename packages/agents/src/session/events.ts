import type {
  InferGenerateOutput,
  InferStreamOutput,
  Output,
  StreamTextResult,
  ToolSet,
} from "ai";

import type { Capability } from "../authorization/capability";
import type {
  HarnessActivityEvent,
  HarnessToolEvent,
} from "../harness/turn-driver";
import type {
  SessionMessage,
  SessionPart,
  SessionUsage,
  ToolProvenance,
} from "./types";

/**
 * The published agent/session approval checkpoint (design's "Approval
 * checkpoint" section) — the fixed public vocabulary for a pending human
 * decision on a tool call. Distinct from `SessionPart`'s
 * `tool_approval_request` (the persisted, storage-shaped twin, which uses
 * `name` to match its `tool_call` sibling): this is what a stream/host caller
 * observes.
 */
export interface AgentApprovalRequest {
  activityId?: string;
  agentGeneration?: number;
  /**
   * The agent preset that asked, and its generation. A host resolving this
   * approval writes the resulting Grant to that Subject's address — without
   * them an "always" answer would land on whichever agent happened to be
   * running when the human clicked, which is how one preset inherits another's
   * authority. Optional because a stream chunk whose capability could not be
   * re-derived carries neither.
   */
  agentId?: string;
  approvalId: string;
  capability: Capability;
  input: unknown;
  signature?: string;
  toolCallId: string;
  toolName: string;
}

/** The human's resolution for an {@link AgentApprovalRequest}. */
export interface AgentApprovalResponse {
  approvalId: string;
  approved: boolean;
  reason?: string;
  scope?: "once" | "always";
}

/**
 * Whether a turn's assembled message is done, or stopped at an unresolved
 * approval checkpoint. A `"awaiting-approval"` message is still a complete
 * Session message (see {@link SessionMessage.status}) — the outcome tells a
 * caller (e.g. a workflow execution adapter) whether it can treat the turn as
 * finished or must resolve a pending checkpoint before continuing.
 */
export type SessionTurnOutcome = "complete" | "awaiting-approval";

/**
 * The streamed event union. Deliberately not named after a "turn" — these are
 * the things that come in as a generation runs, mapped from the model's stream
 * into this package's own vocabulary.
 */
export type SessionEvent =
  | { type: "harness-activity"; event: HarnessActivityEvent }
  | { type: "harness-tool"; event: HarnessToolEvent }
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
  | {
      type: "tool-call";
      toolCallId: string;
      name: string;
      input: unknown;
      provenance?: ToolProvenance;
    }
  | {
      type: "tool-result";
      toolCallId: string;
      output: unknown;
      isError?: boolean;
      /** An interim result from a streaming (generator) tool; the call is still running. */
      preliminary?: boolean;
    }
  | ({ type: "tool-approval-request" } & AgentApprovalRequest)
  | { type: "error"; error: Error }
  | { type: "finish"; message: SessionMessage; usage: SessionUsage };

/**
 * Granular lifecycle taps, fired as each event comes in. These are the seam
 * for observability/auditing and for a wrapper to react (e.g. persist on
 * finish) — separate from, and complementary to, the session's own store.
 */
export interface StreamHandlers {
  onApprovalRequest?: (event: AgentApprovalRequest) => void;
  onError?: (error: Error) => void;
  onFinish?: (event: { message: SessionMessage; usage: SessionUsage }) => void;
  onHarnessActivity?: (event: HarnessActivityEvent) => void;
  onHarnessTool?: (event: HarnessToolEvent) => void;
  onReasoning?: (delta: string) => void;
  onText?: (delta: string) => void;
  onToolCall?: (event: {
    toolCallId: string;
    name: string;
    input: unknown;
    provenance?: ToolProvenance;
  }) => void;
  onToolResult?: (event: {
    toolCallId: string;
    output: unknown;
    isError?: boolean;
    preliminary?: boolean;
  }) => void;
}

/** What a generation is given: a string for convenience, or explicit parts. */
export type SessionInput = string | { parts: SessionPart[] };

/**
 * The handle returned by `stream()`. Async-iterable over {@link SessionEvent}s,
 * with the finals exposed directly so a caller can iterate, tap handlers, or
 * just await the result — any combination.
 */
export interface SessionStream<OUTPUT extends Output.Output = never>
  extends AsyncIterable<SessionEvent> {
  readonly message: Promise<SessionMessage>;
  readonly outcome: Promise<SessionTurnOutcome>;
  /**
   * The turn's structured value, parsed from its final text by the turn's
   * `output`. Rejects when the turn had an `output` and produced no valid
   * value, after the message is committed; resolves `undefined` without one.
   */
  readonly output: Promise<InferGenerateOutput<OUTPUT>>;
  /**
   * The structured value as it streams, one partial per change. Empty
   * without an `output`. One consumer.
   */
  readonly partialOutputStream: AsyncIterable<InferStreamOutput<OUTPUT>>;
  /**
   * The AI SDK result of the turn's model call, for what the session does
   * not carry. `undefined` for a CLI harness, which runs its own loop.
   */
  readonly result: Promise<
    StreamTextResult<ToolSet, Record<string, unknown>, OUTPUT> | undefined
  >;
  readonly text: Promise<string>;
  readonly usage: Promise<SessionUsage>;
}
