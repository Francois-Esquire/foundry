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

export interface AgentApprovalRequest {
  activityId?: string;
  agentGeneration?: number;
  agentId?: string;
  approvalId: string;
  capability: Capability;
  input: unknown;
  signature?: string;
  toolCallId: string;
  toolName: string;
}

export interface AgentApprovalResponse {
  approvalId: string;
  approved: boolean;
  reason?: string;
  scope?: "once" | "always";
}

export type SessionTurnOutcome = "complete" | "awaiting-approval" | "failed";

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
      preliminary?: boolean;
    }
  | ({ type: "tool-approval-request" } & AgentApprovalRequest)
  | { type: "error"; error: Error }
  | { type: "finish"; message: SessionMessage; usage: SessionUsage };

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

export type SessionInput = string | { parts: SessionPart[] };

export interface SessionStream<OUTPUT extends Output.Output = never>
  extends AsyncIterable<SessionEvent> {
  readonly message: Promise<SessionMessage>;
  readonly outcome: Promise<SessionTurnOutcome>;
  readonly output: Promise<InferGenerateOutput<OUTPUT>>;
  readonly partialOutputStream: AsyncIterable<InferStreamOutput<OUTPUT>>;
  readonly result: Promise<
    StreamTextResult<ToolSet, Record<string, unknown>, OUTPUT> | undefined
  >;
  readonly text: Promise<string>;
  readonly usage: Promise<SessionUsage>;
}
