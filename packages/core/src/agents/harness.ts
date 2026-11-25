import type { Output, TextStreamPart, ToolSet } from "ai";
import type { Capability, ToolSource } from "./capability";

export type ToolEffectLocation = "runtime" | "host" | "executor";

export interface HarnessActivity {
  actions?: readonly "stop"[];
  id: string;
  kind: "subagent" | "task" | "watch" | "schedule";
  lifetime: "session" | "sandbox";
  nativeId?: string;
  parentId?: string;
  status:
    | "running"
    | "waiting"
    | "complete"
    | "failed"
    | "cancelled"
    | "unknown";
  summary?: string;
  title: string;
}

export interface HarnessActivityEvent extends HarnessActivity {
  agentId: string;
  harness: string;
  revision: number;
  sessionId: string;
}

export interface HarnessToolEvent {
  activityId?: string;
  agentId: string;
  harness: string;
  inputSummary: string;
  outcome: "started" | "ran" | "refused" | "failed";
  reason?: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
}

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

export interface HarnessPermissionProfile {
  allowedTools: readonly string[];
  disallowedTools: readonly string[];
  maxSteps: number;
  mode: "scheduled" | "attended";
  unresolved: "ask" | "deny";
}

export function validateHarnessProfile(
  profile: Pick<HarnessPermissionProfile, "maxSteps">
): void {
  if (!Number.isSafeInteger(profile.maxSteps) || profile.maxSteps < 1) {
    throw new Error("Harness maxSteps must be a positive safe integer.");
  }
}

export interface HarnessPermissionRequest {
  activityId?: string;
  capability?: Capability;
  input: unknown;
  sessionId: string;
  signal: AbortSignal;
  source?: ToolSource;
  suggestions?: unknown;
  title?: string;
  toolCallId: string;
  toolName: string;
}

export type HarnessPermissionResult =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny"; message: string };

export type HarnessPermissionCallback = (
  request: HarnessPermissionRequest
) => Promise<HarnessPermissionResult>;

export interface HarnessQuestion {
  header?: string;
  id: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string }[];
  question: string;
}

export interface HarnessQuestionRequest {
  activityId?: string;
  questions: HarnessQuestion[];
  sessionId: string;
  signal: AbortSignal;
  toolCallId: string;
}

export type HarnessQuestionResult =
  | { outcome: "answered"; answers: Record<string, string[]> }
  | { outcome: "declined"; reason: string };

export type HarnessQuestionCallback = (
  request: HarnessQuestionRequest
) => Promise<HarnessQuestionResult>;

export interface HarnessCapabilities {
  interruption: boolean;
  steering: boolean;
}

export type HarnessResponseFormat = Extract<
  Awaited<Output.Output["responseFormat"]>,
  { type: "json" }
>;

type SdkStreamPart = TextStreamPart<ToolSet>;

type RegisteredToolCallPart = Extract<SdkStreamPart, { type: "tool-call" }> & {
  provenance?: ToolProvenance;
};

type RegisteredApprovalRequestPart = Extract<
  SdkStreamPart,
  { type: "tool-approval-request" }
> &
  Partial<
    Pick<AgentApprovalRequest, "agentGeneration" | "agentId" | "capability">
  >;

export type HarnessStreamPart =
  | { type: "harness-activity"; event: HarnessActivityEvent }
  | { type: "harness-tool"; event: HarnessToolEvent }
  | ({ type: "harness-approval-request" } & AgentApprovalRequest);

export type StreamPart =
  | Exclude<SdkStreamPart, { type: "tool-call" | "tool-approval-request" }>
  | RegisteredToolCallPart
  | RegisteredApprovalRequestPart
  | HarnessStreamPart;

export interface HarnessTurnDriver {
  capabilities: HarnessCapabilities;
  close?: () => Promise<void>;
  id: string;
  interrupt?: () => Promise<void>;
  run(options: {
    input: SessionInput;
    sessionId: string;
    nativeSessionId?: string;
    signal: AbortSignal;
    profile: HarnessPermissionProfile;
    permission: HarnessPermissionCallback;
    question: HarnessQuestionCallback;
    tools?: ToolSet;
    onActivity: (activity: HarnessActivity) => Promise<void>;
    onToolEvent: (event: HarnessToolEvent) => Promise<void>;
    onSessionId: (nativeSessionId: string) => Promise<void>;
    responseFormat?: HarnessResponseFormat;
  }): Promise<AsyncIterable<StreamPart>>;
  steer?: (input: string) => Promise<void>;
  stopActivity?: (id: string) => Promise<void>;
}
