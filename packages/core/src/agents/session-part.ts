import type { HarnessActivityEvent, HarnessToolEvent } from "./activity";
import type { Capability, ToolSource } from "./capability";

export type ToolEffectLocation = "runtime" | "host" | "executor";

export interface ToolProvenance {
  readonly agentGeneration?: number;
  readonly agentId?: string;
  readonly capability?: Capability;
  readonly effectLocation: ToolEffectLocation;
  readonly invocationId: string;
  readonly nativeId?: string;
  readonly parentToolCallId?: string;
  readonly serverId?: string;
  readonly sessionId?: string;
  readonly skillName?: string;
  readonly source: ToolSource | "external";
}

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

export type SessionPart =
  | {
      event: HarnessActivityEvent;
      type: "harness_activity";
    }
  | {
      activityId?: string;
      answerCount?: number;
      harness: string;
      outcome: "requested" | "answered" | "declined" | "interrupted";
      questionCount: number;
      toolCallId: string;
      type: "harness_question";
    }
  | {
      event: HarnessToolEvent;
      type: "harness_tool";
    }
  | {
      harness: string;
      nativeSessionId: string;
      type: "harness_session";
    }
  | {
      text: string;
      type: "text";
    }
  | {
      text: string;
      type: "reasoning";
    }
  | {
      mediaType?: string;
      type: "image";
      url: string;
    }
  | {
      input?: unknown;
      name: string;
      provenance?: ToolProvenance;
      providerOptions?: Record<string, Record<string, unknown>>;
      toolCallId: string;
      type: "tool_call";
    }
  | {
      isError?: boolean;
      output?: unknown;
      toolCallId: string;
      type: "tool_result";
    }
  | {
      message: string;
      type: "error";
    }
  | {
      activityId?: string;
      agentGeneration?: number;
      agentId?: string;
      approvalId: string;
      approvalMode?: "live" | "deferred";
      capability: Capability;
      input?: unknown;
      name: string;
      signature?: string;
      toolCallId: string;
      type: "tool_approval_request";
    }
  | {
      approvalId: string;
      approved: boolean;
      granted?: boolean;
      reason?: string;
      scope?: "once" | "always";
      type: "tool_approval_response";
    };

export type SessionInput = string | { parts: SessionPart[] };
